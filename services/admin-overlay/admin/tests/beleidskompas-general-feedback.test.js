"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGeneralFeedbackHandlers } = require("../lib/beleidskompas/general-feedback");

const NOW = Date.parse("2026-11-24T12:00:00Z");

function setup(stored = []) {
  let items = stored;
  const handlers = createGeneralFeedbackHandlers({ read: () => items.slice(), write: (next) => { items = next; }, retentionDays: 365, now: () => NOW });
  return { handlers, items: () => items };
}

test("general feedback is stored with the e-mail address of the logged-in user", () => {
  const { handlers, items } = setup();
  const res = handlers.submit({ user: { email: "a@example.nl" }, body: { text: "  Knop werkt niet  ", step_id: "stap1", version_id: "7", email: "other@example.nl" } });
  assert.equal(res.status, 201);
  assert.equal(items().length, 1);
  assert.deepEqual({ ...items()[0], id: "" }, { id: "", email: "a@example.nl", text: "Knop werkt niet", step_id: "stap1", version_id: "7", created_at: "2026-11-24T12:00:00.000Z" });
});

test("it refuses a sender who is not logged in, has no e-mail address, or sends no text", () => {
  const { handlers, items } = setup();
  assert.equal(handlers.submit({ user: null, body: { text: "x" } }).status, 401);
  assert.equal(handlers.submit({ user: { email: "" }, body: { text: "x" } }).status, 400);
  assert.equal(handlers.submit({ user: { email: "a@example.nl" }, body: { text: "   " } }).status, 400);
  assert.equal(items().length, 0);
});

test("items past the retention period are dropped; the list is newest first", () => {
  const { handlers, items } = setup([
    { id: "old", email: "a@example.nl", text: "oud", created_at: "2025-11-01T00:00:00.000Z" },
    { id: "kept", email: "a@example.nl", text: "recent", created_at: "2026-11-01T00:00:00.000Z" },
  ]);
  handlers.submit({ user: { email: "b@example.nl" }, body: { text: "nieuw" } });
  assert.deepEqual(items().map((i) => i.text), ["recent", "nieuw"]);
  assert.deepEqual(handlers.list().body.items.map((i) => i.text), ["nieuw", "recent"]);
});
