"use strict";

const FIELD_DEFINITIONS = [
  ["property_type", "Property type"],
  ["ownership", "Ownership"],
  ["original_documents", "Original documents"],
  ["requested_amount_inr", "Loan amount"],
  ["occupation_income", "Occupation & income"],
  ["property_market_value_inr", "Property market value"],
  ["tenure_years", "Repayment tenure"],
];

let sessionId = null;
let sessionState = null;
let busy = false;
let toastTimer;

const elements = {
  start: document.querySelector("#start-button"),
  reset: document.querySelector("#reset-button"),
  form: document.querySelector("#turn-form"),
  utterance: document.querySelector("#utterance"),
  send: document.querySelector("#send-button"),
  transcript: document.querySelector("#transcript"),
  fields: document.querySelector("#field-list"),
  status: document.querySelector("#call-status"),
  progress: document.querySelector("#progress-count"),
  progressBar: document.querySelector("#progress-bar"),
  scenario: document.querySelector("#scenario-select"),
  toast: document.querySelector("#toast"),
};

function variablesFromForm() {
  const variables = {
    company_name: document.querySelector("#company-name").value.trim(),
    customer_name: document.querySelector("#customer-name").value.trim(),
    agent_name: document.querySelector("#agent-name").value.trim(),
    agent_gender: document.querySelector("#agent-gender").value,
    language_to_speak: document.querySelector("#language").value,
    current_date: document.querySelector("#current-date").value.trim(),
    current_day: document.querySelector("#current-day").value.trim(),
    current_time: document.querySelector("#current-time").value.trim(),
    additional_context_from_rag: document.querySelector("#rag-context").value.trim(),
    conversation_history: document.querySelector("#history-context").value.trim(),
  };
  return variables;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function setBusy(value) {
  busy = value;
  elements.start.disabled = value || Boolean(sessionId);
  elements.send.disabled = value || !sessionId || sessionState?.status !== "active";
  elements.utterance.disabled = value || !sessionId || sessionState?.status !== "active";
  elements.reset.disabled = value;
}

function setStatus(result) {
  const label = result.status === "qualified" ? "QUALIFIED" :
    result.status === "callback_requested" ? "CALLBACK SET" :
      result.status === "transfer_referred" ? "SPECIALIST HANDOFF" :
        result.status === "active" ? "CALL IN PROGRESS" : "CALL ENDED";
  elements.status.innerHTML = `<i></i> ${label}`;
  elements.status.className = `call-status ${result.status === "active" ? "live" : "ended"}`;
}

function addMessage(speaker, message) {
  if (elements.transcript.querySelector(".empty-state")) elements.transcript.replaceChildren();
  const article = document.createElement("article");
  article.className = `message ${speaker}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = speaker === "agent" ? "AI" : "P";
  const content = document.createElement("div");
  content.className = "message-content";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = speaker === "agent" ? "VOICE AGENT" : "CUSTOMER";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = message;
  content.append(meta, bubble);
  article.append(avatar, content);
  elements.transcript.append(article);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
}

function formatValue(key, fields) {
  const value = fields[key];
  if (key === "original_documents") return value === null ? null : value ? "Available" : "Not available";
  if (key === "requested_amount_inr" || key === "property_market_value_inr") {
    return value === null ? null : `₹${Number(value).toLocaleString("en-IN")}`;
  }
  if (key === "occupation_income") {
    const parts = [];
    if (value.occupation) parts.push(value.occupation === "self_employed" ? "Self-employed" : value.occupation === "salaried" ? "Salaried" : "Other");
    if (value.income_mode) parts.push(`${value.income_mode === "bank" ? "Bank" : "Cash"} income`);
    return parts.length ? parts.join(" · ") : null;
  }
  if (key === "tenure_years") return value === null ? null : `${value} years`;
  if (!value) return null;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderFields(result) {
  const completed = FIELD_DEFINITIONS.filter(([key]) => {
    if (key === "occupation_income") return Boolean(result.fields.occupation_income.occupation && result.fields.occupation_income.income_mode);
    return result.fields[key] !== null;
  }).length;
  elements.progress.textContent = `${completed} / 7`;
  elements.progressBar.style.width = `${(completed / 7) * 100}%`;
  elements.fields.replaceChildren();
  for (const [key, label] of FIELD_DEFINITIONS) {
    const row = document.createElement("div");
    const complete = key === "occupation_income"
      ? Boolean(result.fields.occupation_income.occupation && result.fields.occupation_income.income_mode)
      : result.fields[key] !== null;
    row.className = `field-row ${complete ? "done" : key === result.next_field ? "active" : "pending"}`;
    const check = document.createElement("span");
    check.className = "field-check";
    check.textContent = complete ? "✓" : key === result.next_field ? "•" : "";
    const body = document.createElement("div");
    body.className = "field-text";
    const title = document.createElement("div");
    title.className = "field-label";
    title.textContent = label;
    body.append(title);
    const value = formatValue(key, result.fields);
    if (value) {
      const detail = document.createElement("div");
      detail.className = "field-value";
      detail.textContent = value;
      body.append(detail);
    }
    row.append(check, body);
    elements.fields.append(row);
  }
  setStatus(result);
  sessionState = result;
  setBusy(busy);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3000);
}

async function startSession() {
  if (busy || sessionId) return;
  setBusy(true);
  try {
    const result = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ variables: variablesFromForm() }),
    });
    sessionId = result.session_id;
    sessionState = result;
    addMessage("agent", result.say);
    renderFields(result);
    elements.utterance.focus();
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function sendTurn(message) {
  if (!sessionId || busy || !message.trim() || sessionState?.status !== "active") return;
  const utterance = message.trim();
  elements.utterance.value = "";
  elements.scenario.value = "";
  addMessage("customer", utterance);
  setBusy(true);
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
      method: "POST",
      body: JSON.stringify({ customer_utterance: utterance }),
    });
    addMessage("agent", result.say);
    renderFields(result);
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
    if (sessionState?.status === "active") elements.utterance.focus();
  }
}

async function reset() {
  if (busy) return;
  if (sessionId) {
    setBusy(true);
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    } catch (error) {
      showToast(`The local view was reset, but the server session could not be cleared: ${error.message}`);
    }
  }
  sessionId = null;
  sessionState = null;
  elements.transcript.innerHTML = `<div class="empty-state"><div class="empty-orb">◌</div><strong>Your call is ready when you are</strong><p>Set the customer details above, then start a test call to begin the identity check.</p></div>`;
  elements.fields.replaceChildren();
  elements.progress.textContent = "0 / 7";
  elements.progressBar.style.width = "0%";
  elements.status.innerHTML = "<i></i> NOT STARTED";
  elements.status.className = "call-status";
  elements.utterance.value = "";
  setBusy(false);
}

elements.start.addEventListener("click", startSession);
elements.reset.addEventListener("click", reset);
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendTurn(elements.utterance.value);
});
elements.scenario.addEventListener("change", () => {
  if (elements.scenario.value && sessionId) sendTurn(elements.scenario.value);
  else if (elements.scenario.value) {
    elements.utterance.value = elements.scenario.value;
    showToast("Start the test call before sending a customer response.");
  }
});
setBusy(false);
