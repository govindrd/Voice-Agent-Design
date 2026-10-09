"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
  createSession,
  processTurn,
} = require("./src/conversation");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;
const sessions = new Map();
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body exceeds 1 MB."), { statusCode: 413 }));
        request.destroy();
        return;
      }
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function pruneSessions() {
  const expiry = Date.now() - SESSION_TTL_MS;
  for (const [id, state] of sessions) {
    if (Date.parse(state.updated_at) < expiry) sessions.delete(id);
  }
}

function makeSession(variables) {
  pruneSessions();
  if (sessions.size >= MAX_SESSIONS) {
    throw Object.assign(new Error("The local demo has reached its session limit. Restart the server to clear in-memory sessions."), { statusCode: 503 });
  }
  const created = createSession(variables);
  const id = crypto.randomUUID();
  created.state.session_id = id;
  created.state.transcript.push({ speaker: "agent", text: created.say });
  sessions.set(id, created.state);
  return {
    session_id: id,
    say: created.say,
    action: created.action,
    phase: created.state.phase,
    status: created.state.status,
    fields: created.state.fields,
    next_field: created.state.next_field,
    callback_time: created.state.callback_time,
  };
}

function checkRetellAuthorization(request) {
  const token = process.env.RETELL_WEBHOOK_TOKEN;
  if (!token) return;
  const authorization = request.headers.authorization || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    throw Object.assign(new Error("Invalid Retell webhook authorization."), { statusCode: 401 });
  }
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, { ok: true, service: "home-credit-lap-demo" });
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(request);
    return sendJson(response, 201, makeSession(body.variables || {}));
  }

  if (request.method === "POST" && url.pathname === "/api/retell/advance") {
    checkRetellAuthorization(request);
    const body = await readJson(request);
    const args = body.args && typeof body.args === "object" ? body.args : body;
    const call = body.call && typeof body.call === "object" ? body.call : {};
    const callId = String(args.call_id || call.call_id || "").trim();
    const transcriptTurn = Array.isArray(call.transcript_object)
      ? [...call.transcript_object].reverse().find((entry) => entry && entry.role === "user" && typeof entry.content === "string")
      : null;
    const utterance = String(transcriptTurn?.content || args.customer_utterance || args.utterance || "").trim();
    if (!callId || callId.length > 160) throw Object.assign(new Error("call_id is required and must be 160 characters or fewer."), { statusCode: 400 });
    if (!utterance) throw Object.assign(new Error("customer_utterance is required."), { statusCode: 400 });
    const id = `retell:${callId}`;
    let state = sessions.get(id);
    if (!state) {
      pruneSessions();
      if (sessions.size >= MAX_SESSIONS) throw Object.assign(new Error("The local demo has reached its session limit."), { statusCode: 503 });
      state = createSession(call.retell_llm_dynamic_variables || args.variables || {}).state;
      state.session_id = id;
      sessions.set(id, state);
    }
    return sendJson(response, 200, processTurn(state, utterance));
  }

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/turn)?$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (request.method === "DELETE" && !url.pathname.endsWith("/turn")) {
      const removed = sessions.delete(id);
      return sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: "Session not found or expired." });
    }
    const state = sessions.get(id);
    if (!state) return sendJson(response, 404, { error: "Session not found or expired." });
    if (request.method === "GET" && !url.pathname.endsWith("/turn")) {
      return sendJson(response, 200, {
        session_id: id,
        phase: state.phase,
        status: state.status,
        fields: state.fields,
        next_field: state.next_field,
        callback_time: state.callback_time,
        transcript: state.transcript,
        variables: state.variables,
      });
    }
    if (request.method === "POST" && url.pathname.endsWith("/turn")) {
      const body = await readJson(request);
      if (typeof body.customer_utterance !== "string" || !body.customer_utterance.trim()) {
        throw Object.assign(new Error("customer_utterance is required."), { statusCode: 400 });
      }
      return sendJson(response, 200, processTurn(state, body.customer_utterance));
    }
  }
  return sendJson(response, 404, { error: "Route not found." });
}

function serveStatic(response, pathname) {
  const files = {
    "/": path.join(ROOT, "public", "index.html"),
    "/index.html": path.join(ROOT, "public", "index.html"),
    "/app.js": path.join(ROOT, "public", "app.js"),
    "/styles.css": path.join(ROOT, "public", "styles.css"),
  };
  const file = files[pathname];
  if (!file) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return response.end("Not found");
  }
  fs.readFile(file, (error, content) => {
    if (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      return response.end("Unable to load the demo interface.");
    }
    response.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(file)],
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      return response.end("Method not allowed.");
    }
    serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.statusCode ? error.message : "The request could not be completed.",
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Home Credit LAP demo: http://127.0.0.1:${PORT}`);
  if (!process.env.RETELL_WEBHOOK_TOKEN) {
    console.log("Retell adapter is demo-only until RETELL_WEBHOOK_TOKEN is set.");
  }
});
