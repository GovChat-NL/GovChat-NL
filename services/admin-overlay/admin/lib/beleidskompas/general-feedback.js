"use strict";

/**
 * General feedback: free text about Beleidskompas as a whole, stored with the
 * sender's e-mail address so an admin can reply. `getQuery()` is null until the
 * database is ready (then 503). Old items are deleted by the retention sweep
 * (lib/beleidskompas/retention/retention.js).
 */

/** The sender's e-mail address. The page sends its LibreChat login token
 *  ("Authorization: Bearer …") and we ask LibreChat's /api/user whose it is;
 *  every LibreChat user has an e-mail address. null without a valid token.
 *  Throws when LibreChat itself fails, so that is logged as an error. */
async function librechatEmailFromBearer(req, { baseUrl, fetchImpl = fetch }) {
  const authorization = String((req.headers && req.headers.authorization) || "").trim();
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  const resp = await fetchImpl(`${baseUrl}/api/user`, { headers: { authorization, accept: "application/json" } });
  if (resp.status === 401 || resp.status === 403) return null;
  if (!resp.ok) throw new Error(`LibreChat /api/user answered ${resp.status}`);
  return (await resp.json()).email;
}

function createGeneralFeedbackHandlers({ getQuery }) {
  const unavailable = { status: 503, body: { error: "Feedback kan nu niet worden opgeslagen" } };

  /** `email` is the logged-in sender's address, or null when not logged in. */
  async function submit({ email, body }) {
    if (!email) return { status: 401, body: { error: "Niet ingelogd" } };
    const text = String((body && body.text) || "").trim().slice(0, 2000);
    if (!text) return { status: 400, body: { error: 'Veld "text" is verplicht' } };
    const query = getQuery();
    if (!query) return unavailable;

    await query("INSERT INTO general_feedback (email, text) VALUES ($1, $2)", [email, text]);
    return { status: 201, body: { ok: true } };
  }

  async function list() {
    const query = getQuery();
    if (!query) return unavailable;
    const { rows } = await query(
      "SELECT id::text, email, text, created_at FROM general_feedback ORDER BY created_at DESC, id DESC",
      [],
    );
    return { status: 200, body: { items: rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })) } };
  }

  return { submit, list };
}

module.exports = { createGeneralFeedbackHandlers, librechatEmailFromBearer };
