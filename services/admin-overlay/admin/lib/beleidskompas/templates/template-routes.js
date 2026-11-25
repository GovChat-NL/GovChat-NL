"use strict";

/** The endpoints of the template editor: templates, their versions, the live
 *  version and the settings. */

const { HttpError } = require("../shared/errors");
const { createAdminRoute } = require("../shared/admin-route");

function mount(app, { requireAuth, getRepository, getService, normalizeFlow, defaultFlow, publishLive }) {
  const failure = "Template request failed";
  const repositoryRoute = createAdminRoute(app, { requireAuth, get: getRepository, failure });
  const serviceRoute = createAdminRoute(app, { requireAuth, get: getService, failure });
  const flow = (input) => {
    if (!input || typeof input !== "object" || !Array.isArray(input.steps)) throw new HttpError(400, "A template flow with steps is required");
    const normalized = normalizeFlow(input);
    // Reports and feedback are stored by substep id. The editor gives every substep one, so a
    // substep without an id comes from a hand-edited import.
    const ids = input.steps.flatMap((step) => (step?.substeps || []).map((sub) => String(sub?.id || "").trim()));
    if (ids.some((id) => !id)) throw new HttpError(400, "Every substep needs an id");
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) throw new HttpError(400, `Substep id ${duplicate} is used more than once`);
    return normalized;
  };

  repositoryRoute("get", "/api/beleidskompas/state", async (repository, req, res) => {
    res.json({ ok: true, state: { ...await repository.getState(), default_flow: defaultFlow() } });
  });
  repositoryRoute("post", "/api/beleidskompas/templates", async (repository, req, res) => {
    const template = await repository.createTemplate(req.body?.name, flow(req.body?.flow ?? defaultFlow()));
    res.status(201).json({ ok: true, template });
  });
  repositoryRoute("post", "/api/beleidskompas/templates/:templateId/versions", async (repository, req, res) => {
    const version = await repository.saveVersion(req.params.templateId, flow(req.body?.flow), req.body?.note);
    res.status(201).json({ ok: true, version });
  });
  repositoryRoute("post", "/api/beleidskompas/templates/:templateId/versions/:versionId/deploy", async (repository, req, res) => {
    const live = await repository.deployVersion(req.params.templateId, req.params.versionId, publishLive);
    res.json({ ok: true, live });
  });
  repositoryRoute("post", "/api/beleidskompas/settings", async (repository, req, res) => {
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
  serviceRoute("get", "/api/beleidskompas/templates/:templateId/export", async (service, req, res) => {
    res.json(await service.exportTemplate(req.params.templateId));
  });
  serviceRoute("post", "/api/beleidskompas/import", async (service, req, res) => {
    const template = await service.importTemplate({ ...req.body, flow: flow(req.body?.flow) });
    res.status(201).json({ ok: true, template });
  });
}

module.exports = { mount };
