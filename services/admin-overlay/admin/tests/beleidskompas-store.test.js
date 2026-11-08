"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { StoreError, createStore } = require("../lib/beleidskompas/store");

/** A stand-in for the database: answers each query from `answers`, keyed by
 *  a fragment of the SQL, and records every call. Whether the SQL itself is
 *  right is checked against a real Postgres in beleidskompas-db.test.js. */
function fakeDatabase(answers) {
  const calls = [];
  async function query(sql, params) {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    const key = Object.keys(answers).find((fragment) => sql.includes(fragment));
    const answer = key ? answers[key] : [];
    return { rows: typeof answer === "function" ? answer(params) : answer };
  }
  return { query, calls };
}

const CASE = { id: "conv-1", user_id: "user-a", title: null, created_at: "t0", updated_at: "t0" };

/** Answers the owner lookup like the database would: the row only when the
 *  user matches. */
function ownedBy(row) {
  return (params) => (params[1] === row.user_id ? [row] : []);
}

test("ensureCase creates the case once and returns it", async () => {
  const db = fakeDatabase({ "FROM cases WHERE id": ownedBy(CASE) });
  const row = await createStore(db.query).ensureCase({ id: " conv-1 ", userId: "user-a" });
  assert.equal(row.id, "conv-1");
  assert.match(db.calls[0].sql, /INSERT INTO cases .* ON CONFLICT \(id\) DO NOTHING/);
  assert.deepEqual(db.calls[0].params, ["conv-1", "user-a"]);
});

test("a case id taken by another user cannot be written to, and reads as unknown", async () => {
  const db = fakeDatabase({ "FROM cases WHERE id": ownedBy(CASE) });
  const store = createStore(db.query);
  await assert.rejects(store.ensureCase({ id: "conv-1", userId: "user-b" }), (err) => err instanceof StoreError && err.status === 403);
  await assert.rejects(store.addReport({ caseId: "conv-1", userId: "user-b", substepId: "1.1", content: {}, text: "x" }), (err) => err.status === 403);
  await assert.rejects(store.addTurn({ caseId: "conv-1", userId: "user-b", role: "user", text: "hoi" }), (err) => err.status === 403);
  await assert.rejects(store.setTitle({ caseId: "conv-1", userId: "user-b", title: "x" }), (err) => err.status === 404);
  assert.equal(await store.getState({ caseId: "conv-1", userId: "user-b" }), null);
  // The lookup itself filters on the user, so the database never hands out another user's row.
  assert.ok(db.calls.every((c) => !c.sql.includes("FROM cases WHERE id") || c.params[1] === "user-b"));
});

test("setCaseText adds a version, but not when the text equals the newest version", async () => {
  const db = fakeDatabase({
    "FROM cases WHERE id": ownedBy(CASE),
    "SELECT version, text FROM case_texts": [{ version: 2, text: "De casus." }],
    "INSERT INTO case_texts": [{ version: 3 }],
  });
  const store = createStore(db.query);
  assert.deepEqual(await store.setCaseText({ caseId: "conv-1", userId: "user-a", text: "  De casus.  " }), { version: 2, unchanged: true });
  assert.ok(!db.calls.some((c) => c.sql.startsWith("INSERT INTO case_texts")));

  assert.deepEqual(await store.setCaseText({ caseId: "conv-1", userId: "user-a", text: "Een andere casus." }), { version: 3, unchanged: false });
  const insert = db.calls.find((c) => c.sql.startsWith("INSERT INTO case_texts"));
  assert.match(insert.sql, /COALESCE\(MAX\(version\), 0\) \+ 1/);
  assert.deepEqual(insert.params, ["conv-1", "Een andere casus."]);
  assert.ok(db.calls.some((c) => c.sql.startsWith("UPDATE cases SET updated_at")));
});

test("addReport stores the structured content, the rendered text and the citations as a new version", async () => {
  const db = fakeDatabase({ "FROM cases WHERE id": ownedBy(CASE), "INSERT INTO reports": [{ version: 1 }] });
  const store = createStore(db.query);
  const result = await store.addReport({
    caseId: "conv-1",
    userId: "user-a",
    substepId: "1.1",
    content: { substeps: { "1.1": { probleem: "x" } } },
    text: "**Stap 1**",
    citations: [{ id: "doc-1" }],
    retrievalTrace: { algorithm: "needle" },
  });
  assert.deepEqual(result, { version: 1 });
  const insert = db.calls.find((c) => c.sql.startsWith("INSERT INTO reports"));
  assert.deepEqual(insert.params, ["conv-1", "1.1", JSON.stringify({ substeps: { "1.1": { probleem: "x" } } }), "**Stap 1**", JSON.stringify([{ id: "doc-1" }]), JSON.stringify({ algorithm: "needle" })]);
  await assert.rejects(store.addReport({ caseId: "conv-1", userId: "user-a", substepId: "1.1", content: "geen object", text: "x" }), (err) => err.status === 400);
});

