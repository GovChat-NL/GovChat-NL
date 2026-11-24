"use strict";

const crypto = require("crypto");
const { StoreError } = require("./store");

function id(value) {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new StoreError(400, "Invalid id");
  return text;
}

const versionView = (v) => ({
  id: String(v.id), version: v.version, note: v.note, snapshot: v.snapshot,
  published_at: new Date(v.created_at).toISOString(), published_by: v.created_by,
});
const documentColumns = "id::text, filename, content_type AS mime_type, size AS size_bytes, preview_text, index_status, index_error, created_at AS uploaded_at";

function createTemplateStore(pool, defaultSettings = {}) {
  async function transaction(run) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async function requireTemplate(db, templateId, lock = false) {
    const { rows } = await db.query(`SELECT * FROM templates WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id(templateId)]);
    if (!rows[0]) throw new StoreError(404, "Template not found");
    return rows[0];
  }

  async function insertVersion(db, templateId, flow, note = "") {
    const docIds = [...new Set((flow.steps || []).flatMap((s) => s.document_ids || []).map(id))];
    if (docIds.length) {
      const { rows } = await db.query("SELECT id FROM documents WHERE id = ANY($1::int[])", [docIds]);
      if (rows.length !== docIds.length) throw new StoreError(400, "A selected document no longer exists");
    }
    const { rows } = await db.query(
      `INSERT INTO template_versions (template_id, version, note, snapshot)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3::jsonb FROM template_versions WHERE template_id = $1 RETURNING *`,
      [templateId, String(note).trim(), JSON.stringify(flow)],
    );
    if (docIds.length) await db.query("INSERT INTO version_documents (version_id, document_id) SELECT $1, unnest($2::int[])", [rows[0].id, docIds]);
    return versionView(rows[0]);
  }

  async function insertTemplate(db, name, flow) {
    const title = String(name || "").trim();
    if (!title) throw new StoreError(400, "Template name is required");
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

  async function createTemplate(name, flow) {
    const templateId = await transaction((db) => insertTemplate(db, name, flow));
    return (await getState()).templates.find((t) => t.id === templateId);
  }

  async function saveVersion(templateId, flow, note) {
    return transaction(async (db) => {
      await requireTemplate(db, templateId, true); // Serialize numbering for concurrent saves.
      return insertVersion(db, templateId, flow, note);
    });
  }

  async function deployVersion(templateId, versionId, publish) {
    return transaction(async (db) => {
      // Serialize deployments, including the first deployment when live has no row yet.
      await db.query("LOCK TABLE live IN EXCLUSIVE MODE");
      const { rows } = await db.query("SELECT snapshot FROM template_versions WHERE id = $1 AND template_id = $2", [id(versionId), id(templateId)]);
      if (!rows[0]) throw new StoreError(404, "Version not found for this template");
      await db.query("INSERT INTO live (template_id, version_id) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET template_id = EXCLUDED.template_id, version_id = EXCLUDED.version_id", [templateId, versionId]);
      const documents = (await db.query(`SELECT ${documentColumns} FROM documents`)).rows;
      await publish(rows[0].snapshot, documents, String(versionId));
      return rows[0].snapshot;
    });
  }

  async function saveSettings(settings) {
    const { rows } = await pool.query("INSERT INTO settings (data) VALUES ($1::jsonb) ON CONFLICT (key) DO UPDATE SET data = settings.data || EXCLUDED.data RETURNING data", [JSON.stringify(settings)]);
    return { ...defaultSettings, ...rows[0].data };
  }

  async function listDocuments() {
    return (await pool.query(`SELECT ${documentColumns} FROM documents ORDER BY created_at DESC, id DESC`)).rows;
  }

  async function insertDocument(db, doc) {
    const filename = String(doc.filename || "").trim();
    if (!filename) throw new StoreError(400, "Filename is required");
    const content = Buffer.from(String(doc.content_base64 || ""), "base64");
    const mime = String(doc.mime_type || "application/octet-stream");
    const preview = mime.startsWith("text/") || /\.(md|txt)$/i.test(filename) ? content.toString("utf8").slice(0, 4000) : "";
    return (await db.query(
      `INSERT INTO documents (sha256, filename, content_type, size, preview_text, content) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256 RETURNING ${documentColumns}`,
      [crypto.createHash("sha256").update(content).digest("hex"), filename, mime, content.length, preview, content],
    )).rows[0];
  }

  async function updateDocument(documentId, filename) {
    if (!String(filename || "").trim()) throw new StoreError(400, "Filename is required");
    const { rows } = await pool.query(`UPDATE documents SET filename = $2 WHERE id = $1 RETURNING ${documentColumns}`, [id(documentId), filename.trim()]);
    if (!rows[0]) throw new StoreError(404, "Document not found");
    return rows[0];
  }

  async function getDocument(documentId) {
    const { rows } = await pool.query(`SELECT ${documentColumns}, content FROM documents WHERE id = $1`, [id(documentId)]);
    if (!rows[0]) throw new StoreError(404, "Document not found");
    return rows[0];
  }

  async function deleteDocument(documentId) {
    try {
      const result = await pool.query("DELETE FROM documents WHERE id = $1 RETURNING id", [id(documentId)]);
      if (!result.rows[0]) throw new StoreError(404, "Document not found");
    } catch (err) {
      if (err.code === "23503") throw new StoreError(409, "Document belongs to a saved version and cannot be deleted");
      throw err;
    }
  }

  async function exportTemplate(templateId) {
    const template = (await getState()).templates.find((t) => t.id === id(templateId));
    if (!template) throw new StoreError(404, "Template not found");
    const flow = template.versions[0].snapshot;
    const docIds = [...new Set((flow.steps || []).flatMap((s) => s.document_ids || []))];
    const documents = await Promise.all(docIds.map(async (docId) => {
      const { content, ...doc } = await getDocument(docId);
      return { ...doc, content_base64: content.toString("base64") };
    }));
    return { name: template.name, flow, documents };
  }

  async function importTemplate({ name, flow, documents = [] }) {
    if (!Array.isArray(documents)) throw new StoreError(400, "Documents must be an array");
    const templateId = await transaction(async (db) => {
      const mapping = new Map();
      for (const doc of documents) mapping.set(String(doc.id), (await insertDocument(db, doc)).id);
      const snapshot = structuredClone(flow);
      for (const step of snapshot.steps || []) {
        step.document_ids = (step.document_ids || []).map((docId) => mapping.get(String(docId)) || String(docId));
      }
      return insertTemplate(db, name, snapshot);
    });
    return (await getState()).templates.find((t) => t.id === templateId);
  }

  return { getState, createTemplate, saveVersion, deployVersion, saveSettings, listDocuments,
    uploadDocument: (doc) => insertDocument(pool, doc), updateDocument, getDocument, deleteDocument, exportTemplate, importTemplate };
}

module.exports = { createTemplateStore };
