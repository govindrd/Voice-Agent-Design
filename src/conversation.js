"use strict";

const MAX_LOAN_INR = 7_500_000;
const FIELD_ORDER = [
  "property_type",
  "ownership",
  "original_documents",
  "requested_amount_inr",
  "occupation_income",
  "property_market_value_inr",
  "tenure_years",
];

const FIELD_LABELS = {
  property_type: "property type",
  ownership: "ownership",
  original_documents: "original property documents",
  requested_amount_inr: "loan amount",
  occupation_income: "occupation and income mode",
  property_market_value_inr: "property market value",
  tenure_years: "repayment tenure",
};

const OPENING = {
  english: ({ agent_name, company_name, customer_name }) =>
    `Hello, may I speak with ${customer_name}? I'm ${agent_name}, calling on behalf of ${company_name}. Is this a good time to talk?`,
  hindi: ({ agent_name, company_name, customer_name }) =>
    `नमस्ते, क्या मेरी बात ${customer_name} जी से हो रही है? मेरी पहचान ${agent_name} है और यह ${company_name} की ओर से कॉल है। क्या अभी बात करना सुविधाजनक है?`,
};

function localDateParts(date = new Date()) {
  const currentDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return {
    current_date: currentDate,
    current_day: new Intl.DateTimeFormat("en", { weekday: "long" }).format(date),
    current_time: new Intl.DateTimeFormat("en", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date),
  };
}

function transferToSpecialist(state) {
  return end(
    state,
    "transfer_specialist",
    text(
      state,
      `I understand. Since you have an existing loan on the property or would like to reduce your current EMI, a loan-transfer specialist from ${state.variables.company_name} will contact you shortly. Thank you for your time.`,
      `समझ गई/गया। चूँकि इस प्रॉपर्टी पर पहले से लोन है या आप मौजूदा EMI कम करना चाहते हैं, ${state.variables.company_name} का लोन-ट्रांसफर विशेषज्ञ आपसे जल्द संपर्क करेगा। आपका समय देने के लिए धन्यवाद।`,
    ),
  );
}

function normalizeVariables(input = {}) {
  const supplied = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const dates = localDateParts();
  const gender = String(supplied.agent_gender || "neutral").trim().toLowerCase();
  if (!["male", "female", "neutral"].includes(gender)) {
    throw new Error("agent_gender must be male, female, or neutral.");
  }
  const language = String(supplied.language_to_speak || "English").trim().toLowerCase();
  if (!["english", "en", "hindi", "hi", "हिंदी"].includes(language)) {
    throw new Error("language_to_speak must be English or Hindi.");
  }
  return {
    company_name: safeText(supplied.company_name, "Home Credit"),
    customer_name: safeText(supplied.customer_name, "there"),
    agent_name: safeText(supplied.agent_name, "Aarav"),
    agent_gender: gender,
    current_date: safeText(supplied.current_date, dates.current_date),
    current_day: safeText(supplied.current_day, dates.current_day),
    current_time: safeText(supplied.current_time, dates.current_time),
    additional_context_from_rag: safeText(supplied.additional_context_from_rag, ""),
    language_to_speak: ["hindi", "hi", "हिंदी"].includes(language) ? "Hindi" : "English",
    conversation_history: safeText(supplied.conversation_history, ""),
  };
}

function safeText(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 12_000) : fallback;
}

function isHindi(state) {
  return state.variables.language_to_speak === "Hindi";
}

function text(state, english, hindi) {
  return isHindi(state) ? applyAgentGender(state, hindi) : english;
}

function applyAgentGender(state, value) {
  const gender = state.variables.agent_gender;
  const replacements = [
    ["मैं समझती/समझता हूँ", "ठीक है"],
    ["समझती/समझता हूँ", "ठीक है"],
    ["समझ गई/गया", "ठीक है"],
    ["मैं कॉल समाप्त करती/करता हूँ", "हम कॉल समाप्त करते हैं"],
  ];
  let output = value;
  for (const [pattern, neutral] of replacements) {
    output = output.replaceAll(pattern, gender === "female"
      ? pattern.replace("समझती/समझता", "समझती").replace("समझ गई/गया", "समझ गई").replace("करती/करता", "करती")
      : gender === "male"
        ? pattern.replace("समझती/समझता", "समझता").replace("समझ गई/गया", "समझ गया").replace("करती/करता", "करता")
        : neutral);
  }
  return output;
}

