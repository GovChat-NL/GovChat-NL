"use strict";

const { StoreError } = require("./store");
const { SUPPORTED_TYPES } = require("./chat-documents");

function mount(app, { requireAuth, getStore, normalizeFlow, defaultFlow, publishLive, republish }) {
  const route = (method, path, run) => app[method](path, requireAuth, async (req, res) => {
    try {
      const store = getStore();
      if (!store) throw new StoreError(503, "Beleidskompas database is not available");
      await run(store, req, res);
    } catch (err) {
      if (!(err instanceof StoreError)) console.error("[govchat-admin] Template request failed:", err);
      res.status(err instanceof StoreError ? err.status : 500).json({ error: err instanceof StoreError ? err.message : "Template request failed" });
    }
  });
  const flow = (input) => {
    if (!input || typeof input !== "object" || !Array.isArray(input.steps)) throw new StoreError(400, "A template flow with steps is required");
    const normalized = normalizeFlow(input);
    // Reports and feedback are stored by substep id. The editor gives every substep one, so a
    // substep without an id comes from a hand-edited import.
    const ids = input.steps.flatMap((step) => (step?.substeps || []).map((sub) => String(sub?.id || "").trim()));
    if (ids.some((id) => !id)) throw new StoreError(400, "Every substep needs an id");
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) throw new StoreError(400, `Substep id ${duplicate} is used more than once`);
    return normalized;
  };

  route("get", "/api/beleidskompas/state", async (store, req, res) => {
    res.json({ ok: true, state: { ...await store.getState(), default_flow: defaultFlow() } });
  });
  route("post", "/api/beleidskompas/templates", async (store, req, res) => {
    const template = await store.createTemplate(req.body?.name, flow(req.body?.flow ?? defaultFlow()));
    res.status(201).json({ ok: true, template });
  });
  route("post", "/api/beleidskompas/templates/:templateId/versions", async (store, req, res) => {
    const version = await store.saveVersion(req.params.templateId, flow(req.body?.flow), req.body?.note);
    res.status(201).json({ ok: true, version });
  });
  route("post", "/api/beleidskompas/templates/:templateId/versions/:versionId/deploy", async (store, req, res) => {
    const live = await store.deployVersion(req.params.templateId, req.params.versionId, publishLive);
    res.json({ ok: true, live });
  });
  route("post", "/api/beleidskompas/settings", async (store, req, res) => {
    const input = req.body || {};
    const settings = {};
    if (Object.hasOwn(input, "retention_days")) {
      const days = Number(input.retention_days);
      if (!Number.isInteger(days) || days < 1) throw new StoreError(400, "Retention days must be a positive integer");
      settings.retention_days = days;
    }
    for (const key of ["enforce_source_citation", "require_human_validation"]) {
      if (Object.hasOwn(input, key)) {
        if (typeof input[key] !== "boolean") throw new StoreError(400, `${key} must be a boolean`);
        settings[key] = input[key];
      }
    }
    if (Object.hasOwn(input, "default_model")) settings.default_model = String(input.default_model).trim() || "govchat-default";
    if (Object.hasOwn(input, "upload_max_mb")) {
      const mb = Number(input.upload_max_mb);
      // The page sends the file as base64 JSON, and express takes at most 20 MB of JSON.
      if (!Number.isInteger(mb) || mb < 1 || mb > 14) throw new StoreError(400, "Maximum upload size must be a whole number of MB from 1 to 14");
      settings.upload_max_mb = mb;
    }
    if (Object.hasOwn(input, "upload_allowed_types")) {
      const list = Array.isArray(input.upload_allowed_types) ? input.upload_allowed_types : String(input.upload_allowed_types).split(",");
      const types = [...new Set(list.map((t) => String(t).trim().replace(/^\./, "").toLowerCase()).filter(Boolean))];
      const unknown = types.filter((t) => !SUPPORTED_TYPES.includes(t));
      if (!types.length || unknown.length) throw new StoreError(400, `Allowed file types must be some of: ${SUPPORTED_TYPES.join(", ")}`);
      settings.upload_allowed_types = types;
    }
    const saved = await store.saveSettings(settings);
    // The page reads the upload limits from the public config.
    if (republish) await republish();
    res.json({ ok: true, settings: saved });
  });
  route("get", "/api/beleidskompas/templates/:templateId/export", async (store, req, res) => {
    res.json(await store.exportTemplate(req.params.templateId));
  });
  route("post", "/api/beleidskompas/import", async (store, req, res) => {
    const template = await store.importTemplate({ ...req.body, flow: flow(req.body?.flow) });
    res.status(201).json({ ok: true, template });
  });
  route("get", "/api/beleidskompas/documents", async (store, req, res) => {
    res.json({ ok: true, documents: await store.listDocuments() });
  });
  route("post", "/api/beleidskompas/documents", async (store, req, res) => {
    res.status(201).json({ ok: true, document: await store.uploadDocument(req.body || {}) });
  });
  route("patch", "/api/beleidskompas/documents/:docId", async (store, req, res) => {
    res.json({ ok: true, document: await store.updateDocument(req.params.docId, req.body?.filename) });
  });
  route("get", "/api/beleidskompas/documents/:docId/download", async (store, req, res) => {
    const doc = await store.getDocument(req.params.docId);
    res.setHeader("Content-Type", doc.mime_type);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.filename)}"`);
    res.send(doc.content);
  });
  route("delete", "/api/beleidskompas/documents/:docId", async (store, req, res) => {
    await store.deleteDocument(req.params.docId);
    res.json({ ok: true, removed: req.params.docId });
  });
}

module.exports = { mount };
