"use strict";

/**
 * General feedback: free text about Beleidskompas as a whole (a bug, a
 * suggestion), stored with the sender's e-mail address so an admin can
 * reply. Not the anonymous feedback on one answer.
 *
 * Plain functions like routes.js. `getQuery()` gives the database's query
 * function once it is ready, or null before that (the handlers then answer
 * 503). Items older than `retentionDays` are deleted on every submit and list.
 */

const PURGE_SQL = "DELETE FROM general_feedback WHERE created_at < now() - make_interval(days => $1)";

/** The sender of a request: LibreChat says whose access token it carries
 *  (the refresh-token cookie only holds the user id). Returns `{ email }`,
 *  or null without a valid token. Throws when LibreChat itself fails, so the
 *  failure is logged instead of looking like a login problem. */
async function librechatUserFromBearer(req, { baseUrl, fetchImpl = fetch }) {
  const authorization = String((req.headers && req.headers.authorization) || "").trim();
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  const resp = await fetchImpl(`${baseUrl}/api/user`, { headers: { authorization, accept: "application/json" } });
  if (resp.status === 401 || resp.status === 403) return null;
  if (!resp.ok) throw new Error(`LibreChat /api/user answered ${resp.status}`);
  const user = await resp.json();
  return { email: String((user && user.email) || "").trim() };
}

function createGeneralFeedbackHandlers({ getQuery, retentionDays = 365 }) {
  const unavailable = { status: 503, body: { error: "Feedback kan nu niet worden opgeslagen" } };

  /** `user` is the logged-in LibreChat user ({ email }), or null. */
  async function submit({ user, body }) {
    if (!user) return { status: 401, body: { error: "Niet ingelogd" } };
    const email = String(user.email || "").trim();
    if (!email) return { status: 400, body: { error: "Je account heeft geen e-mailadres; feedback geven kan niet" } };
    const text = String((body && body.text) || "").trim().slice(0, 2000);
    if (!text) return { status: 400, body: { error: 'Veld "text" is verplicht' } };
    const query = getQuery();
    if (!query) return unavailable;

    await query(PURGE_SQL, [retentionDays]);
    await query("INSERT INTO general_feedback (email, text, step_id, version_id) VALUES ($1, $2, $3, $4)", [
      email,
      text,
      String((body && body.step_id) || "").trim().slice(0, 64),
      String((body && body.version_id) || "").trim().slice(0, 64),
    ]);
    return { status: 201, body: { ok: true } };
  }

  async function list() {
    const query = getQuery();
    if (!query) return unavailable;
    await query(PURGE_SQL, [retentionDays]);
    const { rows } = await query(
      "SELECT id::text, email, text, step_id, version_id, created_at FROM general_feedback ORDER BY created_at DESC, id DESC",
      [],
    );
    return { status: 200, body: { items: rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })) } };
  }

  return { submit, list };
}

module.exports = { createGeneralFeedbackHandlers, librechatUserFromBearer };
