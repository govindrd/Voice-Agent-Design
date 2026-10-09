"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_LOAN_INR,
  createSession,
  extractDetails,
  processTurn,
} = require("../src/conversation");

function prepare(language = "English") {
  const created = createSession({
    company_name: "Home Credit",
    customer_name: "Priya Sharma",
    agent_name: "Mira",
    agent_gender: "female",
    language_to_speak: language,
  });
  const state = created.state;
  const verified = processTurn(state, language === "Hindi" ? "हाँ, मैं प्रिय शर्मा बोल रही हूँ।" : "Yes, this is Priya Sharma speaking.");
  assert.equal(verified.action, "present_offer");
  return state;
}

function proceed(state) {
  const result = processTurn(state, "Yes, please continue.");
  assert.equal(result.action, "ask_eligibility");
  return result;
}

test("verifies identity, asks sequentially, then hands off only after all seven eligible answers", () => {
  const state = prepare();
  let result = proceed(state);
  assert.equal(result.next_field, "property_type");
  result = processTurn(state, "A residential house, jointly owned. The original documents are ready. I need 50 lakhs. I am self-employed, with income credited to my bank. The property is worth 1 crore, and I prefer 10 years.");
  assert.equal(result.action, "qualified_handoff");
  assert.equal(result.status, "qualified");
  assert.equal(result.fields.property_type, "residential");
  assert.equal(result.fields.ownership, "joint");
  assert.equal(result.fields.original_documents, true);
  assert.equal(result.fields.requested_amount_inr, 5_000_000);
  assert.deepEqual(result.fields.occupation_income, { occupation: "self_employed", income_mode: "bank" });
  assert.equal(result.fields.property_market_value_inr, 10_000_000);
  assert.equal(result.fields.tenure_years, 10);
  assert.match(result.say, /senior loan expert/i);
  assert.match(result.say, /not a loan approval/i);
  assert.match(result.say, /exact interest rates/i);
});

test("captures eligible out-of-order details and asks only the earliest missing field", () => {
  const state = prepare();
  proceed(state);
  const result = processTurn(state, "The original documents are available, it is a jointly owned residential property.");
  assert.equal(result.next_field, "requested_amount_inr");
  assert.equal(result.fields.property_type, "residential");
  assert.equal(result.fields.ownership, "joint");
  assert.equal(result.fields.original_documents, true);
  assert.match(result.say, /How much would you like to borrow/);
});

test("an explicit latest correction replaces an earlier eligible or ineligible answer", () => {
  const state = prepare();
  proceed(state);
  let result = processTurn(state, "It's agricultural land—sorry, actually a residential house.");
  assert.equal(result.action, "ask_eligibility");
  assert.equal(result.fields.property_type, "residential");
  result = processTurn(state, "Correction: the property is commercial, not residential.");
  assert.equal(result.fields.property_type, "commercial");
  assert.equal(result.action, "ask_eligibility");
});

test("recognizes the last income-mode correction and does not treat a negated cash mention as disqualifying", () => {
  const result = extractDetails("I am self-employed; my income is not cash, it is credited to my bank.");
  assert.deepEqual(result.values, { occupation: "self_employed", income_mode: "bank" });
  const salaryWord = extractDetails("I am self-employed and my business income is paid as salary into my bank.");
  assert.deepEqual(salaryWord.values, { occupation: "self_employed", income_mode: "bank" });
  assert.deepEqual(extractDetails("My income is not received in cash.").values, {});
});

test("does not mistake volunteered salary data for the requested loan amount or property value", () => {
  const parsed = extractDetails("My monthly salary is ₹50,000, and I need a loan of 50 lakhs.");
  assert.deepEqual(parsed.values, { occupation: "salaried", requested_amount_inr: 5_000_000 });
  const onlyIncome = extractDetails("My salary is ₹50,000 per month.", "requested_amount_inr");
  assert.deepEqual(onlyIncome.values, { occupation: "salaried" });
});

test("assigns separate volunteered loan and property values to the correct fields", () => {
  const parsed = extractDetails("The house is worth 1 crore, and I need 50 lakhs.");
  assert.equal(parsed.values.property_market_value_inr, 10_000_000);
  assert.equal(parsed.values.requested_amount_inr, 5_000_000);
});

