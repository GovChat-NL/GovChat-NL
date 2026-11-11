"use strict";

/**
 * Starts the Beleidskompas store in the admin service: mounts the endpoints
 * on `app`, opens the database and runs the migrations. `resolveUser(req)`
 * is the service's own check of the LibreChat login, for the endpoints the
 * page reads.
 *
 * Beleidskompas is one of the apps this service runs, so its database never
 * holds up the rest: the help, the start page, the crawler and the
 * transcription keep working without it. The endpoints are mounted at once
 * and answer 503 until the store is ready; the orchestrator then tells the
 * user that Beleidskompas cannot use its store.
 *
 * Without BELEIDSKOMPAS_DB_HOST there is no database and the endpoints
 * always answer 503. With a host, start keeps trying to reach the database
 * and run the migrations, waiting longer after each failure (up to a
 * minute), and logs every failure. A failing migration is retried the same
 * way: it is rolled back each time, so the store never runs on a broken
 * schema.
 *
 * Returns a promise for the store once it is ready, or for null without a
 * host. The promise never rejects. `deps` lets the tests replace the
 * database, the waiting and the log.
 */

const db = require("../../db/connection");
const { createStore, StoreError } = require("./store");
const routes = require("./routes");

// How long to wait before the next attempt to reach the database: after the
// first failure, the second, and so on. The last one repeats.
const RETRY_DELAYS_MS = [2000, 5000, 10000, 30000, 60000];

const STORE_FUNCTIONS = ["ensureCase", "setCaseText", "addReport", "addTurn", "setTitle", "getState", "listCases"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stands in for the store until the database is ready. Every function
 *  passes the call on to the real store, or answers 503 while there is
 *  none yet. */
function waitingStore(current) {
  return Object.fromEntries(
    STORE_FUNCTIONS.map((name) => [
      name,
      (...args) => {
        const store = current();
        if (!store) throw new StoreError(503, "Beleidskompas store is not available");
        return store[name](...args);
      },
    ]),
  );
}

/** Tries to run the migrations until it succeeds, and then returns the store. */
async function connect(pool, { migrate, wait, log, delays }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const applied = await migrate(pool);
      log.log(`[govchat-admin] Beleidskompas store ready (migrations applied: ${applied.length ? applied.join(", ") : "none"})`);
      return createStore((sql, params) => pool.query(sql, params));
    } catch (err) {
      const delay = delays[Math.min(attempt - 1, delays.length - 1)];
      log.error(
        `[govchat-admin] Beleidskompas store not available (attempt ${attempt}): ${err.message}. Trying again in ${Math.round(delay / 1000)} s.`,
      );
      await wait(delay);
    }
  }
}

function start(app, { resolveUser } = {}, env = process.env, deps = {}) {
  const { openPool = db.openPool, migrate = db.migrate, wait = sleep, log = console, delays = RETRY_DELAYS_MS } = deps;
  const internalToken = String(env.BELEIDSKOMPAS_STORE_TOKEN || "").trim();
  const pool = openPool(env);
  if (!pool) {
    routes.mount(app, { store: null, internalToken, resolveUser });
    log.log("[govchat-admin] Beleidskompas store disabled (BELEIDSKOMPAS_DB_HOST not set)");
    return Promise.resolve(null);
  }

  let store = null;
  routes.mount(app, { store: waitingStore(() => store), internalToken, resolveUser });
  return connect(pool, { migrate, wait, log, delays }).then((ready) => {
    store = ready;
    return ready;
  });
}

module.exports = { start };
