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

// A message in the chat. A question the user typed and the answer to it
// carry the substep the user was in (substepId); other messages, like the
// case and the notices of the page, carry none. An answer also says which
// step gave it (agent), which can be another step than the substep's when
// the question was about that step.
function createMessage(role, text, meta = {}) {
  const message = {
    role,
    text: String(text || "").trim(),
    ts: meta.ts || new Date().toISOString(),
    citations: normalizeCitations(meta.citations),
    retrieval_trace: meta.retrieval_trace || null,
    agent: meta.agent ? String(meta.agent) : null,
    substepId: String(meta.substepId || ""),
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
    // askingReport says whether that request asks for the substep's report
    // (otherwise it is a question in the chat).
    asking: "",
    askingReport: false,
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

  /** Puts the reports as the store has them on the cards, all at once:
   *  the ones given replace what there was, the others are empty again. */
  function replaceResults(resultsById) {
    state.results = emptyResults(substeps);
    for (const [substepId, result] of Object.entries(resultsById || {})) {
      if (substepId in state.results) state.results[substepId] = { ...emptyResult(), ...result, citations: normalizeCitations(result.citations) };
    }
    changed("steps");
  }

  function setAsking(substepId, { report = false } = {}) {
    state.asking = String(substepId || "");
    state.askingReport = Boolean(state.asking) && report;
    changed("steps");
  }

  /** Whether the report of this substep is being written right now. */
  function reportUnderWay(substepId) {
    return state.askingReport && state.asking === substepId;
  }

  function setCaseText(caseText) {
    state.caseText = String(caseText || "").trim();
    changed("steps");
  }

  /** Whether the case has begun. On the page the first thing the user
   *  types is the case. A case begun in the LibreChat chat has no case
   *  text, only messages, and may have reports; it has begun too, so what
   *  the user types next is a message and not the case. */
  function caseStarted() {
    return Boolean(state.caseText) || state.messages.some((m) => m.role === "user") || substeps.some((s) => substepDone(s.id));
  }

  /** Whether the conversation about a substep went on after its report, so
   *  the report does not reflect that conversation yet. */
  function talkedSinceReport(substepId) {
    const since = substepResult(substepId).updated_at;
    if (!since) return false;
    return state.messages.some((m) => m.substepId === substepId && m.text && m.ts > since);
  }

  /** Whether the card of a substep shows a different report than before the
   *  request. `before` is the updated_at of the report the card showed then,
   *  or "" when it showed none. */
  function reportArrived(substepId, before) {
    const now = substepResult(substepId).updated_at;
    return Boolean(now) && now !== before;
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
    state.askingReport = false;
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
    replaceResults,
    setAsking,
    reportUnderWay,
    setCaseText,
    caseStarted,
    talkedSinceReport,
    reportArrived,
    addMessage,
    replaceMessages,
    updateMessage,
    setLastMessageId,
    setConversationId,
    startNewSession,
  };
}
