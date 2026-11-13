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
  await start(app, { pool: null }, { BELEIDSKOMPAS_STORE_TOKEN: TOKEN }, { log: silent }).ready;
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

  const { ready } = start(app, { pool }, { BELEIDSKOMPAS_STORE_TOKEN: TOKEN }, { migrate, wait, log: silent });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await app.call("GET", "/api/beleidskompas/cases", asN8n)).status, 503);

  releaseWait();
  await ready;
  assert.equal((await app.call("GET", "/api/beleidskompas/cases", asN8n)).status, 200);
});

test("the admin endpoints answer 503 until init has run, and init gets the template store", async () => {
  const app = fakeApp();
  const use = [];
  app.use = (...args) => use.push(args);
  const pool = { query: async () => ({ rows: [] }) };
  let initArgs = null;
  const init = async (args) => { initArgs = args; };
  const flow = {};
  const requireAuth = () => {};

  const { ready, templates } = start(app, { pool, requireAuth, flow, init }, { BELEIDSKOMPAS_STORE_TOKEN: TOKEN }, { migrate: async () => [], log: silent });
  assert.equal(use.length, 1, "the admin router is mounted once");
  assert.equal(use[0][0], "/api/beleidskompas");
  const [gate] = [use[0][1]];
  const answer = () => { let out = {}; const res = { status: (c) => ((out.status = c), res), json: (b) => ((out.body = b), res) }; let passed = false; gate({}, res, () => (passed = true)); return { ...out, passed }; };

  assert.equal(answer().status, 503);
  await assert.rejects(async () => templates.getLive(), (err) => err.status === 503);
  await ready;
  assert.ok(initArgs && typeof initArgs.store.listTemplates === "function" && typeof initArgs.db.transaction === "function");
  assert.equal(answer().passed, true);
});

test("a failing init leaves the admin endpoints at 503 and does not reject", async () => {
  const app = fakeApp();
  const use = [];
  app.use = (...args) => use.push(args);
  const pool = { query: async () => ({ rows: [] }) };
  const init = async () => { throw new Error("seed failed"); };
  const { ready } = start(app, { pool, requireAuth: () => {}, flow: {}, init }, {}, { migrate: async () => [], log: silent });
  await ready;
  let status = 0;
  use[0][1]({}, { status: (c) => ((status = c), { json: () => {} }) }, () => {});
  assert.equal(status, 503);
});
