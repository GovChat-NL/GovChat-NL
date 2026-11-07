"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createBeleidskompasHandlers } = require("../lib/beleidskompas/routes");
const { StoreError } = require("../lib/beleidskompas/store");

/** A store that records what it was asked and answers what the test says. */
function fakeStore(answers = {}) {
  const calls = [];
  const make = (name) => async (args) => {
    calls.push({ name, args });
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(args) : answer;
  };
  return { calls, listCases: make("listCases"), getState: make("getState"), setCaseText: make("setCaseText"), setTitle: make("setTitle"), addReport: make("addReport"), addTurn: make("addTurn") };
}

const TOKEN = "store-secret";
const withToken = (req) => ({ headers: { authorization: `Bearer ${TOKEN}` }, params: {}, query: {}, body: {}, ...req });

test("every endpoint needs the store token, as bearer or in x-govchat-token", async () => {
  const handlers = createBeleidskompasHandlers({ store: fakeStore({ listCases: [] }), internalToken: TOKEN });
  assert.equal((await handlers.listCases({ headers: {}, query: { user_id: "u" } })).status, 401);
  assert.equal((await handlers.listCases({ headers: { authorization: "Bearer wrong" }, query: { user_id: "u" } })).status, 401);
  assert.equal((await handlers.listCases({ headers: { "x-govchat-token": TOKEN }, query: { user_id: "u" } })).status, 200);
  assert.equal((await handlers.listCases(withToken({ query: { user_id: "u" } }))).status, 200);
});

test("without a store or a token the endpoints answer 503, not 401", async () => {
  const noStore = createBeleidskompasHandlers({ store: null, internalToken: TOKEN });
  assert.equal((await noStore.listCases(withToken({}))).status, 503);
  const noToken = createBeleidskompasHandlers({ store: fakeStore(), internalToken: "" });
  assert.equal((await noToken.listCases(withToken({}))).status, 503);
});

test("getCase passes the case, the user from the query and the turn limit to the store, and answers 404 for no case", async () => {
  const store = fakeStore({ getState: (args) => (args.caseId === "conv-1" ? { id: "conv-1", reports: {} } : null) });
  const handlers = createBeleidskompasHandlers({ store, internalToken: TOKEN });
  const found = await handlers.getCase(withToken({ params: { id: "conv-1" }, query: { user_id: "user-a", max_turns: "20" } }));
  assert.deepEqual(found, { status: 200, body: { id: "conv-1", reports: {} } });
  assert.deepEqual(store.calls[0], { name: "getState", args: { caseId: "conv-1", userId: "user-a", maxTurns: "20" } });
  const missing = await handlers.getCase(withToken({ params: { id: "conv-9" }, query: { user_id: "user-a" } }));
  assert.deepEqual(missing, { status: 404, body: { error: "Unknown case" } });
});

test("the writes take the user and the fields from the body", async () => {
  const store = fakeStore({ setCaseText: { version: 1, unchanged: false }, addReport: { version: 2 }, addTurn: { seq: 3 }, setTitle: undefined });
  const handlers = createBeleidskompasHandlers({ store, internalToken: TOKEN });

  assert.deepEqual(await handlers.setText(withToken({ params: { id: "conv-1" }, body: { user_id: "user-a", text: "De casus." } })), { status: 200, body: { version: 1, unchanged: false } });
  assert.deepEqual(store.calls[0].args, { caseId: "conv-1", userId: "user-a", text: "De casus." });

  const report = await handlers.addReport(withToken({ params: { id: "conv-1" }, body: { user_id: "user-a", substep_id: "1.1", content: { a: 1 }, text: "Rapport", citations: [{ id: "d" }], retrieval_trace: { x: 1 } } }));
  assert.deepEqual(report, { status: 200, body: { version: 2 } });
  assert.deepEqual(store.calls[1].args, { caseId: "conv-1", userId: "user-a", substepId: "1.1", content: { a: 1 }, text: "Rapport", citations: [{ id: "d" }], retrievalTrace: { x: 1 } });

  const turn = await handlers.addTurn(withToken({ params: { id: "conv-1" }, body: { user_id: "user-a", role: "assistant", step_id: "stap3", asked_from: "1.1", text: "Antwoord" } }));
  assert.deepEqual(turn, { status: 200, body: { seq: 3 } });
  assert.deepEqual(store.calls[2].args, { caseId: "conv-1", userId: "user-a", role: "assistant", stepId: "stap3", askedFrom: "1.1", text: "Antwoord" });

  assert.deepEqual(await handlers.setTitle(withToken({ params: { id: "conv-1" }, body: { user_id: "user-a", title: "Laadpalen" } })), { status: 200, body: { ok: true } });
});

test("a StoreError becomes its status, any other error a 500 without details", async () => {
  const handlers = createBeleidskompasHandlers({
    store: fakeStore({ addReport: new StoreError(400, "report text is required"), addTurn: new Error("connection refused: secret host") }),
    internalToken: TOKEN,
  });
  assert.deepEqual(await handlers.addReport(withToken({ params: { id: "conv-1" }, body: { user_id: "u" } })), { status: 400, body: { error: "report text is required" } });
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await handlers.addTurn(withToken({ params: { id: "conv-1" }, body: { user_id: "u", role: "user", text: "x" } })), { status: 500, body: { error: "Beleidskompas store error" } });
  } finally {
    console.error = original;
  }
});
