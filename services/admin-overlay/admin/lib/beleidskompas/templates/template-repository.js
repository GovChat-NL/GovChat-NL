"use strict";

const { HttpError, FOREIGN_KEY_VIOLATION } = require("../shared/errors");
const { requireId } = require("../shared/ids");
const { inTransaction } = require("../shared/transaction");

const versionView = (v) => ({
  id: String(v.id), version: v.version, note: v.note, snapshot: v.snapshot,
  published_at: new Date(v.created_at).toISOString(), published_by: v.created_by,
});

function createTemplateRepository(pool, defaultSettings = {}) {
  async function requireTemplate(db, templateId, lock = false) {
    const { rows } = await db.query(`SELECT * FROM templates WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [requireId(templateId)]);
    if (!rows[0]) throw new HttpError(404, "Template not found");
    return rows[0];
  }

  async function insertVersion(db, templateId, flow, note = "") {
    const docIds = [...new Set((flow.steps || []).flatMap((s) => s.document_ids || []).map(requireId))];
    const { rows } = await db.query(
      `INSERT INTO template_versions (template_id, version, note, snapshot)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3::jsonb FROM template_versions WHERE template_id = $1 RETURNING *`,
      [templateId, String(note).trim(), JSON.stringify(flow)],
    );
    try {
      if (docIds.length) await db.query("INSERT INTO version_documents (version_id, document_id) SELECT $1, unnest($2::int[])", [rows[0].id, docIds]);
    } catch (err) {
      if (err.code === FOREIGN_KEY_VIOLATION) throw new HttpError(400, "A selected document no longer exists");
      throw err;
    }
    return versionView(rows[0]);
  }

  /** Stores a template with its first version and returns the id of the
   *  template. `db` is a client inside a transaction. */
  async function insertTemplate(db, name, flow) {
    const title = String(name || "").trim();
    if (!title) throw new HttpError(400, "Template name is required");
    const { rows } = await db.query("INSERT INTO templates (name) VALUES ($1) RETURNING id", [title]);
    await insertVersion(db, rows[0].id, flow, "Eerste versie");
    return String(rows[0].id);
  }

  async function getState() {
    // One statement gives the picker, versions and global live pointer a consistent snapshot.
    const { rows: [row] } = await pool.query(`SELECT
      COALESCE((SELECT jsonb_agg(t ORDER BY t.id) FROM templates t), '[]') AS templates,
      COALESCE((SELECT jsonb_agg(v ORDER BY v.template_id, v.version DESC) FROM template_versions v), '[]') AS versions,
      (SELECT row_to_json(l) FROM live l WHERE key = 'live') AS live,
      (SELECT data FROM settings WHERE key = 'settings') AS settings`);
    const templates = row.templates.map((t) => ({
      id: String(t.id), name: t.name,
      live_version_id: row.live?.template_id === t.id ? String(row.live.version_id) : null,
      versions: row.versions.filter((v) => v.template_id === t.id).map((v) => ({ ...versionView(v), is_live: row.live?.version_id === v.id })),
    }));
    const liveTemplate = templates.find((t) => t.live_version_id);
    return {
      templates, settings: { ...defaultSettings, ...row.settings },
      live: liveTemplate?.versions.find((v) => v.id === liveTemplate.live_version_id)?.snapshot || null,
    };
  }

  async function getTemplate(templateId) {
    const id = requireId(templateId);
    const template = (await getState()).templates.find((t) => t.id === id);
    if (!template) throw new HttpError(404, "Template not found");
    return template;
  }

  async function createTemplate(name, flow) {
    const templateId = await inTransaction(pool, (db) => insertTemplate(db, name, flow));
    return getTemplate(templateId);
  }

  async function saveVersion(templateId, flow, note) {
    return inTransaction(pool, async (db) => {
      await requireTemplate(db, templateId, true); // Serialize numbering for concurrent saves.
      return insertVersion(db, templateId, flow, note);
    });
  }

  async function deployVersion(templateId, versionId, publish) {
    return inTransaction(pool, async (db) => {
      // Serialize deployments, including the first deployment when live has no row yet.
      await db.query("LOCK TABLE live IN EXCLUSIVE MODE");
      const { rows } = await db.query("SELECT snapshot FROM template_versions WHERE id = $1 AND template_id = $2", [requireId(versionId), requireId(templateId)]);
      if (!rows[0]) throw new HttpError(404, "Version not found for this template");
      await db.query("INSERT INTO live (template_id, version_id) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET template_id = EXCLUDED.template_id, version_id = EXCLUDED.version_id", [templateId, versionId]);
      await publish(rows[0].snapshot, String(versionId));
      return rows[0].snapshot;
    });
  }

  async function saveSettings(settings) {
    const { rows } = await pool.query("INSERT INTO settings (data) VALUES ($1::jsonb) ON CONFLICT (key) DO UPDATE SET data = settings.data || EXCLUDED.data RETURNING data", [JSON.stringify(settings)]);
    return { ...defaultSettings, ...rows[0].data };
  }

  return { getState, getTemplate, createTemplate, insertTemplate, saveVersion, deployVersion, saveSettings };
}

module.exports = { createTemplateRepository };
