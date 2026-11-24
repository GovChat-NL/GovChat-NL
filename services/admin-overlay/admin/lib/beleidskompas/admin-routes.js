"use strict";

const { HttpError } = require("./errors");

function mount(app, { requireAuth, getStore, normalizeFlow, defaultFlow, publishLive }) {
  const route = (method, path, run) => app[method](path, requireAuth, async (req, res) => {
    try {
      const store = getStore();
      if (!store) throw new HttpError(503, "Beleidskompas database is not available");
      await run(store, req, res);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error("[govchat-admin] Template request failed:", err);
      res.status(err instanceof HttpError ? err.status : 500).json({ error: err instanceof HttpError ? err.message : "Template request failed" });
    }
  });
  const flow = (input) => {
    if (!input || typeof input !== "object" || !Array.isArray(input.steps)) throw new HttpError(400, "A template flow with steps is required");
    const normalized = normalizeFlow(input);
    const ids = normalized.steps.flatMap((step) => (step.substeps || []).map((sub) => sub.id));
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) throw new HttpError(400, `Substep id ${duplicate} is used more than once`);
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
      if (!Number.isInteger(days) || days < 1) throw new HttpError(400, "Retention days must be a positive integer");
      settings.retention_days = days;
    }
    for (const key of ["enforce_source_citation", "require_human_validation"]) {
      if (Object.hasOwn(input, key)) {
        if (typeof input[key] !== "boolean") throw new HttpError(400, `${key} must be a boolean`);
        settings[key] = input[key];
      }
    }
    if (Object.hasOwn(input, "default_model")) settings.default_model = String(input.default_model).trim() || "govchat-default";
    res.json({ ok: true, settings: await store.saveSettings(settings) });
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