test("disqualifies agricultural property immediately, including in the first verified reply", () => {
  const state = createSession({ customer_name: "Priya Sharma" }).state;
  const result = processTurn(state, "Yes, this is Priya Sharma. The property is agricultural land.");
  assert.equal(result.action, "ineligible");
  assert.equal(result.reason, "agricultural_property");
  assert.equal(result.status, "ended");
  assert.match(result.say, /do not meet the criteria/i);
});

test("disqualifies cash income, unavailable originals, and tenure outside 3–15 years", () => {
  for (const [utterance, reason] of [
    ["My income is received in cash.", "cash_income"],
    ["I do not have the original property documents.", "original_documents_unavailable"],
    ["I would prefer a 2-year repayment tenure.", "tenure_out_of_range"],
  ]) {
    const state = prepare();
    proceed(state);
    const result = processTurn(state, utterance);
    assert.equal(result.action, "ineligible", utterance);
    assert.equal(result.reason, reason, utterance);
  }
});

test("asks for the maximum after an over-limit request and continues only after acceptance", () => {
  const state = prepare();
  proceed(state);
  const cap = processTurn(state, "I need 90 lakhs.");
  assert.equal(cap.action, "confirm_amount_cap");
  assert.equal(cap.fields.requested_amount_inr, null);
  assert.equal(state.pending_amount_inr, 9_000_000);
  const accepted = processTurn(state, "Yes, the maximum is fine.");
  assert.equal(accepted.action, "ask_eligibility");
  assert.equal(accepted.fields.requested_amount_inr, MAX_LOAN_INR);
  assert.equal(accepted.next_field, "property_type");
});

test("ends politely when the caller declines the maximum", () => {
  const state = prepare();
  proceed(state);
  processTurn(state, "I need 90 lakhs.");
  const result = processTurn(state, "No, I need more than that.");
  assert.equal(result.action, "declined_maximum");
  assert.equal(result.status, "ended");
});

test("uses a later explicit maximum correction instead of an earlier no", () => {
  const state = prepare();
  proceed(state);
  processTurn(state, "I need 90 lakhs.");
  const result = processTurn(state, "No, wait, 75 lakhs is fine.");
  assert.equal(result.action, "ask_eligibility");
  assert.equal(result.fields.requested_amount_inr, MAX_LOAN_INR);
});

test("ends on an explicit cap refusal even if the caller restates a lower amount", () => {
  const state = prepare();
  proceed(state);
  processTurn(state, "I need 90 lakhs.");
  const declined = processTurn(state, "No, I only need 60 lakhs.");
  assert.equal(declined.action, "declined_maximum");
  const secondState = prepare();
  proceed(secondState);
  processTurn(secondState, "I need 90 lakhs.");
  const secondDecline = processTurn(secondState, "No, 75 lakhs won't work.");
  assert.equal(secondDecline.action, "declined_maximum");
});

test("accepts a later explicit maximum correction instead of an earlier no", () => {
  const state = prepare();
  proceed(state);
  processTurn(state, "I need 90 lakhs.");
  const result = processTurn(state, "No, wait, the maximum works.");
  assert.equal(result.action, "ask_eligibility");
  assert.equal(result.fields.requested_amount_inr, MAX_LOAN_INR);
});

test("routes an existing-property-loan or EMI-reduction intent to the transfer specialist", () => {
  const state = prepare();
  const result = processTurn(state, "I already have a loan on this property and want to reduce my EMI.");
  assert.equal(result.action, "transfer_specialist");
  assert.equal(result.status, "transfer_referred");
  assert.match(result.say, /loan-transfer specialist/);
});

test("does not reveal a transfer route before verifying the named customer", () => {
  const state = createSession({ customer_name: "Priya Sharma" }).state;
  const result = processTurn(state, "I already have an existing property loan.");
  assert.equal(result.action, "verify_identity");
  assert.equal(result.status, "active");
});

test("does not route a clearly negated existing-loan statement to transfer", () => {
  const state = prepare();
  proceed(state);
  const result = processTurn(state, "I do not have an existing loan.");
  assert.equal(result.action, "ask_eligibility");
  const reduction = processTurn(state, "I don't want to reduce my EMI.");
  assert.equal(reduction.action, "ask_eligibility");
});

