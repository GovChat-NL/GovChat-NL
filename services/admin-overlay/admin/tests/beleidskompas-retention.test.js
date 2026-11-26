"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { sweep, retentionDefaults } = require("../lib/beleidskompas/retention/retention");

test("every kind is deleted after its own Bewaartermijn, and the last deletion is kept", async () => {
  const calls = [];
  const previous = { cases: { at: "x", days: 30, deleted: 0, last_deletion: { at: "earlier", days: 30, deleted: 4 } } };
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT")) return { rows: [{ data: previous }] };
    return { rowCount: sql.includes("general_feedback") ? 2 : 0, rows: [] };
  };
  const logs = [];
  const result = await sweep({ query, settings: { retention_days: 30, feedback_retention_days: 365 }, log: { log: (m) => logs.push(m), error: () => {} } });

  assert.deepEqual(retentionDefaults(), { retention_days: 30, feedback_retention_days: 365 });
  assert.deepEqual(calls.find((c) => c.sql.includes("FROM cases")).params, [30]);
  assert.deepEqual(calls.find((c) => c.sql.includes("FROM answer_feedback")).params, [365]);
  assert.equal(result.cases.last_deletion.deleted, 4, "an empty sweep keeps the last deletion");
  assert.deepEqual([result.feedback.deleted, result.feedback.last_deletion.deleted], [2, 2]);
  assert.ok(logs.includes("[govchat-admin] Beleidskompas retention: deleted 2 feedback older than 365 days"));
  assert.match(calls.at(-1).sql, /^INSERT INTO settings/);
});