function createSession(variables = {}) {
  const normalized = normalizeVariables(variables);
  const state = {
    variables: normalized,
    phase: "identity",
    status: "active",
    identity_verified: false,
    fields: {
      property_type: null,
      ownership: null,
      original_documents: null,
      requested_amount_inr: null,
      occupation_income: { occupation: null, income_mode: null },
      property_market_value_inr: null,
      tenure_years: null,
    },
    pending_amount_inr: null,
    callback_time: null,
    next_field: null,
    transcript: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return {
    state,
    say: OPENING[isHindi(state) ? "hindi" : "english"](normalized),
    action: "greet",
  };
}

function processTurn(state, customerUtterance) {
  if (!state || !state.fields) throw new Error("A valid conversation state is required.");
  const utterance = String(customerUtterance || "").trim().slice(0, 4_000);
  if (!utterance) throw new Error("customer_utterance must not be empty.");
  state.updated_at = new Date().toISOString();
  pushTranscript(state, "customer", utterance);
  if (state.status !== "active") {
    return result(state, text(state, "The call has already ended.", "यह कॉल पहले ही समाप्त हो चुकी है।"), "already_ended");
  }

  if (isRefusal(utterance)) {
    return end(
      state,
      "declined",
      text(state, "Understood. Thank you for your time. We will end the call now. Goodbye.", "ठीक है। आपका समय देने के लिए धन्यवाद। हम अभी कॉल समाप्त करते हैं। नमस्कार।"),
    );
  }

  if (state.identity_verified && isTransferIntent(utterance)) {
    return transferToSpecialist(state);
  }

  if (state.phase === "amount_cap_confirmation" && declinesMaximum(utterance)) {
    return end(
      state,
      "declined_maximum",
      text(state, "I understand. The offer is limited to INR 75,00,000, so I will not proceed with a higher amount. Thank you for your time. Goodbye.", "मैं समझती/समझता हूँ। इस ऑफ़र की अधिकतम राशि ₹75,00,000 है, इसलिए इससे अधिक राशि के लिए आगे नहीं बढ़ सकते। आपका समय देने के लिए धन्यवाद। नमस्कार।"),
    );
  }

  let parsed = { values: {}, count: 0 };
  let parsedApplied = false;
  if (state.identity_verified) {
    const currentField = state.phase === "checklist"
      ? state.next_field
      : state.phase === "amount_cap_confirmation"
        ? "requested_amount_inr"
        : null;
    parsed = extractDetails(utterance, currentField);
    applyParsed(state, parsed);
    parsedApplied = true;
    const disqualification = findDisqualification(state);
    if (disqualification) return disqualify(state, disqualification);
  }

  if (state.phase === "callback_time") {
    const callback = extractCallbackTime(utterance);
    if (callback) {
      state.callback_time = callback;
      return end(
        state,
        "callback_requested",
        text(
          state,
          `Thank you. We have noted your preferred callback time as ${callback}. Goodbye.`,
          `धन्यवाद। हमने ${callback} पर दोबारा कॉल करने का समय नोट कर लिया है। नमस्कार।`,
        ),
      );
    }
    return result(
      state,
      text(state, "Of course. What day and time would suit you for a callback?", "ज़रूर। किस दिन और किस समय आपको दोबारा कॉल करना सुविधाजनक होगा?"),
      "ask_callback_time",
    );
  }

  const busy = isBusy(utterance);
  if (busy) {
    const callback = extractCallbackTime(utterance);
    if (callback) {
      state.callback_time = callback;
      return end(
        state,
        "callback_requested",
        text(state, `Of course. We will note a callback for ${callback}. Goodbye.`, `ज़रूर। हमने ${callback} पर दोबारा कॉल करने का समय नोट कर लिया है। नमस्कार।`),
      );
    }
    state.phase = "callback_time";
    return result(
      state,
      text(state, "I understand. When would be a convenient day and time for us to call you back?", "मैं समझती/समझता हूँ। आपको दोबारा कॉल करने के लिए कौन-सा दिन और समय सुविधाजनक रहेगा?"),
      "ask_callback_time",
    );
  }

  if (state.phase === "identity") {
    if (isWrongPerson(utterance, state.variables.customer_name) || isNegative(utterance)) {
      return end(
        state,
        "wrong_person",
        text(state, "I apologize for the interruption. I will end the call. Goodbye.", "असुविधा के लिए क्षमा करें। मैं कॉल समाप्त करती/करता हूँ। नमस्कार।"),
      );
    }
    if (!isIdentityConfirmed(utterance, state.variables.customer_name)) {
      return result(
        state,
        text(state, `Could you please confirm whether you are ${state.variables.customer_name}?`, `क्या आप कृपया पुष्टि करेंगे कि आप ${state.variables.customer_name} जी हैं?`),
        "verify_identity",
      );
    }
    state.identity_verified = true;
    if (isTransferIntent(utterance)) return transferToSpecialist(state);
    state.phase = "offer";
    if (!parsedApplied) {
      parsed = extractDetails(utterance, null);
      applyParsed(state, parsed);
    }
    const disqualification = findDisqualification(state);
    if (disqualification) return disqualify(state, disqualification);
    if (state.pending_amount_inr !== null) {
      state.phase = "amount_cap_confirmation";
      return result(state, amountCapQuestion(state, true), "confirm_amount_cap");
    }
    return result(state, offerAndConsent(state), "present_offer");
  }

  if (!parsedApplied) {
    const currentField = state.phase === "checklist"
      ? state.next_field
      : state.phase === "amount_cap_confirmation"
        ? "requested_amount_inr"
        : null;
    parsed = extractDetails(utterance, currentField);
    applyParsed(state, parsed);
  }

  const disqualification = findDisqualification(state);
  if (disqualification) return disqualify(state, disqualification);

  if (state.pending_amount_inr !== null) {
    const accepted = acceptsMaximum(utterance);
    const declined = declinesMaximum(utterance);
    if (accepted) {
      state.fields.requested_amount_inr = MAX_LOAN_INR;
      state.pending_amount_inr = null;
      state.phase = "checklist";
    } else if (declined) {
      return end(
        state,
        "declined_maximum",
        text(state, "I understand. The offer is limited to INR 75,00,000, so I will not proceed with a higher amount. Thank you for your time. Goodbye.", "मैं समझती/समझता हूँ। इस ऑफ़र की अधिकतम राशि ₹75,00,000 है, इसलिए इससे अधिक राशि के लिए आगे नहीं बढ़ सकते। आपका समय देने के लिए धन्यवाद। नमस्कार।"),
      );
    } else if (state.fields.requested_amount_inr !== null) {
      state.pending_amount_inr = null;
      state.phase = state.phase === "offer" ? "checklist" : state.phase;
    } else {
      state.phase = "amount_cap_confirmation";
      return result(state, amountCapQuestion(state), "confirm_amount_cap");
    }
  }

  if (state.phase === "offer") {
    if (isNegative(utterance)) {
      return end(state, "declined", text(state, "Understood. Thank you for your time. Goodbye.", "ठीक है। आपका समय देने के लिए धन्यवाद। नमस्कार।"));
    }
    if (!isPositive(utterance) && parsed.count === 0) {
      return result(
        state,
        text(state, "Would you like to continue with a few quick eligibility questions for this offer?", "क्या आप इस ऑफ़र के लिए कुछ छोटे पात्रता-संबंधी सवालों के साथ आगे बढ़ना चाहेंगे?"),
        "confirm_interest",
      );
    }
    state.phase = "checklist";
  }

  return askNextOrHandoff(state);
}

function applyParsed(state, parsed) {
  for (const key of ["property_type", "ownership", "original_documents", "property_market_value_inr", "tenure_years"]) {
    if (parsed.values[key] !== undefined) state.fields[key] = parsed.values[key];
  }
  if (parsed.values.requested_amount_inr !== undefined) {
    const amount = parsed.values.requested_amount_inr;
    if (amount > MAX_LOAN_INR) {
      state.pending_amount_inr = amount;
      state.fields.requested_amount_inr = null;
    } else {
      state.fields.requested_amount_inr = amount;
      state.pending_amount_inr = null;
    }
  }
  if (parsed.values.occupation !== undefined) state.fields.occupation_income.occupation = parsed.values.occupation;
  if (parsed.values.income_mode !== undefined) state.fields.occupation_income.income_mode = parsed.values.income_mode;
}

function findDisqualification(state) {
  const fields = state.fields;
  if (fields.property_type === "agricultural") return "agricultural_property";
  if (fields.original_documents === false) return "original_documents_unavailable";
  if (fields.occupation_income.income_mode === "cash") return "cash_income";
  if (fields.occupation_income.occupation === "other") return "occupation_not_supported";
  if (fields.tenure_years !== null && (fields.tenure_years < 3 || fields.tenure_years > 15)) return "tenure_out_of_range";
  return null;
}

function disqualify(state, reason) {
  const descriptions = {
    agricultural_property: ["Agricultural property does not meet the criteria for this specific offer.", "कृषि भूमि इस विशेष ऑफ़र के मानदंडों में शामिल नहीं है।"],
    original_documents_unavailable: ["Original property documents must be available for verification.", "जाँच के लिए प्रॉपर्टी के मूल दस्तावेज़ उपलब्ध होना ज़रूरी है।"],
    cash_income: ["Income for this offer must be received through a bank, rather than in cash.", "इस ऑफ़र के लिए आय बैंक के माध्यम से प्राप्त होनी चाहिए, नकद में नहीं।"],
    occupation_not_supported: ["This offer's preliminary criteria cover salaried or self-employed customers.", "इस ऑफ़र के शुरुआती मानदंड वेतनभोगी या स्व-रोज़गार ग्राहकों के लिए हैं।"],
    tenure_out_of_range: ["The eligible repayment tenure is between 3 and 15 years.", "पात्र पुनर्भुगतान अवधि 3 से 15 वर्ष के बीच है।"],
  };
  const [english, hindi] = descriptions[reason];
  return end(
    state,
    "ineligible",
    text(
      state,
      `${english} You do not meet the criteria for this specific offer at this time. Thank you for speaking with me. Goodbye.`,
      `${hindi} फिलहाल आप इस विशेष ऑफ़र के मानदंडों को पूरा नहीं करते हैं। बात करने के लिए धन्यवाद। नमस्कार।`,
    ),
    { reason },
  );
}

function askNextOrHandoff(state) {
  for (const field of FIELD_ORDER) {
    if (!isFieldComplete(state.fields, field)) {
      state.next_field = field;
      state.phase = "checklist";
      return result(state, questionFor(state, field), "ask_eligibility");
    }
  }
  state.next_field = null;
  state.phase = "completed";
  return end(
    state,
    "qualified_handoff",
    text(
      state,
      `Thank you. Based on these preliminary answers, you meet the initial criteria for the Loan Against Property offer. A senior loan expert from ${state.variables.company_name} will call you shortly to discuss the application and exact interest rates. This is a preliminary check only, not a loan approval or rate guarantee. Goodbye.`,
      `धन्यवाद। आपके शुरुआती जवाबों के आधार पर आप इस लोन अगेंस्ट प्रॉपर्टी ऑफ़र के प्रारंभिक मानदंडों को पूरा करते हैं। आवेदन और सटीक ब्याज दरों पर चर्चा करने के लिए ${state.variables.company_name} का वरिष्ठ लोन विशेषज्ञ आपसे जल्द संपर्क करेगा। यह केवल शुरुआती जाँच है, लोन की स्वीकृति या ब्याज दर की गारंटी नहीं। नमस्कार।`,
    ),
  );
}

function isFieldComplete(fields, field) {
  if (field === "occupation_income") {
    return Boolean(fields.occupation_income.occupation && fields.occupation_income.income_mode);
  }
  return fields[field] !== null;
}

function questionFor(state, field) {
  const en = {
    property_type: "What type of property would you like to offer as security: residential, commercial, or industrial?",
    ownership: "Are you the sole owner, or is the property jointly owned?",
    original_documents: "Are the original property documents available for verification?",
    requested_amount_inr: "How much would you like to borrow? The maximum for this offer is INR 75,00,000.",
    occupation_income: occupationQuestion(state),
    property_market_value_inr: "What is the property's approximate current market value?",
    tenure_years: "What repayment tenure would you prefer, between 3 and 15 years?",
  };
  const hi = {
    property_type: "जिस प्रॉपर्टी को आप सुरक्षा के रूप में देना चाहते हैं, वह आवासीय, कमर्शियल या औद्योगिक है?",
    ownership: "क्या आप इस प्रॉपर्टी के अकेले मालिक हैं या यह संयुक्त स्वामित्व में है?",
    original_documents: "क्या जाँच के लिए प्रॉपर्टी के मूल दस्तावेज़ उपलब्ध हैं?",
    requested_amount_inr: "आप कितनी राशि उधार लेना चाहते हैं? इस ऑफ़र की अधिकतम सीमा ₹75,00,000 है।",
    occupation_income: occupationQuestion(state, true),
    property_market_value_inr: "प्रॉपर्टी की मौजूदा अनुमानित बाज़ार कीमत कितनी है?",
    tenure_years: "आप कितने साल की पुनर्भुगतान अवधि चाहेंगे? यह 3 से 15 साल के बीच हो सकती है।",
  };
  return text(state, en[field], hi[field]);
}

function occupationQuestion(state, hindi = false) {
  const { occupation, income_mode } = state.fields.occupation_income;
  if (!occupation && !income_mode) {
    return hindi
      ? "क्या आप वेतनभोगी हैं या स्व-रोज़गार में हैं, और आपकी आय बैंक में मिलती है या नकद?"
      : "Are you salaried or self-employed, and is your income received through a bank or in cash?";
  }
  if (!occupation) return hindi ? "क्या आप वेतनभोगी हैं या स्व-रोज़गार में हैं?" : "Are you salaried or self-employed?";
  return hindi ? "आपकी आय बैंक में मिलती है या नकद?" : "Is your income received through a bank or in cash?";
}

function offerAndConsent(state) {
  return text(
    state,
    `${state.variables.company_name} is reaching out to thank you for being a valued customer and share a special Loan Against Property offer of up to INR 75,00,000. Would you like to continue with a few quick eligibility questions?`,
    `${state.variables.company_name} का valued customer होने के लिए धन्यवाद। हम आपके लिए ₹75,00,000 तक का विशेष लोन अगेंस्ट प्रॉपर्टी ऑफ़र साझा करने के लिए कॉल कर रहे हैं। क्या आप कुछ छोटे पात्रता-संबंधी सवालों के साथ आगे बढ़ना चाहेंगे?`,
  );
}

function amountCapQuestion(state, includeOffer = false) {
  const introEn = includeOffer
    ? `${state.variables.company_name} is thanking you for being a valued customer with a special Loan Against Property offer. `
    : "";
  const introHi = includeOffer
    ? `${state.variables.company_name} की ओर से valued customer होने के लिए धन्यवाद; हम एक विशेष लोन अगेंस्ट प्रॉपर्टी ऑफ़र साझा कर रहे हैं। `
    : "";
  return text(
    state,
    `${introEn}This offer is capped at INR 75,00,000. Would you like to proceed with the maximum amount of INR 75,00,000?`,
    `${introHi}इस ऑफ़र की अधिकतम सीमा ₹75,00,000 है। क्या आप अधिकतम ₹75,00,000 राशि के साथ आगे बढ़ना चाहेंगे?`,
  );
}

function result(state, say, action, extra = {}) {
  pushTranscript(state, "agent", say);
  return {
    say,
    action,
    session_id: state.session_id || null,
    phase: state.phase,
    status: state.status,
    fields: structuredClone(state.fields),
    next_field: state.next_field,
    callback_time: state.callback_time,
    ...extra,
  };
}

function pushTranscript(state, speaker, value) {
  state.transcript.push({ speaker, text: value });
  if (state.transcript.length > 100) state.transcript.splice(0, state.transcript.length - 100);
}

function end(state, action, say, extra = {}) {
  state.status = action === "qualified_handoff" ? "qualified" : action === "callback_requested" ? "callback_requested" : action === "transfer_specialist" ? "transfer_referred" : "ended";
  state.phase = "ended";
  state.next_field = null;
  return result(state, say, action, extra);
}

function normalizeDigits(value) {
  const digits = "०१२३४५६७८९";
  return String(value).replace(/[०-९]/g, (digit) => String(digits.indexOf(digit)));
}

function normalize(value) {
  return normalizeDigits(value).toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

function isTransferIntent(value) {
  const s = normalize(value);
  const negativeCurrentLoan = /\b(?:no|not|never|don't|do not|doesn't|does not|without)\s+(?:have\s+)?(?:an?\s+)?(?:any\s+)?(?:existing|current|running|outstanding)?\s*(?:lap|property|home|mortgage)?\s*loan\b/.test(s);
  const emiReduction = hasUnnegatedMatch(s, /\b(?:reduce|lower|decrease|cut|lessen|कम)\b.{0,30}\b(?:my\s+)?(?:current\s+)?emi\b|\bemi\b.{0,30}\b(?:reduce|lower|decrease|कम)\b/g);
  const transfer = hasUnnegatedMatch(s, /\b(?:balance transfer|loan transfer|transfer my (?:existing )?loan|switch my loan|refinanc(?:e|ing))\b/g);
  const existing = hasUnnegatedMatch(s, /\b(?:already have|have an existing|existing|current|running|outstanding)\b.{0,35}\b(?:lap|property|home|mortgage)?\s*loan\b|\bloan\b.{0,35}\b(?:already|existing|current|on (?:the )?property)\b/g);
  return emiReduction || transfer || (existing && !negativeCurrentLoan);
}

function isBusy(value) {
  return hasUnnegatedMatch(normalize(value), /\b(?:busy|in a meeting|driving|can't talk|cannot talk|not a good time|call me back|call back|callback|call later|later today|call tomorrow)\b|अभी बात नहीं|व्यस्त|बाद में कॉल/g);
}

function extractCallbackTime(value) {
  const s = normalize(value);
  const patterns = [
    /\b(?:tomorrow|today|tonight|next week|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b(?:\s+(?:at|around)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?(?:\s+(?:morning|afternoon|evening))?/i,
    /\b(?:at|around)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
    /\b(?:at|around)\s+\d{1,2}(?::\d{2})?\b/i,
    /\b(?:after|before)\s+(?:lunch|work|dinner|noon|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
    /\b(?:morning|afternoon|evening)\b/i,
    /कल(?:\s*(?:सुबह|दोपहर|शाम))?|(?:आज|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार)(?:\s*(?:सुबह|दोपहर|शाम))?|(?:सुबह|दोपहर|शाम)/,
  ];
  for (const pattern of patterns) {
    const match = String(value).match(pattern);
    if (match) return match[0].trim().slice(0, 120);
  }
  return null;
}

function isRefusal(value) {
  return /\b(?:not interested|don't call|do not call|stop calling|remove me|no thanks|no thank you|not required|not looking|decline|no need)\b|रुचि नहीं|कॉल मत|नहीं चाहिए/.test(normalize(value));
}

function isWrongPerson(value, customerName) {
  const s = normalize(value);
  const name = normalize(customerName);
  if (/\b(?:wrong number|wrong person|you have the wrong|not the customer|not me)\b|गलत नंबर/.test(s)) return true;
  return name !== "there" && new RegExp(`\\bnot\\s+(?:${escapeRegex(name)})(?:\\b|$)`).test(s);
}

function isIdentityConfirmed(value, customerName) {
  const s = normalize(value);
  const name = normalize(customerName);
  if (isWrongPerson(s, name)) return false;
  const clean = s.replace(/[.,!?]/g, "").trim();
  if (/^(?:yes|yeah|yep|speaking|this is me|that's me|that is me|haan|ji|जी|हाँ|हां)$/.test(clean)) return true;
  const escaped = escapeRegex(name);
  return name !== "there" && (
    new RegExp(`\\b(?:this is|speaking|yes,? this is|haan,? main)\\s+(?:${escaped})\\b`).test(s) ||
    new RegExp(`\\b${escaped}\\s+(?:speaking|here)\\b`).test(s) ||
    new RegExp(`\\b(?:i am|i'm)\\s+${escaped}\\b`).test(s)
  );
}

function isPositive(value) {
  const s = normalize(value);
  return /^(?:yes|yeah|yep|sure|okay|ok|go ahead|please do|that's fine|sounds good|haan|जी|हाँ|हां|ठीक है)(?:[.! ,]|$)/i.test(s) ||
    hasUnnegatedMatch(s, /\b(?:let's proceed|let's go ahead|let's do it|let us proceed|continue|proceed)\b/g);
}

function isNegative(value) {
  return /^(?:no|nope|nah|not now|no thanks|nahi|नहीं|ना)(?:[.! ,]|$)/i.test(normalize(value));
}

function acceptsMaximum(value) {
  const s = normalize(value);
  return maximumDecision(s) === "accept";
}

function declinesMaximum(value) {
  return maximumDecision(normalize(value)) === "decline";
}

function maximumDecision(value) {
  if (/^(?:yes|yeah|yep|sure|okay|ok|go ahead|please do|that's fine|sounds good|haan|जी|हाँ|हां|ठीक है)[.! ]*$/i.test(value)) return "accept";
  if (/^(?:no|nope|nah|not now|no thanks|nahi|नहीं|ना)[.! ]*$/i.test(value)) return "decline";
  const accept = /\b(?:yes|yeah|yep|sure|okay|ok|go ahead|maximum|max amount|that amount|that works|it works|will do|is fine|fine with)\b|75\s*(?:lakh|lakhs|lac|lacs|l)?\s*(?:is\s*)?(?:fine|okay|ok|works)\b|₹\s*75,?00,?000\s*(?:is\s*)?(?:fine|okay|ok|works)?/g;
  const decline = /\b(?:no|nope|nah|more than that|need more|too low|not enough|need the full|higher amount|won't work|will not work|can't accept|cannot accept)\b/g;
  const lastIndex = (pattern) => {
    let index = -1;
    let match;
    while ((match = pattern.exec(value)) !== null) index = match.index;
    return index;
  };
  const acceptIndex = lastIndex(accept);
  const declineIndex = lastIndex(decline);
  if (acceptIndex < 0 && declineIndex < 0) return null;
  return acceptIndex > declineIndex ? "accept" : "decline";
}

function extractDetails(value, currentField) {
  const s = normalize(value);
  const values = {};
  const set = (key, val) => {
    if (val !== undefined && val !== null) values[key] = val;
  };

  const property = lastMatch(s, [
    ["agricultural", /\b(?:agricultural|agriculture|farmland|farm land|farming land)\b|कृषि|खेती|खेत/g],
    ["residential", /\b(?:residential|house|home|flat|apartment)\b|आवासीय|घर|फ्लैट/g],
    ["commercial", /\b(?:commercial|shop|office|retail)\b|कमर्शियल|दुकान|ऑफिस/g],
    ["industrial", /\b(?:industrial|factory|manufacturing unit)\b|औद्योगिक|फैक्टरी|कारखाना/g],
  ], true);
  if (property) set("property_type", property);

  const ownership = lastMatch(s, [
    ["joint", /\b(?:joint(?:ly)?|co-?owned|shared ownership)\b|संयुक्त/g],
    ["sole", /\b(?:sole owner|single owner|only owner|owned by me alone|my name alone)\b|अकेले मालिक|एकल स्वामित्व/g],
  ], true);
  if (ownership) set("ownership", ownership);

  const docsCue = /\b(?:originals?|documents?|papers?|deed|title)\b|मूल दस्तावेज़|मूल कागज़|असली कागज़/.test(s);
  if (docsCue) {
    const docStatus = lastMatch(s, [
      [false, /\b(?:don't have|do not have|not have|aren't available|are not available|unavailable|missing|lost|no originals?)\b|नहीं हैं|उपलब्ध नहीं/g],
      [true, /\b(?:have|available|ready|with me|in hand|possess)\b|हैं|उपलब्ध/g],
    ], true);
    if (docStatus !== null && docStatus !== undefined) set("original_documents", docStatus);
  } else if (currentField === "original_documents" && /^(?:no|नहीं|नही)$/.test(s)) {
    set("original_documents", false);
  } else if (currentField === "original_documents" && /^(?:yes|yeah|haan|जी|हाँ|हां)$/.test(s)) {
    set("original_documents", true);
  }

  const occupation = lastMatch(s, [
    ["self_employed", /\b(?:self[- ]?employed|own (?:a )?business|business owner|entrepreneur)\b|स्व-रोज़गार|व्यवसाय|व्यापारी/g],
    ["salaried", /\b(?:salaried|job)\b|(?<!self[- ])\bemployed\b|वेतनभोगी|नौकरी/g],
    ["other", /\b(?:retired|unemployed|student|homemaker)\b|सेवानिवृत्त/g],
  ], true);
  const resolvedOccupation = occupation || (/\bsalary\b/.test(s) ? "salaried" : undefined);
  set("occupation", resolvedOccupation);
  const incomeMode = lastMatch(s, [
    ["cash", /\b(?:cash|paid in cash|cash income)\b|नकद/g],
    ["bank", /\b(?:bank|bank account|bank transfer|credited to (?:my )?account|salary credited|through the bank)\b|बैंक/g],
  ], true);
  if (incomeMode) set("income_mode", incomeMode);

  const money = extractMoney(s, currentField);
  if (money.requested !== undefined) set("requested_amount_inr", money.requested);
  if (money.marketValue !== undefined) set("property_market_value_inr", money.marketValue);

  const tenure = extractTenure(s, currentField);
  if (tenure !== undefined) set("tenure_years", tenure);

  if (currentField === "property_type" && !values.property_type) {
    if (/\b(?:residential|house|home|flat|apartment)\b/.test(s)) set("property_type", "residential");
    else if (/\b(?:commercial|shop|office)\b/.test(s)) set("property_type", "commercial");
    else if (/\b(?:industrial|factory)\b/.test(s)) set("property_type", "industrial");
  }
  if (currentField === "ownership" && !values.ownership) {
    if (/^(?:sole|single|only me)$/.test(s)) set("ownership", "sole");
    if (/^(?:joint|together|co-?owned)$/.test(s)) set("ownership", "joint");
  }

  return { values, count: Object.keys(values).length };
}

function extractMoney(s, currentField) {
  const values = { requested: undefined, marketValue: undefined };
  const pattern = /(?:₹|inr|rs\.?)?\s*(\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(crore|crores|करोड़|करोड|cr|lakh|lakhs|लाख|lac|lacs|million|thousand|l)?/g;
  const candidates = [];
  let previousAmount = null;
  let match;
  while ((match = pattern.exec(s)) !== null) {
    if (!match[1]) continue;
    const raw = match[1].replace(/,/g, "");
    const number = Number(raw);
    if (!Number.isFinite(number)) continue;
    const unit = match[2] || "";
    const multiplier = /^(?:crore|crores|करोड़|करोड|cr)$/.test(unit) ? 10_000_000
      : /^(?:lakh|lakhs|लाख|lac|lacs|l)$/.test(unit) ? 100_000
        : unit === "million" ? 1_000_000
          : unit === "thousand" ? 1_000
            : number > 10_000 ? 1 : 100_000;
    const amount = Math.round(number * multiplier);
    const contextStart = previousAmount
      ? Math.max(match.index - 55, previousAmount.index + previousAmount.text.length)
      : Math.max(0, match.index - 55);
    const before = s.slice(contextStart, match.index);
    const after = s.slice(match.index, Math.min(s.length, match.index + match[0].length + 45));
    const start = match.index;
    const end = match.index + match[0].length;
    const loanDistance = cueDistance(before, after, start, end, /\b(?:loan amount|amount|loan|borrow(?:ing)?|looking for|would like|want|need|require|take)\b|लोन|राशि|चाहिए|उधार/g);
    const marketDistance = cueDistance(before, after, start, end, /\b(?:market value|property value|valuation|worth|valued|value)\b|की कीमत|मूल्य|कीमत/g);
    const incomeDistance = cueDistance(before, after, start, end, /\b(?:salary|income|earnings?|per month|monthly|paid)\b/g);
    const marketCue = marketDistance <= 35 && marketDistance < loanDistance && marketDistance < incomeDistance;
    const loanCue = loanDistance <= 35 && loanDistance < marketDistance && loanDistance < incomeDistance;
    candidates.push({ amount, marketCue, loanCue, incomeDistance });
    previousAmount = { index: match.index, text: match[0] };
  }

  const market = candidates.filter((entry) => entry.marketCue).at(-1);
  const requested = candidates.filter((entry) => entry.loanCue).at(-1);
  if (market) values.marketValue = market.amount;
  if (requested) values.requested = requested.amount;
  if (!market && !requested && candidates.length === 1 && candidates[0].incomeDistance > 35) {
    if (currentField === "requested_amount_inr") values.requested = candidates[0].amount;
    if (currentField === "property_market_value_inr") values.marketValue = candidates[0].amount;
  }
  return values;
}

function cueDistance(before, after, amountStart, amountEnd, pattern) {
  let closest = Number.POSITIVE_INFINITY;
  const prefixOffset = amountStart - before.length;
  for (const match of before.matchAll(pattern)) {
    const cueEnd = prefixOffset + match.index + match[0].length;
    closest = Math.min(closest, amountStart - cueEnd);
  }
  for (const match of after.matchAll(pattern)) {
    closest = Math.min(closest, amountEnd + match.index - amountEnd);
  }
  return closest;
}

function extractTenure(s, currentField) {
  const explicitTenures = [...s.matchAll(/(\d+(?:\.\d+)?)\s*[- ]?\s*(?:years?|yrs?|saal|साल|वर्ष)/g)];
  const match = explicitTenures.at(-1);
  if (match) return Number(match[1]);
  if (/\b(?:tenure|term|repay|repayment|duration)\b/.test(s)) {
    const numbers = [...s.matchAll(/\b(?:tenure|term|repay|repayment|duration)\b.{0,20}?(\d+(?:\.\d+)?)/g)];
    if (numbers.length) return Number(numbers.at(-1)[1]);
  }
  if (currentField === "tenure_years" && /^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return undefined;
}

function lastMatch(value, choices, ignoreNegated = false) {
  let found = null;
  for (const [result, pattern] of choices) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      if (ignoreNegated && isNegatedAt(value, match.index)) continue;
      if (!found || match.index >= found.index) found = { index: match.index, result };
    }
  }
  return found && found.result;
}

function hasUnnegatedMatch(value, pattern) {
  for (const match of value.matchAll(pattern)) {
    if (!isNegatedAt(value, match.index)) return true;
  }
  return false;
}

function isNegatedAt(value, index) {
  const before = value.slice(Math.max(0, index - 45), index);
  const clause = before.slice(Math.max(before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?")) + 1);
  return /\b(?:not|never|no|don't|do not|doesn't|does not|isn't|is not|without|rather than|instead of)\b(?:\s+\w+){0,3}\s*$/.test(clause);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  FIELD_LABELS,
  FIELD_ORDER,
  MAX_LOAN_INR,
  createSession,
  extractDetails,
  normalizeVariables,
  processTurn,
};
