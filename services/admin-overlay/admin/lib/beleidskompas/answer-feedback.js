"use strict";

/**
 * Answer feedback: 👍/👎 with an optional comment on one answer, stored without
 * user or e-mail. `getQuery()` is null until the database is ready (then 503).
 * Only the newest `max` items are kept.
 */

function createAnswerFeedbackHandlers({ getQuery, max = 500 }) {
  const unavailable = { status: 503, body: { error: "Feedback kan nu niet worden opgeslagen" } };

  async function submit({ body }) {
    const rating = String((body && body.rating) || "").trim().toLowerCase();
    if (rating !== "up" && rating !== "down") return { status: 400, body: { error: 'Veld "rating" moet "up" of "down" zijn' } };
    const query = getQuery();
    if (!query) return unavailable;

    const field = (name, length) => String((body && body[name]) || "").trim().slice(0, length);
    await query("INSERT INTO answer_feedback (rating, comment, step_id, substep_id, version_id) VALUES ($1, $2, $3, $4, $5)", [
      rating,
      field("comment", 2000),
      field("step_id", 64),
      field("substep_id", 32),
      field("version_id", 64),
    ]);
    await query("DELETE FROM answer_feedback WHERE id NOT IN (SELECT id FROM answer_feedback ORDER BY created_at DESC, id DESC LIMIT $1)", [max]);
    return { status: 201, body: { ok: true } };
  }

  async function list() {
    const query = getQuery();
    if (!query) return unavailable;
    const { rows } = await query(
      "SELECT id::text, rating, comment, step_id, substep_id, version_id, created_at FROM answer_feedback ORDER BY created_at DESC, id DESC",
      [],
    );
    const items = rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
    const up = items.filter((i) => i.rating === "up").length;
    return { status: 200, body: { items, totals: { total: items.length, up, down: items.length - up } } };
  }

  return { submit, list };
}

module.exports = { createAnswerFeedbackHandlers };