test("a bare no at identity verification ends without revealing the offer", () => {
  const state = createSession({ customer_name: "Priya Sharma" }).state;
  const result = processTurn(state, "No.");
  assert.equal(result.action, "wrong_person");
  assert.doesNotMatch(result.say, /offer|loan/i);
});

test("recognizes a natural name confirmation and negated busy statement", () => {
  const state = createSession({ customer_name: "Priya Sharma" }).state;
  const confirmed = processTurn(state, "I'm Priya Sharma.");
  assert.equal(confirmed.action, "present_offer");
  const next = processTurn(state, "I'm not busy, let's proceed.");
  assert.equal(next.action, "ask_eligibility");
});

test("handles busy callers by recording an actual preferred callback time", () => {
  const state = createSession({ customer_name: "Priya Sharma" }).state;
  const result = processTurn(state, "I'm in a meeting, call me tomorrow at 10 am.");
  assert.equal(result.action, "callback_requested");
  assert.equal(result.callback_time, "tomorrow at 10 am");
  assert.equal(result.status, "callback_requested");
});

test("asks for callback time if busy caller did not give one", () => {
  const state = createSession({ customer_name: "Priya Sharma" }).state;
  const first = processTurn(state, "I'm busy right now.");
  assert.equal(first.action, "ask_callback_time");
  const second = processTurn(state, "Tomorrow afternoon.");
  assert.equal(second.action, "callback_requested");
  assert.equal(second.callback_time, "Tomorrow afternoon");
});

test("asks a focused clarification rather than guessing an incomplete occupation/income answer", () => {
  const state = prepare();
  proceed(state);
  processTurn(state, "It is a residential house, I am the sole owner, originals are ready, and I need 50 lakhs.");
  const result = processTurn(state, "I work as a salaried employee.");
  assert.equal(result.next_field, "occupation_income");
  assert.match(result.say, /received through a bank or in cash/);
  assert.equal(result.fields.occupation_income.occupation, "salaried");
  assert.equal(result.fields.occupation_income.income_mode, null);
});

test("ends after an explicit refusal and does not re-open a completed call", () => {
  const state = prepare();
  const declined = processTurn(state, "No thanks, I'm not interested.");
  assert.equal(declined.action, "declined");
  const later = processTurn(state, "Actually, I have an existing loan.");
  assert.equal(later.action, "already_ended");
});

test("keeps Hindi responses in the configured gender form and validates the gender variable", () => {
  const created = createSession({
    customer_name: "प्रिय",
    agent_name: "मीरा",
    agent_gender: "female",
    language_to_speak: "Hindi",
  });
  assert.match(created.say, /यह Home Credit की ओर से कॉल है/);
  assert.doesNotMatch(created.say, /बोल रहा\/रही/);
  const result = processTurn(created.state, "मैं व्यस्त हूँ।");
  assert.equal(result.action, "ask_callback_time");
  assert.doesNotMatch(result.say, /समझ गई\/गया|समझती\/समझता/);
  assert.throws(() => createSession({ agent_gender: "unspecified" }), /agent_gender must be male, female, or neutral/);
});

test("accepts Unicode Hindi numerals and agricultural-property terms", () => {
  const parsed = extractDetails("कृषि भूमि है और ७५ लाख चाहिए।", "requested_amount_inr");
  assert.equal(parsed.values.property_type, "agricultural");
  assert.equal(parsed.values.requested_amount_inr, 7_500_000);
  const hindiCrore = extractDetails("प्रॉपर्टी की कीमत १ करोड़ है।");
  assert.equal(hindiCrore.values.property_market_value_inr, 10_000_000);
});

test("uses the latest corrected amount and tenure stated in one full sentence", () => {
  const amount = extractDetails("I first needed 90 lakhs, correction: I need 50 lakhs.");
  assert.equal(amount.values.requested_amount_inr, 5_000_000);
  const tenure = extractDetails("I said 20 years earlier, actually 10 years is right.");
  assert.equal(tenure.values.tenure_years, 10);
});
