"use strict";

/**
 * General feedback: free text about Beleidskompas as a whole (a bug, a
 * suggestion), stored with the sender's e-mail address so an admin can
 * reply. Not the anonymous feedback on one answer.
 *
 * Plain functions like routes.js: `read()` returns the stored items,
 * `write(items)` saves them. Items older than `retentionDays` are dropped
 * on every read.
 */

const crypto = require("crypto");

const DAY_MS = 86400000;

function createGeneralFeedbackHandlers({ read, write, retentionDays = 365, now = Date.now }) {
  function current() {
    const cutoff = now() - retentionDays * DAY_MS;
    return read().filter((item) => new Date(item.created_at).getTime() >= cutoff);
  }

  /** `user` is the logged-in LibreChat user ({ email }), or null. */
  function submit({ user, body }) {
    if (!user) return { status: 401, body: { error: "Niet ingelogd" } };
    const email = String(user.email || "").trim();
    if (!email) return { status: 400, body: { error: "Je account heeft geen e-mailadres; feedback geven kan niet" } };
    const text = String((body && body.text) || "").trim().slice(0, 2000);
    if (!text) return { status: 400, body: { error: 'Veld "text" is verplicht' } };

    const items = current();
    items.push({
      id: crypto.randomUUID(),
      email,
      text,
      step_id: String((body && body.step_id) || "").trim().slice(0, 64),
      version_id: String((body && body.version_id) || "").trim().slice(0, 64),
      created_at: new Date(now()).toISOString(),
    });
    write(items);
    return { status: 201, body: { ok: true } };
  }

  function list() {
    return { status: 200, body: { items: current().reverse() } };
  }

  return { submit, list };
}

module.exports = { createGeneralFeedbackHandlers };
