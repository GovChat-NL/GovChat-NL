"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGeneralFeedbackHandlers } = require("../lib/beleidskompas/general-feedback");

/** A query function that records every call and answers `rows`. */
function fakeQuery(rows = []) {
  const calls = [];
  const query = async (sql, params) => (calls.push({ sql, params }), { rows });
  return { calls, query };
}

test("general feedback is stored with the e-mail address of the logged-in user, after purging old items", async () => {
  const { calls, query } = fakeQuery();
  const handlers = createGeneralFeedbackHandlers({ getQuery: () => query, retentionDays: 365 });
  const res = await handlers.submit({ user: { email: "a@example.nl" }, body: { text: "  Knop werkt niet  ", step_id: "stap1", version_id: "7", email: "other@example.nl" } });
  assert.equal(res.status, 201);
  assert.match(calls[0].sql, /^DELETE FROM general_feedback/);
  assert.deepEqual(calls[0].params, [365]);
  assert.match(calls[1].sql, /^INSERT INTO general_feedback/);
  assert.deepEqual(calls[1].params, ["a@example.nl", "Knop werkt niet", "stap1", "7"]);
});

test("it refuses a sender who is not logged in, has no e-mail address, or sends no text, without touching the database", async () => {
  const { calls, query } = fakeQuery();
  const handlers = createGeneralFeedbackHandlers({ getQuery: () => query });
  assert.equal((await handlers.submit({ user: null, body: { text: "x" } })).status, 401);
  assert.equal((await handlers.submit({ user: { email: "" }, body: { text: "x" } })).status, 400);
  assert.equal((await handlers.submit({ user: { email: "a@example.nl" }, body: { text: "   " } })).status, 400);
  assert.equal(calls.length, 0);
});

test("without a database both endpoints answer 503", async () => {
  const handlers = createGeneralFeedbackHandlers({ getQuery: () => null });
  assert.equal((await handlers.submit({ user: { email: "a@example.nl" }, body: { text: "x" } })).status, 503);
  assert.equal((await handlers.list()).status, 503);
});

test("the list gives the stored items with ISO dates", async () => {
  const { query } = fakeQuery([{ id: "2", email: "a@example.nl", text: "nieuw", step_id: "", version_id: "", created_at: new Date("2026-11-24T12:00:00Z") }]);
  const handlers = createGeneralFeedbackHandlers({ getQuery: () => query });
  const res = await handlers.list();
  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].created_at, "2026-11-24T12:00:00.000Z");
});
