// Unit tests for store.js. Run with `node --test` in this folder (or
// `make test-beleidskompas` from the repository root).

import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../store.js";

const STEPS = [
  { id: "stap1", nr: 1, title: "Een", substeps: [{ id: "1.1", title: "A" }, { id: "1.2", title: "B" }] },
  { id: "stap2", nr: 2, title: "Twee", substeps: [{ id: "2.1", title: "C" }] },
];

// A stand-in for the browser's sessionStorage, so the tests can check what the
// store remembers between page loads.
function withSessionStorage(run) {
  const items = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
  try {
    return run(items);
  } finally {
    delete globalThis.sessionStorage;
  }
}

test("every change tells exactly the panels that show it", () => {
  const store = createStore(STEPS);
  const seen = [];
  for (const topic of ["chat", "steps", "conversation"]) store.subscribe(topic, () => seen.push(topic));

  const message = store.addMessage("assistant", "", { pending: true });
  store.updateMessage(message, { text: "klaar", pending: false });
  store.replaceMessages([{ role: "user", text: "x" }]);
  assert.deepEqual(seen.splice(0), ["chat", "chat", "chat"]);

  store.setActiveSubstep(1);
  store.setSubstepResult("1.2", { report_text: "uitwerking" });
  assert.deepEqual(seen.splice(0), ["steps", "steps"]);

  store.setConversationId("abc");
  store.setConversationId("abc");
  assert.deepEqual(seen.splice(0), ["conversation"]);

  store.startNewSession();
  assert.deepEqual(seen.sort(), ["chat", "conversation", "steps"]);
});

test("the substeps are walked in the order of the steps, and a step opens at its first substep", () => {
  const store = createStore(STEPS);
  assert.deepEqual(store.substeps.map((s) => s.id), ["1.1", "1.2", "2.1"]);
  assert.equal(store.substeps[2].step.id, "stap2");

  store.setActiveSubstep(2);
  assert.equal(store.activeSubstep().id, "2.1");
  assert.equal(store.activeStep().id, "stap2");

  store.setActiveStep(0);
  assert.equal(store.activeSubstep().id, "1.1");

  store.setActiveSubstep(99);
  assert.equal(store.activeSubstep().id, "2.1");
});

test("a substep counts as done once it has a non-empty report, a step once all its substeps are", () => {
  const store = createStore(STEPS);
  assert.equal(store.substepDone("1.1"), false);
  assert.equal(store.stepDone("stap1"), false);

  store.setSubstepResult("1.1", { report_text: "uitwerking", citations: [{ id: "a" }] });
  assert.equal(store.substepDone("1.1"), true);
  assert.equal(store.stepDone("stap1"), false);
  assert.equal(store.substepResult("1.1").citations[0].rank, 1);
  assert.equal(store.substepResult("1.1").retrieval_trace, null);

  store.setSubstepResult("1.2", { report_text: "ook" });
  assert.equal(store.stepDone("stap1"), true);
  assert.equal(store.stepDone("stap2"), false);

  store.setSubstepResult("1.1", { report_text: "   " });
  assert.equal(store.substepDone("1.1"), false);
  assert.equal(store.stepDone("stap1"), false);
});

test("the findings for a substep are the reports before it and its own, in order", () => {
  const store = createStore(STEPS);
  store.setSubstepResult("1.1", { report_text: "een" });
  store.setSubstepResult("2.1", { report_text: "drie" });

  assert.equal(store.findingsFor("1.1"), "een");
  assert.equal(store.findingsFor("1.2"), "een");
  assert.equal(store.findingsFor("2.1"), "een\n\ndrie");

  store.setSubstepResult("1.2", { report_text: "twee" });
  assert.equal(store.findingsFor("2.1"), "een\n\ntwee\n\ndrie");
});

test("the open case is remembered in sessionStorage, so a new store after a reload picks it up", () => {
  withSessionStorage((items) => {
    createStore(STEPS).setConversationId("abc-123");
    assert.equal(items.get("gc_bk_conversation_id"), "abc-123");
    assert.equal(createStore(STEPS).state.conversationId, "abc-123");

    createStore(STEPS).setConversationId(null);
    assert.equal(items.has("gc_bk_conversation_id"), false);
    assert.equal(createStore(STEPS).state.conversationId, null);
  });
  // Without sessionStorage the case still works, it just won't survive a reload.
  assert.doesNotThrow(() => createStore(STEPS).setConversationId("abc-123"));
});

test("startNewSession forgets the case and starts again at the first substep", () => {
  withSessionStorage((items) => {
    const store = createStore(STEPS);
    store.setConversationId("abc-123");
    store.setLastMessageId("msg-9");
    store.setActiveSubstep(2);
    store.setSubstepResult("1.1", { report_text: "klaar" });
    store.addMessage("user", "mijn casus");

    store.startNewSession();

    assert.equal(store.state.conversationId, null);
    assert.equal(items.has("gc_bk_conversation_id"), false);
    assert.equal(store.state.lastMessageId, null);
    assert.equal(store.activeSubstep().id, "1.1");
    assert.equal(store.substepDone("1.1"), false);
    assert.equal(store.state.messages.length, 1);
    assert.equal(store.state.messages[0].role, "assistant");
  });
});
