"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { ADMIN_SESSION_TTL_MS, isAdminSessionValid } = require("../../services/admin-overlay/admin/lib/admin-session");

test("admin session expires exactly at the shared 24h cookie TTL without sliding renewal", () => {
  assert.equal(ADMIN_SESSION_TTL_MS, 86400000);
  const sessions = new Map([["admin", { created: 100 }]]);
  assert.equal(isAdminSessionValid(sessions, "admin", 100), true);
  assert.equal(isAdminSessionValid(sessions, "admin", 100 + ADMIN_SESSION_TTL_MS - 1), true);
  assert.equal(sessions.get("admin").created, 100);
  assert.equal(isAdminSessionValid(sessions, "admin", 100 + ADMIN_SESSION_TTL_MS), false);
  assert.equal(sessions.has("admin"), false);
  assert.equal(isAdminSessionValid(sessions, "admin", 100), false);
});
test("admin session rejects unknown, malformed, future and expired creation times", () => {
  for (const created of [undefined, NaN, Infinity, "100", 101, -ADMIN_SESSION_TTL_MS]) {
    const sessions = new Map([["admin", { created }]]);
    assert.equal(isAdminSessionValid(sessions, "admin", 100), false);
    assert.equal(sessions.size, 0);
  }
  for (const id of [undefined, null, "", {}, "unknown"]) assert.equal(isAdminSessionValid(new Map(), id, 100), false);
});
test("shared admin server wires both authentication and cookie lifetime to the helper", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../services/admin-overlay/admin/server.js"), "utf8");
  assert.match(source, /return isAdminSessionValid\(sessions, sid\)/);
  assert.match(source, /maxAge: ADMIN_SESSION_TTL_MS/);
  assert.doesNotMatch(source, /return sid && sessions\.has\(sid\)/);
});
