// The state of the Beleidskompas screen: the case, the messages, the active
// substep, the open conversation and the report per substep. Every change goes
// through a method here, which tells the parts of the screen that show it to
// redraw (subscribe/changed), so code that changes the state does not need
// to know which parts show it.

import { normalizeCitations } from "./format.js";

const CONVERSATION_STORAGE_KEY = "gc_bk_conversation_id";

function emptyResult() {
  return { report_text: "", citations: [], retrieval_trace: null, updated_at: "" };
}

function emptyResults(substeps) {
  const results = {};
  substeps.forEach((s) => {
    results[s.id] = emptyResult();
  });
  return results;
}

// A message belongs to a substep (substepId) and is either part of the
// conversation about it (conversation: true, what the user typed and the
// answer to it) or a report and the request for it. An answer also says
// which step gave it (agent), which can be another step than the substep's
// when the question was about that step.
function createMessage(role, text, meta = {}) {
  const message = {
    role,
    text: String(text || "").trim(),
    ts: meta.ts || new Date().toISOString(),
    citations: normalizeCitations(meta.citations),
    retrieval_trace: meta.retrieval_trace || null,
    agent: meta.agent ? String(meta.agent) : null,
    substepId: String(meta.substepId || ""),
    conversation: Boolean(meta.conversation),
  };
  if (meta.pending) message.pending = true;
  return message;
}

function readStoredConversationId() {
  try {
    return String(sessionStorage.getItem(CONVERSATION_STORAGE_KEY) || "").trim() || null;
  } catch (_) {
    return null;
  }
}

export function createStore(steps) {
  // Every substep in the order of the steps, each with its step, so the
  // screen can walk through them with one index.
  const substeps = steps.flatMap((step) => step.substeps.map((substep) => ({ ...substep, step })));

  const state = {
    // The case as the user described it; sent with every request.
    caseText: "",
    activeSubstep: 0,
    // The id of the substep a request to Beleidskompas is under way for, or
    // "" when none is; no second request starts until it is answered.
    asking: "",
    conversationId: readStoredConversationId(),
    lastMessageId: null,
    messages: [createMessage("assistant", "Hallo! Ik ben je beleidsassistent. Beschrijf je casus en ik help je stap voor stap.")],
    results: emptyResults(substeps),
  };

  const listeners = new Map();

  function subscribe(topic, listener) {
    if (!listeners.has(topic)) listeners.set(topic, []);
    listeners.get(topic).push(listener);
  }

  function changed(...topics) {
    topics.forEach((topic) => (listeners.get(topic) || []).forEach((listener) => listener()));
  }

  function activeSubstep() {
    return substeps[state.activeSubstep] || substeps[0];
  }

  function activeStep() {
    return activeSubstep().step;
  }

  function setActiveSubstep(index) {
    state.activeSubstep = Math.max(0, Math.min(substeps.length - 1, Number(index) || 0));
    changed("steps");
  }

  /** Opens a step at its first substep. */
  function setActiveStep(stepIndex) {
    const step = steps[Math.max(0, Math.min(steps.length - 1, Number(stepIndex) || 0))];
    setActiveSubstep(substeps.findIndex((s) => s.step === step));
  }

  function substepResult(substepId) {
    return state.results[substepId] || emptyResult();
  }

  function substepDone(substepId) {
    return Boolean(String(substepResult(substepId).report_text || "").trim());
  }

  function stepDone(stepId) {
    const step = steps.find((s) => s.id === stepId);
    return Boolean(step && step.substeps.length && step.substeps.every((s) => substepDone(s.id)));
  }

  function setSubstepResult(substepId, result) {
    state.results[substepId] = { ...emptyResult(), ...result, citations: normalizeCitations(result.citations) };
    changed("steps");
  }

  /** Puts back the reports of a reopened case, all at once: the ones
   *  given replace what there was, the others are empty again. */
  function replaceResults(resultsById) {
    state.results = emptyResults(substeps);
    for (const [substepId, result] of Object.entries(resultsById || {})) {
      if (substepId in state.results) state.results[substepId] = { ...emptyResult(), ...result, citations: normalizeCitations(result.citations) };
    }
    changed("steps");
  }

  /** What a substep builds on: the reports of every substep before
   *  it, and its own when it has one (a follow-up question continues on
   *  it), in order. */
  function findingsFor(substepId) {
    const index = substeps.findIndex((s) => s.id === substepId);
    return substeps
      .slice(0, index + 1)
      .map((s) => String(substepResult(s.id).report_text || "").trim())
      .filter(Boolean)
      .join("\n\n");
  }

  function setAsking(substepId) {
    state.asking = String(substepId || "");
    changed("steps");
  }

  function setCaseText(caseText) {
    state.caseText = String(caseText || "").trim();
    changed("steps");
  }

  /** Whether a case has been entered: the first thing the user types is the
   *  case; everything else builds on that. */
  function caseStarted() {
    return Boolean(state.caseText);
  }

  /** The conversation about a substep as text for the model: what the user
   *  typed and what was answered, in order. */
  function conversationFor(substepId) {
    return state.messages
      .filter((m) => m.conversation && m.substepId === substepId && m.text && !m.pending)
      .map((m) => `${m.role === "user" ? "Gebruiker" : "Beleidskompas"}: ${m.text}`)
      .join("\n");
  }

  /** Whether the conversation about a substep went on after its report, so
   *  the report does not reflect that conversation yet. */
  function talkedSinceReport(substepId) {
    const since = substepResult(substepId).updated_at;
    if (!since) return false;
    return state.messages.some((m) => m.conversation && m.substepId === substepId && m.text && m.ts > since);
  }

  function addMessage(role, text, meta) {
    const message = createMessage(role, text, meta);
    state.messages.push(message);
    changed("chat");
    return message;
  }

  function replaceMessages(messages) {
    state.messages = messages.map((m) => createMessage(m.role, m.text, m));
    changed("chat");
  }

  function updateMessage(message, changes) {
    Object.assign(message, changes);
    changed("chat");
  }

  function setLastMessageId(messageId) {
    state.lastMessageId = messageId || null;
  }

  // Also remembered in sessionStorage, so a reload reopens the same case.
  function setConversationId(conversationId) {
    const next = conversationId || null;
    if (next === state.conversationId) return;
    state.conversationId = next;
    try {
      if (conversationId) sessionStorage.setItem(CONVERSATION_STORAGE_KEY, conversationId);
      else sessionStorage.removeItem(CONVERSATION_STORAGE_KEY);
    } catch (_) {
      // Without sessionStorage the case still works, it just won't survive a reload.
    }
    changed("conversation");
  }

  function startNewSession() {
    state.lastMessageId = null;
    state.asking = "";
    state.caseText = "";
    state.results = emptyResults(substeps);
    state.activeSubstep = 0;
    state.messages = [createMessage("assistant", "Nieuwe sessie gestart. Beschrijf je casus en we lopen de stappen samen door.")];
    setConversationId(null);
    changed("chat", "steps");
  }

  return {
    state,
    steps,
    substeps,
    subscribe,
    changed,
    activeSubstep,
    activeStep,
    setActiveSubstep,
    setActiveStep,
    substepResult,
    substepDone,
    stepDone,
    setSubstepResult,
    replaceResults,
    findingsFor,
    setAsking,
    setCaseText,
    caseStarted,
    conversationFor,
    talkedSinceReport,
    addMessage,
    replaceMessages,
    updateMessage,
    setLastMessageId,
    setConversationId,
    startNewSession,
  };
}
