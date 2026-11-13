"use strict";

/**
 * Starts Beleidskompas in the admin service: runs the migrations on `pool` and
 * mounts the endpoints on `app`. The service opens the pool (openPool in
 * db/connection.js) and passes it in; without a pool (null) there is no database. There are two stores on the
 * one database: the cases (case-store.js, for n8n and the page) and the
 * templates (template-store.js, for the admin). `resolveUser(req)` is the
 * service's own check of the LibreChat login, for the endpoints the page
 * reads. `requireAuth` and `flow` are for the admin endpoints, which are
 * mounted when they are given (see admin-routes.js). `init({ store, db })`
 * runs once the migrations are done and before the admin endpoints open: it
 * fills the template tables when they are empty.
 *
 * Beleidskompas is one of the apps this service runs, so its database never
 * holds up the rest: the help, the start page, the crawler and the
 * transcription keep working without it. The endpoints are mounted at once
 * and answer 503 until the stores are ready; the orchestrator then tells the
 * user that Beleidskompas cannot use its store.
 *
 * Without BELEIDSKOMPAS_DB_HOST there is no database and the endpoints
 * always answer 503. With a host, start keeps trying to reach the database
 * and run the migrations, waiting longer after each failure (up to a
 * minute), and logs every failure. A failing migration is retried the same
 * way: it is rolled back each time, so the store never runs on a broken
 * schema.
 *
 * Returns `{ ready, templates }`. `ready` is a promise for the case store once
 * everything is ready, or for null without a host. It never rejects: a
 * failing `init` is logged and leaves the admin endpoints at 503. `templates`
 * is the template store for the rest of the service; like the endpoints it
 * answers 503 until the database is ready. `deps` lets the tests replace the
 * pool, the waiting and the log.
 */

const db = require("../../db/connection");
const { createCaseStore } = require("./case-store");
const { createTemplateStore } = require("./template-store");
const { StoreError } = require("./store-errors");
const routes = require("./routes/case-routes");

// How long to wait before the next attempt to reach the database: after the
// first failure, the second, and so on. The last one repeats.
const RETRY_DELAYS_MS = [2000, 5000, 10000, 30000, 60000];

const CASE_STORE_FUNCTIONS = ["ensureCase", "setCaseText", "addReport", "addTurn", "setTitle", "getState", "listCases"];
const TEMPLATE_STORE_FUNCTIONS = [
  "listTemplates", "getCurrent", "createTemplate", "saveVersion", "upsertDocument", "listDocuments", "getDocument",
  "renameDocument", "getLive", "setLive", "getSettings", "saveSettings", "importLegacyState",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stands in for a store until the database is ready. Every function
 *  passes the call on to the real store, or answers 503 while there is
 *  none yet. */
function waitingStore(names, current) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      (...args) => {
        const store = current();
        if (!store) throw new StoreError(503, "Beleidskompas store is not available");
        return store[name](...args);
      },
    ]),
  );
}

/** Tries to run the migrations until it succeeds. */
async function connect(pool, { migrate, wait, log, delays }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const applied = await migrate(pool);
      log.log(`[govchat-admin] Beleidskompas store ready (migrations applied: ${applied.length ? applied.join(", ") : "none"})`);
      return;
    } catch (err) {
      const delay = delays[Math.min(attempt - 1, delays.length - 1)];
      log.error(
        `[govchat-admin] Beleidskompas store not available (attempt ${attempt}): ${err.message}. Trying again in ${Math.round(delay / 1000)} s.`,
      );
      await wait(delay);
    }
  }
}

function start(app, { pool, resolveUser, requireAuth, flow, init } = {}, env = process.env, deps = {}) {
  const { migrate = db.migrate, wait = sleep, log = console, delays = RETRY_DELAYS_MS } = deps;
  const internalToken = String(env.BELEIDSKOMPAS_STORE_TOKEN || "").trim();
  let caseStore = null;
  let templateStore = null;
  let adminReady = false;
  const templates = waitingStore(TEMPLATE_STORE_FUNCTIONS, () => templateStore);

  routes.mount(app, { store: pool ? waitingStore(CASE_STORE_FUNCTIONS, () => caseStore) : null, internalToken, resolveUser });
  if (requireAuth && flow) {
    // Loaded here, so the rest of this file (and its tests) load without express.
    const { createAdminRouter } = require("./routes/admin-routes");
    const notReady = (req, res, next) =>
      adminReady ? next() : res.status(503).json({ error: "Beleidskompas database is nog niet beschikbaar" });
    app.use("/api/beleidskompas", notReady, createAdminRouter({ store: templates, requireAuth, flow }));
  }

  if (!pool) {
    log.log("[govchat-admin] Beleidskompas store disabled (BELEIDSKOMPAS_DB_HOST not set)");
    return { ready: Promise.resolve(null), templates };
  }

  const ready = connect(pool, { migrate, wait, log, delays }).then(async () => {
    caseStore = createCaseStore((sql, params) => pool.query(sql, params));
    const database = { query: (sql, params) => pool.query(sql, params), transaction: (fn) => db.transaction(pool, fn) };
    templateStore = createTemplateStore(database);
    try {
      if (init) await init({ store: templateStore, db: database });
      adminReady = true;
    } catch (err) {
      log.error(`[govchat-admin] Beleidskompas templates could not be initialised: ${err.message}`);
    }
    return caseStore;
  });
  return { ready, templates };
}

module.exports = { start };
