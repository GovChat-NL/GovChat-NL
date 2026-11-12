"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { start } = require("../lib/beleidskompas");

/** An express app that only remembers its routes, and calls one the way
 *  express would. */
function fakeApp() {
  const routes = {};
  const add = (method) => (path, handler) => {
    routes[`${method} ${path}`] = handler;
  };
  async function call(method, path, req) {
    let status = 0;
    let body = null;
    const res = { status: (code) => ((status = code), res), json: (data) => ((body = data), res) };
    await routes[`${method} ${path}`]({ headers: {}, params: {}, query: {}, body: {}, ...req }, res);
    return { status, body };
  }
  return { get: add("GET"), put: add("PUT"), post: add("POST"), call };
}

const silent = { log: () => {}, error: () => {} };
const TOKEN = "store-secret";
const asN8n = { headers: { authorization: `Bearer ${TOKEN}` }, query: { user_id: "user-a" } };

test("without a database host the endpoints answer 503", async () => {
  const app = fakeApp();
  await start(app, {}, { BELEIDSKOMPAS_STORE_TOKEN: TOKEN }, { openPool: () => null, log: silent });
  assert.equal((await app.call("GET", "/api/beleidskompas/cases", asN8n)).status, 503);
});

test("the endpoints answer 503 until the database can be reached, and work after that", async () => {
  const app = fakeApp();
  const pool = { query: async () => ({ rows: [] }) };
  // The first attempt fails; the second reaches the database.
  let attempts = 0;
  const migrate = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("connect ECONNREFUSED");
    return [];
  };
  let releaseWait;
  const wait = () => new Promise((resolve) => (releaseWait = resolve));

  const ready = start(app, {}, { BELEIDSKOMPAS_STORE_TOKEN: TOKEN }, { openPool: () => pool, migrate, wait, log: silent });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await app.call("GET", "/api/beleidskompas/cases", asN8n)).status, 503);

  releaseWait();
  await ready;
  assert.equal((await app.call("GET", "/api/beleidskompas/cases", asN8n)).status, 200);
});

test("once ready, the store deletes cases older than the retention setting", async () => {
  const app = fakeApp();
  const queries = [];
  const pool = { query: async (sql, params) => (queries.push({ sql, params }), { rows: [], rowCount: 2 }) };
  const logs = [];
  const log = { log: (m) => logs.push(m), error: () => {} };
  await start(app, { getRetentionDays: () => 30 }, { BELEIDSKOMPAS_STORE_TOKEN: TOKEN }, { openPool: () => pool, migrate: async () => [], log, sweepIntervalMs: 1e9 });
  const sweep = queries.find((q) => q.sql.startsWith("DELETE FROM cases"));
  assert.deepEqual(sweep.params, [30]);
  assert.ok(logs.some((m) => m.includes("deleted 2 cases older than 30 days")));
});
