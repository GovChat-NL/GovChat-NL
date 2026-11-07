"use strict";

/**
 * Starts the Beleidskompas store in the admin service: opens the database,
 * runs the migrations, and mounts the endpoints for n8n on `app`.
 *
 * Without BELEIDSKOMPAS_DB_HOST there is no database; the endpoints are
 * mounted anyway and answer 503, and the rest of the service runs as
 * before. A migration that fails is thrown, so the service does not start
 * on a broken schema.
 */

const db = require("../../db/connection");
const { createStore } = require("./store");
const routes = require("./routes");

async function start(app, env = process.env) {
  let store = null;
  const pool = db.openPool(env);
  if (pool) {
    const applied = await db.migrate(pool);
    store = createStore((sql, params) => pool.query(sql, params));
    console.log(`[govchat-admin] Beleidskompas store ready (migrations applied: ${applied.length ? applied.join(", ") : "none"})`);
  } else {
    console.log("[govchat-admin] Beleidskompas store disabled (BELEIDSKOMPAS_DB_HOST not set)");
  }
  routes.mount(app, { store, internalToken: String(env.BELEIDSKOMPAS_STORE_TOKEN || "").trim() });
  return store;
}

module.exports = { start };