test("an insert that collides on the version number is tried once more", async () => {
  let attempts = 0;
  const db = fakeDatabase({
    "FROM cases WHERE id": ownedBy(CASE),
    "INSERT INTO reports": () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      return [{ version: 2 }];
    },
  });
  assert.deepEqual(await createStore(db.query).addReport({ caseId: "conv-1", userId: "user-a", substepId: "1.1", content: {}, text: "x" }), { version: 2 });
  assert.equal(attempts, 2);
});

test("addTurn numbers the turns, creates the case when needed, and only accepts user and assistant", async () => {
  const db = fakeDatabase({ "FROM cases WHERE id": ownedBy(CASE), "INSERT INTO conversation_turns": [{ seq: 4 }] });
  const store = createStore(db.query);
  assert.deepEqual(await store.addTurn({ caseId: "conv-1", userId: "user-a", role: "assistant", stepId: "stap3", askedFrom: "1.3", text: "Antwoord." }), { seq: 4 });
  assert.match(db.calls[0].sql, /INSERT INTO cases .* ON CONFLICT \(id\) DO NOTHING/);
  const insert = db.calls.find((c) => c.sql.startsWith("INSERT INTO conversation_turns"));
  assert.deepEqual(insert.params, ["conv-1", "assistant", "stap3", "1.3", "Antwoord."]);
  await assert.rejects(store.addTurn({ caseId: "conv-1", userId: "user-a", role: "system", text: "x" }), (err) => err.status === 400);
});

test("getState puts the newest case text, the newest report per substep and the turns together", async () => {
  const db = fakeDatabase({
    "FROM cases WHERE id": ownedBy({ ...CASE, title: "Beleidskompas - Laadpalen" }),
    "FROM case_texts": [{ version: 2, text: "De casus.", created_at: "t1" }],
    "FROM reports": [
      { substep_id: "1.1", version: 3, content: { a: 1 }, text: "Rapport 1.1", citations: [], retrieval_trace: null, created_at: "t2" },
      { substep_id: "1.2", version: 1, content: { b: 2 }, text: "Rapport 1.2", citations: [{ id: "d" }], retrieval_trace: { x: 1 }, created_at: "t3" },
    ],
    "FROM conversation_turns": [
      { seq: 1, role: "user", step_id: null, asked_from: "1.1", text: "Vraag", created_at: "t4" },
      { seq: 2, role: "assistant", step_id: "stap3", asked_from: "1.1", text: "Antwoord", created_at: "t5" },
    ],
  });
  const state = await createStore(db.query).getState({ caseId: "conv-1", userId: "user-a", maxTurns: 50 });
  assert.equal(state.title, "Beleidskompas - Laadpalen");
  assert.deepEqual(state.case_text, { version: 2, text: "De casus.", created_at: "t1" });
  assert.deepEqual(Object.keys(state.reports), ["1.1", "1.2"]);
  assert.equal(state.reports["1.1"].version, 3);
  assert.deepEqual(state.reports["1.2"].citations, [{ id: "d" }]);
  assert.deepEqual(state.turns.map((t) => [t.seq, t.role, t.step_id]), [[1, "user", null], [2, "assistant", "stap3"]]);
  const turnsQuery = db.calls.find((c) => c.sql.includes("FROM conversation_turns"));
  assert.deepEqual(turnsQuery.params, ["conv-1", 50]);
});

test("listCases returns the cases of one user, newest first, with a capped limit", async () => {
  const db = fakeDatabase({ "FROM cases WHERE user_id": [{ id: "conv-2", title: null, created_at: "t", updated_at: "t" }] });
  const cases = await createStore(db.query).listCases({ userId: "user-a", limit: 1000 });
  assert.deepEqual(cases, [{ id: "conv-2", title: null, created_at: "t", updated_at: "t" }]);
  assert.deepEqual(db.calls[0].params, ["user-a", 200]);
});
