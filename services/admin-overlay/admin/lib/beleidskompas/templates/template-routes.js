"use strict";

const { HttpError } = require("../errors");

function mount(app, { requireAuth, getRepository, normalizeFlow, defaultFlow, publishLive }) {
  const route = (method, path, run) => app[method](path, requireAuth, async (req, res) => {
    try {
      const repository = getRepository();
      if (!repository) throw new HttpError(503, "Beleidskompas database is not available");
      await run(repository, req, res);
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

  route("get", "/api/beleidskompas/state", async (repository, req, res) => {
    res.json({ ok: true, state: { ...await repository.getState(), default_flow: defaultFlow() } });
  });
  route("post", "/api/beleidskompas/templates", async (repository, req, res) => {
    const template = await repository.createTemplate(req.body?.name, flow(req.body?.flow ?? defaultFlow()));
    res.status(201).json({ ok: true, template });
  });
  route("post", "/api/beleidskompas/templates/:templateId/versions", async (repository, req, res) => {
    const version = await repository.saveVersion(req.params.templateId, flow(req.body?.flow), req.body?.note);
    res.status(201).json({ ok: true, version });
  });
  route("post", "/api/beleidskompas/templates/:templateId/versions/:versionId/deploy", async (repository, req, res) => {
    const live = await repository.deployVersion(req.params.templateId, req.params.versionId, publishLive);
    res.json({ ok: true, live });
  });
  route("post", "/api/beleidskompas/settings", async (repository, req, res) => {
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
    res.json({ ok: true, settings: await repository.saveSettings(settings) });
  });
  route("get", "/api/beleidskompas/templates/:templateId/export", async (repository, req, res) => {
    res.json(await repository.exportTemplate(req.params.templateId));
  });
  route("post", "/api/beleidskompas/import", async (repository, req, res) => {
    const template = await repository.importTemplate({ ...req.body, flow: flow(req.body?.flow) });
    res.status(201).json({ ok: true, template });
  });
  route("get", "/api/beleidskompas/documents", async (repository, req, res) => {
    res.json({ ok: true, documents: await repository.listDocuments() });
  });
  route("post", "/api/beleidskompas/documents", async (repository, req, res) => {
    res.status(201).json({ ok: true, document: await repository.uploadDocument(req.body || {}) });
  });
  route("patch", "/api/beleidskompas/documents/:docId", async (repository, req, res) => {
    res.json({ ok: true, document: await repository.updateDocument(req.params.docId, req.body?.filename) });
  });
  route("get", "/api/beleidskompas/documents/:docId/download", async (repository, req, res) => {
    const doc = await repository.getDocument(req.params.docId);
    res.setHeader("Content-Type", doc.mime_type);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.filename)}"`);
    res.send(doc.content);
  });
  route("delete", "/api/beleidskompas/documents/:docId", async (repository, req, res) => {
    await repository.deleteDocument(req.params.docId);
    res.json({ ok: true, removed: req.params.docId });
  });
}

module.exports = { mount };
