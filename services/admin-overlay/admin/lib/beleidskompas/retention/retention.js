"use strict";

/**
 * Retention of Beleidskompas data. Each kind in KINDS is deleted when it is
 * older than its Bewaartermijn, a setting on the admin Algemeen page. The
 * sweep runs at start and every 6 hours, logs what it deletes, and keeps the
 * result per kind in the `settings` table under `retention` for that page.
 *
 * To add a kind, add one entry to KINDS: the Algemeen page, the settings
 * check, the default and the sweep all follow from it.
 */

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const OLDER_THAN = "< now() - make_interval(days => $1::int)";

const KINDS = [
  {
    id: "cases",
    label: "Casussen",
    hint: "Casustekst, rapporten en gesprek, gerekend vanaf de laatste wijziging.",
    setting: "retention_days", // the name it had before this module, so saved values stay
    defaultDays: 30,
    // Texts, reports and turns go with their case (ON DELETE CASCADE).
    sql: [`DELETE FROM cases WHERE updated_at ${OLDER_THAN}`],
  },
  {
    id: "feedback",
    label: "Feedback",
    hint: "Algemene feedback en feedback per antwoord, gerekend vanaf het versturen.",
    setting: "feedback_retention_days",
    defaultDays: 365,
    sql: [`DELETE FROM general_feedback WHERE created_at ${OLDER_THAN}`, `DELETE FROM answer_feedback WHERE created_at ${OLDER_THAN}`],
  },
];

/** The kinds as the admin page needs them. */
const retentionKinds = () => KINDS.map(({ id, label, hint, setting }) => ({ id, label, hint, setting }));

/** The default Bewaartermijn of every kind, by setting name. */
const retentionDefaults = () => Object.fromEntries(KINDS.map((kind) => [kind.setting, kind.defaultDays]));

/** Deletes what is older than its Bewaartermijn in `settings`. A kind that
 *  fails is logged and keeps its previous result; the next sweep tries again.
 *  `seen` holds the periods logged last, so a period is logged when it changes. */
async function sweep({ query, settings, log = console, seen = {} }) {
  const { rows } = await query("SELECT data FROM settings WHERE key = 'retention'");
  const previous = rows[0]?.data || {};
  const result = {};
  for (const kind of KINDS) {
    result[kind.id] = previous[kind.id];
    const days = Number(settings?.[kind.setting]);
    if (!Number.isInteger(days) || days <= 0) continue;
    try {
      if (days !== seen[kind.id]) log.log(`[govchat-admin] Beleidskompas retention: keeping ${kind.id} ${days} days`);
      seen[kind.id] = days;
      let deleted = 0;
      for (const sql of kind.sql) deleted += (await query(sql, [days])).rowCount || 0;
      if (deleted) log.log(`[govchat-admin] Beleidskompas retention: deleted ${deleted} ${kind.id} older than ${days} days`);
      const at = new Date().toISOString();
      result[kind.id] = { at, days, deleted, last_deletion: deleted ? { at, days, deleted } : previous[kind.id]?.last_deletion };
    } catch (err) {
      log.error(`[govchat-admin] Beleidskompas retention of ${kind.id} failed: ${err.message}`);
    }
  }
  await query(
    "INSERT INTO settings (key, data) VALUES ('retention', $1::jsonb) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data",
    [JSON.stringify(result)],
  );
  return result;
}

/** Sweeps now and every 6 hours. `getSettings()` gives the saved settings.
 *  Returns the sweep, so a changed Bewaartermijn can apply at once. */
function startRetention({ query, getSettings, log = console, intervalMs = SWEEP_INTERVAL_MS }) {
  const seen = {};
  const run = async () => {
    try {
      return await sweep({ query, settings: await getSettings(), log, seen });
    } catch (err) {
      log.error(`[govchat-admin] Beleidskompas retention failed: ${err.message}`);
    }
  };
  setInterval(run, intervalMs).unref();
  run();
  return run;
}

module.exports = { retentionKinds, retentionDefaults, sweep, startRetention };
