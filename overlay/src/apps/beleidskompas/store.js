// The state of the Beleidskompas screen: the messages, the active step, the
// open conversation and the elaboration per step. Every change goes through
// a method here, which tells the parts of the screen that show it to redraw
// (subscribe/changed), so code that changes the state does not need to know
// which parts show it.

import { normalizeCitations } from "./format.js";

const CONVERSATION_STORAGE_KEY = "gc_bk_conversation_id";

function emptyStepState() {
  return { report_text: "", citations: [], retrieval_trace: null, updated_at: "" };
}

function emptyStepStates(steps) {
  const states = {};
  steps.forEach((s) => {
    states[s.id] = emptyStepState();
  });
  return states;
}

function createMessage(role, text, meta = {}) {
  const message = {
    role,
    text: String(text || "").trim(),
    ts: meta.ts || new Date().toISOString(),
    citations: normalizeCitations(meta.citations),
    retrieval_trace: meta.retrieval_trace || null,
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
  const state = {
    activeStep: 0,
    conversationId: readStoredConversationId(),
    lastMessageId: null,
    messages: [createMessage("assistant", "Hallo! Ik ben je beleidsassistent. Beschrijf je casus en ik help je stap voor stap.")],
    steps: emptyStepStates(steps),
  };

  const listeners = new Map();

  function subscribe(topic, listener) {
    if (!listeners.has(topic)) listeners.set(topic, []);
    listeners.get(topic).push(listener);
  }

  function changed(...topics) {
    topics.forEach((topic) => (listeners.get(topic) || []).forEach((listener) => listener()));
  }

  function activeStep() {
    return steps[state.activeStep] || steps[0];
  }

  function setActiveStep(index) {
    state.activeStep = Math.max(0, Math.min(steps.length - 1, Number(index) || 0));
    changed("steps");
  }

  function stepResult(stepId) {
    return state.steps[stepId] || emptyStepState();
  }

  function stepDone(stepId) {
    return Boolean(String(stepResult(stepId).report_text || "").trim());
  }

  function setStepResult(stepId, result) {
    state.steps[stepId] = { ...emptyStepState(), ...result, citations: normalizeCitations(result.citations) };
    changed("steps");
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
    state.steps = emptyStepStates(steps);
    state.activeStep = 0;
    state.messages = [createMessage("assistant", "Nieuwe sessie gestart. Beschrijf je casus en we lopen de stappen samen door.")];
    setConversationId(null);
    changed("chat", "steps");
  }

  return {
    state,
    steps,
    subscribe,
    changed,
    activeStep,
    setActiveStep,
    stepResult,
    stepDone,
    setStepResult,
    addMessage,
    replaceMessages,
    updateMessage,
    setLastMessageId,
    setConversationId,
    startNewSession,
  };
}
