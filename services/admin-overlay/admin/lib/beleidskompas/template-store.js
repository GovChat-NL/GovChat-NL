"use strict";

/**
 * The template store: the templates of the Beleidskompas admin, their versions, the reference
 * documents, which version is live, and the settings. The tables are in
 * db/migrations/0002-templates.sql. The cases of the users are in case-store.js.
 *
 * createTemplateStore takes `db`: `{ query(sql, params), transaction(fn) }`, where `fn` gets a
 * `query` that runs on one connection (see transaction in db/connection.js).
 */

const crypto = require("crypto");
const { StoreError, isUniqueViolation, withOneRetry } = require("./store-errors");

const DOC_COLUMNS = "d.id, d.filename, d.content_type AS mime_type, d.size AS size_bytes, d.created_at AS uploaded_at, d.preview_text";
const docRow = ({ uploaded_at, ...rest }) => ({ ...rest, uploaded_at: uploaded_at.toISOString() });

function createTemplateStore(db) {
  // templates.live_version_id is the template's newest version (what the editor opens and what every save moves).
  // The API reports "live" from the `live` row instead: the version end users get, null for the other templates.
  async function listTemplates() {
    const { rows: templates } = await db.query("SELECT id, name FROM templates ORDER BY id");
    const { rows: versions } = await db.query(
      "SELECT id, template_id, created_at, created_by, note, snapshot FROM template_versions ORDER BY version DESC");
    const { rows: [live] } = await db.query("SELECT template_id, version_id FROM live");
    return templates.map((t) => {
      const liveVersionId = live && live.template_id === t.id ? live.version_id : null;
      return {
        ...t,
        live_version_id: liveVersionId,
        versions: versions.filter((v) => v.template_id === t.id).map((v) => ({
          id: v.id,
          published_at: v.created_at.toISOString(),
          published_by: v.created_by,
          note: v.note,
          is_live: v.id === liveVersionId,
          snapshot: v.snapshot,
        })),
      };
    });
  }

  async function getCurrent(templateId) {
    const { rows } = await db.query(
      `SELECT tv.id, tv.snapshot,
              coalesce(array_agg(vd.document_id ORDER BY vd.document_id) FILTER (WHERE vd.document_id IS NOT NULL), '{}') AS document_ids
       FROM templates t JOIN template_versions tv ON tv.id = t.live_version_id
       LEFT JOIN version_documents vd ON vd.version_id = tv.id
       WHERE t.id = $1 GROUP BY tv.id`, [templateId]);
    return rows[0] ? { versionId: rows[0].id, snapshot: rows[0].snapshot, documentIds: rows[0].document_ids } : null;
  }

  async function insertVersion(q, templateId, snapshot, documentIds, note, createdBy = "System Administrator", createdAt = null) {
    const { rows: [v] } = await q(
      `INSERT INTO template_versions (template_id, version, note, created_by, snapshot, created_at)
       VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM template_versions WHERE template_id = $1), $2, $3, $4,
               coalesce($5::timestamptz, now()))
       RETURNING *`, [templateId, note || "", createdBy, snapshot, createdAt]);
    await q("INSERT INTO version_documents (version_id, document_id) SELECT $1, unnest($2::int[])",
      [v.id, [...new Set(documentIds)]]);
    await q("UPDATE templates SET live_version_id = $1 WHERE id = $2", [v.id, templateId]);
    return { version: v };
  }

  async function insertTemplate(q, name, createdFromVersionId) {
    const { rows: [t] } = await q(
      "INSERT INTO templates (name, created_from_version_id) VALUES ($1, $2) RETURNING id", [name, createdFromVersionId ?? null]);
    return t.id;
  }

  // Two saves that take the same version number at once: the second one is tried again with the next number.
  async function saveVersion(templateId, snapshot, documentIds, note, createdBy) {
    try {
      return await withOneRetry(() => db.transaction((q) => insertVersion(q, templateId, snapshot, documentIds, note, createdBy)));
    } catch (err) {
      if (isUniqueViolation(err)) throw new StoreError(409, "Gelijktijdige wijziging, probeer opnieuw");
      throw err;
    }
  }

  function createTemplate({ name, snapshot, documentIds, createdFromVersionId, note }) {
    return db.transaction(async (q) => {
      const id = await insertTemplate(q, name, createdFromVersionId);
      const { version } = await insertVersion(q, id, snapshot, documentIds, note);
      const { rows: [template] } = await q("SELECT * FROM templates WHERE id = $1", [id]);
      return { template, version };
    });
  }

  async function insertDocument(q, { filename, contentType, bytes, previewText }) {
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const { rows: [row] } = await q(
      `INSERT INTO documents (sha256, filename, content_type, size, preview_text, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
       RETURNING id, (xmax <> 0) AS reused`, [sha256, filename, contentType, bytes.length, previewText || "", bytes]);
    return row;
  }

  const upsertDocument = (doc) => insertDocument(db.query, doc);

  async function listDocuments(templateId) {
    const { rows } = await db.query(
      `SELECT ${DOC_COLUMNS}, bool_or(tv.id = t.live_version_id) AS active
       FROM templates t
       JOIN template_versions tv ON tv.template_id = t.id
       JOIN version_documents vd ON vd.version_id = tv.id
       JOIN documents d ON d.id = vd.document_id
       WHERE t.id = $1 GROUP BY d.id, t.live_version_id ORDER BY d.created_at DESC, d.id DESC`, [templateId]);
    return rows.map(docRow);
  }

  async function getDocument(documentId) {
    const { rows } = await db.query(
      "SELECT id, filename, content_type AS mime_type, preview_text, content FROM documents WHERE id = $1", [documentId]);
    return rows[0] || null;
  }

  async function renameDocument(documentId, filename) {
    await db.query("UPDATE documents SET filename = $2 WHERE id = $1", [documentId, filename]);
  }

  async function getLive() {
    const { rows } = await db.query(
      "SELECT l.template_id, l.version_id, tv.snapshot FROM live l JOIN template_versions tv ON tv.id = l.version_id");
    if (!rows[0]) return null;
    const docs = await db.query(
      `SELECT ${DOC_COLUMNS} FROM version_documents vd JOIN documents d ON d.id = vd.document_id
       WHERE vd.version_id = $1 ORDER BY d.id`, [rows[0].version_id]);
    return { ...rows[0], documents: docs.rows.map(docRow) };
  }

  async function setLive(templateId, versionId) {
    await db.query(
      `INSERT INTO live (template_id, version_id) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET template_id = EXCLUDED.template_id, version_id = EXCLUDED.version_id`,
      [templateId, versionId]);
  }

  async function getSettings() {
    const { rows } = await db.query("SELECT data FROM settings");
    return rows[0] ? rows[0].data : null;
  }

  async function saveSettings(data) {
    await db.query("INSERT INTO settings (data) VALUES ($1) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data", [data]);
  }

  function importLegacyState(state, name) {
    return db.transaction(async (q) => {
      const documentIds = [];
      for (const d of state.documents || []) {
        const { id } = await insertDocument(q, {
          filename: d.filename, contentType: d.mime_type || "application/octet-stream",
          bytes: Buffer.from(d.content_base64, "base64"), previewText: d.preview_text,
        });
        documentIds.push(id);
      }
      const versions = [...(state.versions || [])].sort((a, b) => new Date(a.published_at) - new Date(b.published_at));
      if (!versions.length) versions.push({ snapshot: state.live || state.draft });
      const templateId = await insertTemplate(q, name);
      const versionIds = {};
      let newestVersionId = null;
      for (const v of versions) {
        const { version } = await insertVersion(q, templateId, v.snapshot, documentIds, v.note, v.published_by || "Onbekend", v.published_at);
        if (v.id) versionIds[v.id] = version.id;
        newestVersionId = version.id;
      }
      return { templateId, versionIds, newestVersionId };
    });
  }

  return {
    listTemplates, getCurrent, createTemplate, saveVersion, upsertDocument, listDocuments, getDocument,
    renameDocument, getLive, setLive, getSettings, saveSettings, importLegacyState,
  };
}

module.exports = { createTemplateStore };
