"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAnswerFeedbackHandlers } = require("../lib/beleidskompas/answer-feedback");

/** A query function that records every call and answers `rows`. */
function fakeQuery(rows = []) {
  const calls = [];
  const query = async (sql, params) => (calls.push({ sql, params }), { rows });
  return { calls, query };
}

test("answer feedback is stored anonymously and only the newest items are kept", async () => {
  const { calls, query } = fakeQuery();
  const handlers = createAnswerFeedbackHandlers({ getQuery: () => query, max: 500 });
  const res = await handlers.submit({ body: { rating: "UP", comment: " Helder ", step_id: "stap2", substep_id: "2.1", version_id: "7", email: "a@example.nl" } });
  assert.equal(res.status, 201);
  assert.match(calls[0].sql, /^INSERT INTO answer_feedback/);
  assert.deepEqual(calls[0].params, ["up", "Helder", "stap2", "2.1", "7"]);
  assert.match(calls[1].sql, /^DELETE FROM answer_feedback/);
  assert.deepEqual(calls[1].params, [500]);
});

test("a rating other than up or down is refused without touching the database", async () => {
  const { calls, query } = fakeQuery();
  const handlers = createAnswerFeedbackHandlers({ getQuery: () => query });
  assert.equal((await handlers.submit({ body: { rating: "meh" } })).status, 400);
  assert.equal(calls.length, 0);
});

test("without a database both endpoints answer 503", async () => {
  const handlers = createAnswerFeedbackHandlers({ getQuery: () => null });
  assert.equal((await handlers.submit({ body: { rating: "up" } })).status, 503);
  assert.equal((await handlers.list()).status, 503);
});

test("the list gives the items newest first with ISO dates and the totals", async () => {
  const at = new Date("2026-11-24T12:00:00Z");
  const { query } = fakeQuery([
    { id: "2", rating: "down", comment: "", step_id: "stap1", substep_id: "", version_id: "7", created_at: at },
    { id: "1", rating: "up", comment: "", step_id: "stap1", substep_id: "", version_id: "7", created_at: at },
  ]);
  const res = await createAnswerFeedbackHandlers({ getQuery: () => query }).list();
  assert.equal(res.body.items[0].created_at, "2026-11-24T12:00:00.000Z");
  assert.deepEqual(res.body.totals, { total: 2, up: 1, down: 1 });
});
