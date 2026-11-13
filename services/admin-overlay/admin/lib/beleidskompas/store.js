"use strict";

/**
 * The Beleidskompas store: reading and writing the state of a case. The
 * tables are described in db/migrations (at the root of the service).
 *
 * createStore takes a `query(sql, params)` function that resolves to
 * `{ rows }`, the shape of pg's Pool.query, so server.js passes a real pool
 * and the unit tests pass a stand-in.
 *
 * Every function takes the user id of the caller. A case of another user
 * reads as unknown, so a caller cannot tell a case of someone else from no
 * case at all. The one exception is creating a case: when the id is taken
 * by another user, that is refused (status 403) instead of silently making
 * the case theirs.
 */

class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Postgres raises this code when an insert hits an existing primary key.
const UNIQUE_VIOLATION = "23505";

function requireText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new StoreError(400, `${name} is required`);
  return text;
}

/** Runs `insert` again once when it collides with a version number that
 *  another insert took in the meantime. The version is read and written in
 *  one statement, so a collision is rare and the second try gets the next
 *  number. */
async function withOneRetry(insert) {
  try {
    return await insert();
  } catch (err) {
    if (err && err.code === UNIQUE_VIOLATION) return insert();
    throw err;
  }
}

function createStore(query) {
  if (typeof query !== "function") throw new Error("createStore needs a query function");

  /** The case row when it exists and belongs to `userId`, otherwise null. */
  async function ownedCase(caseId, userId) {
    const { rows } = await query("SELECT id, user_id, title, created_at, updated_at FROM cases WHERE id = $1 AND user_id = $2", [caseId, userId]);
    return rows[0] || null;
  }

  async function requireOwnedCase(caseId, userId) {
    const row = await ownedCase(caseId, userId);
    if (!row) throw new StoreError(404, "Unknown case");
    return row;
  }

  async function touch(caseId) {
    await query("UPDATE cases SET updated_at = now() WHERE id = $1", [caseId]);
  }

  /** Creates the case when it does not exist yet, and returns it. */
  async function ensureCase({ id, userId }) {
    const caseId = requireText(id, "case id");
    const owner = requireText(userId, "user id");
    await query("INSERT INTO cases (id, user_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [caseId, owner]);
    const row = await ownedCase(caseId, owner);
    if (!row) throw new StoreError(403, "This case id belongs to another user");
    return row;
  }

  /** Stores the case text as a new version, unless it is the same as the
   *  newest version. Creates the case when needed: the first message of a
   *  case is its text. Returns the version that holds this text. */
  async function setCaseText({ caseId, userId, text }) {
    const content = requireText(text, "case text");
    const { id } = await ensureCase({ id: caseId, userId });
    const { rows } = await query("SELECT version, text FROM case_texts WHERE case_id = $1 ORDER BY version DESC LIMIT 1", [id]);
    if (rows[0] && rows[0].text === content) return { version: rows[0].version, unchanged: true };
    const inserted = await withOneRetry(() =>
      query(
        `INSERT INTO case_texts (case_id, version, text)
         SELECT $1, COALESCE(MAX(version), 0) + 1, $2 FROM case_texts WHERE case_id = $1
         RETURNING version`,
        [id, content],
      ),
    );
    await touch(id);
    return { version: inserted.rows[0].version, unchanged: false };
  }

  /** Stores a report of a substep as a new version: the text the page
   *  shows and its citations. Creates the case when needed, like
   *  setCaseText. */
  async function addReport({ caseId, userId, substepId, text, citations, retrievalTrace }) {
    const substep = requireText(substepId, "substep id");
    const rendered = requireText(text, "report text");
    const { id } = await ensureCase({ id: caseId, userId });
    const { rows } = await withOneRetry(() =>
      query(
        `INSERT INTO reports (case_id, substep_id, version, text, citations, retrieval_trace)
         SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4::jsonb, $5::jsonb FROM reports WHERE case_id = $1 AND substep_id = $2
         RETURNING version`,
        [id, substep, rendered, JSON.stringify(Array.isArray(citations) ? citations : []), retrievalTrace ? JSON.stringify(retrievalTrace) : null],
      ),
    );
    await touch(id);
    return { version: rows[0].version };
  }

  /** Appends a turn to the conversation of the case: what the user typed
   *  (role "user") or what a step answered (role "assistant", with the step
   *  in `stepId`). `askedFrom` is the substep the user was in. Creates the
   *  case when needed: a conversation in LibreChat's own chat starts with a
   *  question, not with a case text. */
  async function addTurn({ caseId, userId, role, stepId, askedFrom, text }) {
    const content = requireText(text, "turn text");
    const who = requireText(role, "role");
    if (who !== "user" && who !== "assistant") throw new StoreError(400, 'role must be "user" or "assistant"');
    const { id } = await ensureCase({ id: caseId, userId });
    const { rows } = await withOneRetry(() =>
      query(
        `INSERT INTO conversation_turns (case_id, seq, role, step_id, asked_from, text)
         SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4, $5 FROM conversation_turns WHERE case_id = $1
         RETURNING seq`,
        [id, who, String(stepId || "").trim() || null, String(askedFrom || "").trim() || null, content],
      ),
    );
    await touch(id);
    return { seq: rows[0].seq };
  }

  async function setTitle({ caseId, userId, title }) {
    const { id } = await requireOwnedCase(requireText(caseId, "case id"), requireText(userId, "user id"));
    await query("UPDATE cases SET title = $2 WHERE id = $1", [id, String(title || "").trim() || null]);
  }

  /** The state of a case: the case row, the newest case text, the newest
   *  report per substep and the conversation (the last `maxTurns` turns, in
   *  order). Null when there is no such case for this user. */
  async function getState({ caseId, userId, maxTurns }) {
    const row = await ownedCase(requireText(caseId, "case id"), requireText(userId, "user id"));
    if (!row) return null;
    const limit = Math.max(1, Number.parseInt(String(maxTurns || 200), 10) || 200);
    const [texts, reports, turns] = await Promise.all([
      query("SELECT version, text, created_at FROM case_texts WHERE case_id = $1 ORDER BY version DESC LIMIT 1", [row.id]),
      query(
        `SELECT DISTINCT ON (substep_id) substep_id, version, text, citations, retrieval_trace, created_at
         FROM reports WHERE case_id = $1 ORDER BY substep_id, version DESC`,
        [row.id],
      ),
      query(
        `SELECT seq, role, step_id, asked_from, text, created_at FROM (
           SELECT * FROM conversation_turns WHERE case_id = $1 ORDER BY seq DESC LIMIT $2
         ) latest ORDER BY seq ASC`,
        [row.id, limit],
      ),
    ]);
    const byId = {};
    for (const r of reports.rows) {
      byId[r.substep_id] = {
        version: r.version,
        text: r.text,
        citations: r.citations || [],
        retrieval_trace: r.retrieval_trace || null,
        created_at: r.created_at,
      };
    }
    return {
      id: row.id,
      user_id: row.user_id,
      title: row.title || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      case_text: texts.rows[0] ? { version: texts.rows[0].version, text: texts.rows[0].text, created_at: texts.rows[0].created_at } : null,
      reports: byId,
      turns: turns.rows.map((t) => ({ seq: t.seq, role: t.role, step_id: t.step_id, asked_from: t.asked_from, text: t.text, created_at: t.created_at })),
    };
  }

  /** The cases of a user, newest first. */
  async function listCases({ userId, limit }) {
    const owner = requireText(userId, "user id");
    const max = Math.max(1, Math.min(200, Number.parseInt(String(limit || 20), 10) || 20));
    const { rows } = await query("SELECT id, title, created_at, updated_at FROM cases WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2", [owner, max]);
    return rows.map((r) => ({ id: r.id, title: r.title || null, created_at: r.created_at, updated_at: r.updated_at }));
  }

  /** Deletes the cases not touched for `days` days (their texts, reports
   *  and turns go with them) and returns how many. */
  async function deleteCasesOlderThan(days) {
    const { rowCount } = await query("DELETE FROM cases WHERE updated_at < now() - make_interval(days => $1)", [days]);
    return rowCount;
  }

  return { ensureCase, setCaseText, addReport, addTurn, setTitle, getState, listCases, deleteCasesOlderThan };
}

module.exports = { StoreError, createStore };
