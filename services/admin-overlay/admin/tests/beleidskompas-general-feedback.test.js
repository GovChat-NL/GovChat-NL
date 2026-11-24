"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGeneralFeedbackHandlers, librechatUserFromBearer } = require("../lib/beleidskompas/general-feedback");

test("the sender's e-mail comes from LibreChat; no valid token is no user, a LibreChat failure throws", async () => {
  const calls = [];
  const answering = (status, body = {}) => async (url, init) => (calls.push([url, init.headers.authorization]), { status, ok: status < 300, json: async () => body });
  const req = { headers: { authorization: "Bearer tok" } };
  assert.deepEqual(await librechatUserFromBearer(req, { baseUrl: "http://lc", fetchImpl: answering(200, { email: " a@example.nl " }) }), { email: "a@example.nl" });
  assert.deepEqual(calls[0], ["http://lc/api/user", "Bearer tok"]);
  assert.equal(await librechatUserFromBearer(req, { baseUrl: "http://lc", fetchImpl: answering(401) }), null);
  assert.equal(await librechatUserFromBearer({ headers: {} }, { baseUrl: "http://lc", fetchImpl: answering(200) }), null);
  await assert.rejects(librechatUserFromBearer(req, { baseUrl: "http://lc", fetchImpl: answering(502) }), /502/);
});

/** A query function that records every call and answers `rows`. */
function fakeQuery(rows = []) {
  const calls = [];
  const query = async (sql, params) => (calls.push({ sql, params }), { rows });
  return { calls, query };
}

test("general feedback is stored with the e-mail address of the logged-in user, after purging old items", async () => {
  const { calls, query } = fakeQuery();
  const handlers = createGeneralFeedbackHandlers({ getQuery: () => query, retentionDays: 365 });
  const res = await handlers.submit({ user: { email: "a@example.nl" }, body: { text: "  Knop werkt niet  ", email: "other@example.nl" } });
  assert.equal(res.status, 201);
  assert.match(calls[0].sql, /^DELETE FROM general_feedback/);
  assert.deepEqual(calls[0].params, [365]);
  assert.match(calls[1].sql, /^INSERT INTO general_feedback/);
  assert.deepEqual(calls[1].params, ["a@example.nl", "Knop werkt niet"]);
});

test("it refuses a sender who is not logged in, has no e-mail address, or sends no text, without touching the database", async () => {
  const { calls, query } = fakeQuery();
  const handlers = createGeneralFeedbackHandlers({ getQuery: () => query });
  assert.equal((await handlers.submit({ user: null, body: { text: "x" } })).status, 401);
  assert.equal((await handlers.submit({ user: { email: "" }, body: { text: "x" } })).status, 400);
  assert.equal((await handlers.submit({ user: { email: "a@example.nl" }, body: { text: "   " } })).status, 400);
  assert.equal(calls.length, 0);
});

test("the list gives the stored items with ISO dates", async () => {
  const { query } = fakeQuery([{ id: "2", email: "a@example.nl", text: "nieuw", created_at: new Date("2026-11-24T12:00:00Z") }]);
  const handlers = createGeneralFeedbackHandlers({ getQuery: () => query });
  const res = await handlers.list();
  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].created_at, "2026-11-24T12:00:00.000Z");
});
