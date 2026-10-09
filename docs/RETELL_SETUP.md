# Retell AI setup and call-recording submission

This guide connects the local deterministic qualification engine to a Retell **Conversation Flow** custom function. Retell is an external platform: this project cannot create your account, select a real phone number, call a real customer, enable recording consent, or publish a recording URL.

Retell documentation referenced for this guide:

- [Custom functions in conversation flows](https://docs.retellai.com/build/conversation-flow/custom-function)
- [Function nodes](https://docs.retellai.com/build/conversation-flow/function-node)
- [Conversation nodes](https://docs.retellai.com/build/conversation-flow/conversation-node)
- [Transition conditions](https://docs.retellai.com/build/conversation-flow/transition-condition)
- [Dynamic variables](https://docs.retellai.com/build/dynamic-variables)
- [End node](https://docs.retellai.com/build/conversation-flow/end-node)

Retell's UI and plan requirements can change. Verify the current UI and account capabilities before placing a live call.

## Architecture and limits

Retell handles telephony, ASR/TTS, and the visual flow. Its custom function calls the project's `POST /api/retell/advance` endpoint. That endpoint evaluates each latest customer utterance with the deterministic state machine and returns a `say`, `action`, `status`, and structured checklist. The flow speaks the returned `say`, loops only while `status` is `active`, and ends after any terminal outcome.

The included adapter is a runnable local/demo reference, not a hosted multi-tenant production service. It stores active state in a process-local `Map`, expires sessions after eight hours when next accessed, and clears state on restart; it has no durable/shared database, call scheduling, CRM integration, rate limiting, audit log, or production monitoring. For real customer calls, deploy the adapter behind HTTPS, set a strong bearer token, add Retell's official `X-Retell-Signature` verification with the API key/Retell SDK, restrict ingress, and replace the in-memory map with a protected durable store with a retention/deletion policy. Do not expose the unauthenticated demo endpoint: it requires `RETELL_WEBHOOK_TOKEN` when deployed.

The route supports Retell's standard wrapped request (`call` and `args`) and its flat args-only form. For standard wrapped calls it obtains the newest `user` turn from `call.transcript_object` instead of trusting a paraphrased LLM argument. It also accepts `call.retell_llm_dynamic_variables` as runtime context. Never send real customer PII through a public development tunnel.

## 1. Run and test locally

In PowerShell from the project directory:

```powershell
npm test
npm start
```

Check `http://127.0.0.1:3000/api/health` returns `{"ok":true,...}`. The demo itself is at `http://127.0.0.1:3000`.

Retell cannot call a localhost/private address. If you want to test the connector against this machine, use an approved HTTPS tunnel only with synthetic data. Example environment variables for a separate PowerShell terminal:

```powershell
$env:PORT = "3000"
$env:RETELL_WEBHOOK_TOKEN = "replace-this-with-a-long-random-secret"
npm start
```

The server binds to `127.0.0.1`; use a tunnel that forwards to that local port. A public development tunnel exposes an endpoint on the internet, so use a throwaway token, synthetic test data, and stop the tunnel immediately afterward. Do not commit secrets or put them in the prompt. For an actual rollout, deploy to a managed HTTPS host instead and use its secrets manager.

## 2. Create the Retell agent

1. Sign in to **your own** Retell account and create a new **Conversation Flow** agent for voice.
2. Select a professional voice that supports the chosen call language. Set the matching speech-recognition/transcription language and timezone.
3. Open [`SYSTEM_PROMPT.md`](SYSTEM_PROMPT.md) and paste the system prompt into the flow's global instructions. Keep `{{language_to_speak}}` consistent with the configured voice/transcription model; enable only English/Hindi languages you have actually tested.
4. Create the dynamic variables listed at the bottom of the prompt. Supply `customer_name`, `company_name`, `agent_name`, `agent_gender`, `current_date`, `current_day`, `current_time`, `additional_context_from_rag`, `language_to_speak`, and `conversation_history` on your **authorized** outbound call request or in agent defaults. Supply strings as Retell's dynamic-variable documentation requires. Do not store secrets or bank/customer financial records in RAG context.
5. Use real approved call recipients only after the required legal/compliance review. Configure the platform's real recording disclosure and obtain required consent before recording or publicly sharing anything.

## 3. Add the custom function

Create a custom function with these settings:

| Setting | Value |
|---|---|
| Name | `advance_lap_qualification` |
| Description | `Evaluate exactly one latest customer utterance in the Home Credit LAP qualification state machine. Call on each user turn; do not paraphrase the transcript. The response's say, status, action, and fields are authoritative.` |
| HTTP method | `POST` |
| URL | `https://YOUR-APP-HOST/api/retell/advance` (or the temporary HTTPS tunnel URL) |
| Timeout | 10,000 ms |
| Max retries | 0 |
| Payload: args only | **Off** — the endpoint needs Retell's wrapped `call` object and its actual transcript |
| Header | `Authorization: Bearer YOUR_RETELL_WEBHOOK_TOKEN` |

In **Parameters**, set a required call ID constant (Retell supplies the active call ID; the server gets the latest utterance from the wrapped call transcript):

```json
{
  "type": "object",
  "required": ["call_id"],
  "properties": {
    "call_id": {
      "type": "string",
      "const": "{{call_id}}"
    }
  }
}
```

Save response variables:

| Retell response variable | JSON path |
|---|---|
| `lap_say` | `say` |
| `lap_status` | `status` |
| `lap_action` | `action` |
| `lap_fields` | `fields` |

The endpoint reads the request's `call.call_id`, `call.transcript_object`, and `call.retell_llm_dynamic_variables`. If your Retell configuration omits the wrapped `call` object, switch it back on rather than relying on an LLM to transcribe the latest utterance into an argument. Do not enable args-only payload for this flow.

## 4. Wire a controlled flow

Create this small loop in the Conversation Flow canvas. Keep contact-memory question skipping **off**; the backend, not Retell memory, owns field completion.

1. **Opening node** — say a short identity-check greeting using `{{customer_name}}`, `{{agent_name}}`, and `{{company_name}}`. Do not mention the offer before identity is confirmed. On the customer's response, transition to `Qualify turn`.
2. **Qualify turn (Function node)** — select `advance_lap_qualification`; enable **Wait for result**; turn **Talk While Waiting** off so no unapproved filler overlaps the result. The function node runs once when entered.
3. Add an **equation transition** from `Qualify turn` for `{{lap_status}} == "active"` to `Speak backend response`. Add an else/fallback edge to `Speak final response`. Use the function response variables; do not use prompt conditions to decide eligibility.
4. **Speak backend response (Conversation node)** — give it a static sentence of `{{lap_say}}` and instruct the node to speak it exactly, without adding questions or claims. On the next customer turn, route back to `Qualify turn`. Do not enable memory to skip this node or checklist logic.
5. **Speak final response (Conversation node)** — say only `{{lap_say}}`, then use Skip Response / a single unconditional edge to the **End** node. Do not add an actual live loan transfer: the response tells the customer the appropriate specialist will follow up, it does not transfer this call.
6. **End node** — end the call. Check that qualified, callback, transfer-specialist, refusal, wrong-person, and ineligible results all reach this node, and that no terminal route loops back to qualification.

Retell node labels and controls may evolve; the essential invariants are: function runs on **every** user turn, waits for the result, active state loops, non-active state speaks one terminal response and hangs up, and no LLM condition independently decides eligibility. Test a full dialogue in Retell's simulator before any telephone call; inspect node transitions and custom-function requests.

## 5. Smoke-test the adapter

After setting the token and starting the server, send a **synthetic** Retell-shaped wrapped request from PowerShell:

```powershell
$headers = @{ Authorization = "Bearer $env:RETELL_WEBHOOK_TOKEN" }
$body = @{
  name = "advance_lap_qualification"
  args = @{}
  call = @{
    call_id = "synthetic-test-001"
    retell_llm_dynamic_variables = @{
      company_name = "Home Credit"
      customer_name = "Priya Sharma"
      agent_name = "Mira"
      agent_gender = "female"
      language_to_speak = "English"
    }
    transcript_object = @(
      @{ role = "agent"; content = "May I speak with Priya Sharma?" },
      @{ role = "user"; content = "Yes, this is Priya Sharma." }
    )
  }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/retell/advance `
  -Headers $headers -ContentType "application/json" -Body $body
```

The first returned action should be `present_offer`; the same synthetic `call_id` must be used on each subsequent turn. The server uses only in-memory state and should not print utterances. The authorization token is required when `RETELL_WEBHOOK_TOKEN` is set. This simple bearer check is not a replacement for verifying Retell's signed webhook/custom-function request: add the official Retell SDK signature check against the raw request body before production use.

## 6. Record the real demonstration and submit it

Only you can perform these account-bound steps; they have intentionally **not** been fabricated:

1. In your Retell account, run and inspect multiple scenarios: an eligible qualification (including out-of-order details), agricultural property, missing original documents, cash income, under/over-range tenure, over-₹75-lakh acceptance and refusal, wrong person, callback, explicit refusal, correction, and existing-loan/EMI-transfer routing.
2. If recording is required, enable Retell's real recording/consent notice for the relevant call, obtain the legally required participant consent, and place a call only to a number you are authorized to contact. For a no-phone-number exercise, use a Retell web/simulation call only if the assignment accepts that format.
3. Open the genuine Retell call detail page and verify the audio and transcript exist and match the test. Redact/delete sensitive data in line with policy; never post a customer's phone, financial/property identifiers, or other PII publicly.
4. Use Retell's current supported sharing/export controls to create the requested **public** recording/log URL, if public sharing is permitted. Test the link in a private/incognito browser and confirm it exposes only the intended synthetic/consented demo. If Retell does not provide a public link, ask the assignment owner for an approved alternative—do not mirror a private customer recording to an unapproved host.
5. Submit the prompt from [`SYSTEM_PROMPT.md`](SYSTEM_PROMPT.md) together with the real public recording and log links. Add those links yourself after creation; this project does not contain or claim a real call, recording, public link, or Retell account.

## Security and operations checklist

- The default server binds to localhost and the Retell route is intentionally a demo adapter. Never publish it without HTTPS, a long random secret in a secret manager, request signature verification, firewall/rate limits, and monitoring.
- The example endpoint uses process-local memory and a maximum of 500 sessions. A restart loses active state; multiple workers do not share state. Move state to a protected shared database before a real campaign.
- Limit logs and retention. The demo does not log utterances or persist them; production logs should avoid PII and implement retention/deletion controls.
- Do not send bank credentials/account numbers, OTPs, Aadhaar/PAN, documents, or account balances into this qualification workflow.
- A custom-function failure, stale status, malformed response, or parser uncertainty must not become a success/qualified response. Keep the human review path available.
- Configure real consent, do-not-call handling, call timing, outbound eligibility, and applicable local regulatory requirements before contact.
