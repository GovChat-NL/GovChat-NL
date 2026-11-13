const express = require("express");

const { createTemplateService } = require("../template-service");

// The admin routes under /api/beleidskompas (templates, versions, documents, settings, workflows).
// Mounted by lib/beleidskompas/index.js; the case routes of n8n and the page are in case-routes.js.
//
// Dependencies are passed in so this module does not reach into server.js globals.
//   store             the template store (template-store.js)
//   requireAuth       the admin auth middleware
//   flow              flow/workflow helpers that still live in server.js
function createAdminRouter({ store, requireAuth, flow }) {
  const service = createTemplateService({ store });
  const { getCurrentOr404, setTemplateDocument, findTemplateDocument } = service;
  const {
    DEFAULT_BELEIDSKOMPAS_SETTINGS, normalizeBeleidskompasFlow, defaultBeleidskompasFlow,
    readBeleidskompasWorkflowManifest, selectBeleidskompasRagDocs, normalizeLegacyState,
    publishLive, n8nBaseUrl, n8nWebhookToken,
  } = flow;
  const router = express.Router();

  router.get("/state", requireAuth, async (req, res) => {
    try {
      const live = await store.getLive();
      return res.json({
        ok: true,
        templates: await store.listTemplates(),
        settings: { ...DEFAULT_BELEIDSKOMPAS_SETTINGS, ...((await store.getSettings()) || {}) },
        live: live ? { template_id: live.template_id, version_id: live.version_id } : null,
        workflow_manifest: readBeleidskompasWorkflowManifest(),
      });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });


  router.post("/templates", requireAuth, async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ error: "name ontbreekt" });
      const fromId = req.body?.from_template_id;
      const src = fromId ? await getCurrentOr404(Number(fromId)) : null;
      const { template, version } = await store.createTemplate({
        name,
        snapshot: normalizeBeleidskompasFlow(req.body?.flow ?? src?.snapshot),
        documentIds: src?.documentIds || [],
        createdFromVersionId: src?.versionId || null,
        note: fromId ? `Aangemaakt vanuit template ${fromId}` : "Nieuw template",
      });
      return res.json({ ok: true, template, version });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });

  const templateIdParam = (req) => Number(req.params.id);

  router.post("/templates/:id/versions", requireAuth, async (req, res) => {
    try {
      const id = templateIdParam(req);
      const current = await getCurrentOr404(id);
      const { version } = await store.saveVersion(
        id, normalizeBeleidskompasFlow(req.body?.flow), current.documentIds, String(req.body?.note || ""));
      return res.json({ ok: true, version });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });

  // Makes an existing version the live one (the Deploy page) and regenerates the workflow files.
  router.post("/templates/:id/versions/:versionId/deploy", requireAuth, async (req, res) => {
    try {
      const id = templateIdParam(req);
      const versionId = Number(req.params.versionId);
      const template = (await store.listTemplates()).find((t) => t.id === id);
      if (!template) return res.status(404).json({ error: "Template niet gevonden" });
      if (!template.versions.some((v) => Number(v.id) === versionId)) {
        return res.status(404).json({ error: "Versie niet gevonden" });
      }
      await store.setLive(id, versionId);
      const workflow_manifest = await publishLive();
      return res.json({ ok: true, live: { template_id: id, version_id: versionId }, workflow_manifest });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });

  router.get("/templates/:id/export", requireAuth, async (req, res) => {
    try {
      const id = templateIdParam(req);
      const template = (await store.listTemplates()).find((t) => t.id === id);
      if (!template) return res.status(404).json({ error: "Template niet gevonden" });
      const current = await getCurrentOr404(id);
      const documents = [];
      for (const d of (await store.listDocuments(id)).filter((x) => x.active)) {
        documents.push({ ...d, content_base64: (await store.getDocument(d.id)).content.toString("base64") });
      }
      return res.json({
        name: template.name,
        live: current.snapshot,
        draft: current.snapshot,
        live_version_id: current.versionId,
        versions: template.versions,
        documents,
      });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });




  router.post("/settings", requireAuth, async (req, res) => {
    try {
      const current = { ...DEFAULT_BELEIDSKOMPAS_SETTINGS, ...((await store.getSettings()) || {}) };
      const incoming = req.body && typeof req.body === "object" ? req.body : {};
      const nextSettings = {
        ...current,
        ...incoming,
        retention_days: Math.max(1, Number.parseInt(String(incoming.retention_days ?? current.retention_days ?? 365), 10) || 365),
        enforce_source_citation: Boolean(
          Object.prototype.hasOwnProperty.call(incoming, "enforce_source_citation")
            ? incoming.enforce_source_citation
            : current.enforce_source_citation,
        ),
        require_human_validation: Boolean(
          Object.prototype.hasOwnProperty.call(incoming, "require_human_validation")
            ? incoming.require_human_validation
            : current.require_human_validation,
        ),
        default_model: String(incoming.default_model ?? current.default_model ?? "govchat-default").trim() || "govchat-default",
      };
      await store.saveSettings(nextSettings);
      return res.json({ ok: true, settings: nextSettings });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });

  router.get("/workflows/status", requireAuth, async (req, res) => {
    try {
      const live = await store.getLive();
      const flow = normalizeBeleidskompasFlow(live?.snapshot || defaultBeleidskompasFlow());
      const manifest = readBeleidskompasWorkflowManifest();
      const expectedStepCount = Array.isArray(flow.steps) ? flow.steps.length : 0;
      const mappedStepCount = Array.isArray(manifest?.steps) ? manifest.steps.length : 0;
      const stepMismatch = expectedStepCount !== mappedStepCount;

      return res.json({
        ok: true,
        n8n_base_url: n8nBaseUrl,
        token_configured: Boolean(n8nWebhookToken),
        step_count_expected: expectedStepCount,
        step_count_mapped: mappedStepCount,
        step_mismatch: stepMismatch,
        manifest: manifest || null,
      });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });

  router.post("/workflows/sync", requireAuth, async (req, res) => {
    try {
      const manifest = await publishLive();
      return res.json({ ok: true, source: "live", manifest });
    } catch (err) {
      return res.status(err.status || 500).json({ error: String(err?.message || err) });
    }
  });

  router.get("/templates/:id/documents", requireAuth, async (req, res) => {
    try {
      const id = templateIdParam(req);
      await getCurrentOr404(id);
      return res.json({ ok: true, documents: await store.listDocuments(id) });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });

  router.post("/templates/:id/documents", requireAuth, async (req, res) => {
    try {
      const id = templateIdParam(req);
      const filename = String(req.body?.filename || "").trim();
      const mimeType = String(req.body?.mime_type || "application/octet-stream").trim();
      const contentBase64 = String(req.body?.content_base64 || "").trim();
      if (!filename) return res.status(400).json({ error: "filename ontbreekt" });

      const bytes = contentBase64 ? Buffer.from(contentBase64, "base64") : Buffer.from("");
      let previewText = "Preview niet beschikbaar voor dit documenttype.";
      if (mimeType.startsWith("text/") || filename.toLowerCase().endsWith(".md") || filename.toLowerCase().endsWith(".txt")) {
        previewText = bytes.toString("utf-8").slice(0, 4000);
      }

      await getCurrentOr404(id);
      const { id: docId, reused } = await store.upsertDocument({ filename, contentType: mimeType, bytes, previewText });
      await setTemplateDocument(id, docId, true, "Document toegevoegd", filename);
      return res.status(201).json({ ok: true, document: await findTemplateDocument(id, docId), reused });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });

  router.patch("/templates/:id/documents/:docId", requireAuth, async (req, res) => {
    try {
      const id = templateIdParam(req);
      const docId = Number(req.params.docId);
      const filename = typeof req.body?.filename === "string" ? req.body.filename.trim() : "";
      await getCurrentOr404(id);
      if (!(await findTemplateDocument(id, docId))) return res.status(404).json({ error: "Document niet gevonden" });
      if (filename) await store.renameDocument(docId, filename);
      if (req.body?.active === false) await setTemplateDocument(id, docId, false, "Document verwijderd");
      if (req.body?.active === true) await setTemplateDocument(id, docId, true, "Document geactiveerd");
      const document = await findTemplateDocument(id, docId);
      if (!document) return res.status(404).json({ error: "Document niet gevonden" });
      return res.json({ ok: true, document });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });

  router.delete("/templates/:id/documents/:docId", requireAuth, async (req, res) => {
    try {
      const docId = Number(req.params.docId);
      await setTemplateDocument(templateIdParam(req), docId, false, "Document verwijderd");
      return res.json({ ok: true, removed: docId });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });

  router.get("/documents/:docId/preview", requireAuth, async (req, res) => {
    try {
      const doc = await store.getDocument(Number(req.params.docId));
      if (!doc) return res.status(404).json({ error: "Document niet gevonden" });
      return res.json({ ok: true, preview_text: String(doc.preview_text || "") });
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });

  router.get("/documents/:docId/download", requireAuth, async (req, res) => {
    try {
      const doc = await store.getDocument(Number(req.params.docId));
      if (!doc) return res.status(404).json({ error: "Document niet gevonden" });
      res.setHeader("Content-Type", String(doc.mime_type || "application/octet-stream"));
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(String(doc.filename || "document"))}"`);
      return res.status(200).send(doc.content);
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
  });

  router.post("/rag/query", requireAuth, async (req, res) => {
    try {
      const live = await store.getLive();
      if (!live) return res.status(400).json({ error: "Geen live versie" });
      const flow = normalizeBeleidskompasFlow(live.snapshot);
      const stepId = String(req.body?.step_id || "").trim();
      let step = Array.isArray(flow.steps) ? flow.steps.find((s) => String(s?.id || "") === stepId) : null;
      if (!step) step = Array.isArray(flow.steps) ? flow.steps[0] : null;
      if (!step) return res.status(400).json({ error: "Geen stappen geconfigureerd" });

      const result = selectBeleidskompasRagDocs({
        step,
        question: String(req.body?.question || ""),
        caseText: String(req.body?.case_text || ""),
        stepFields: req.body?.step_fields && typeof req.body.step_fields === "object" ? req.body.step_fields : {},
        documents: live.documents,
      });

      return res.json({
        ok: true,
        step_id: String(step.id || stepId),
        rag: result.rag,
        citations: result.docs.map((d, i) => ({
          rank: i + 1,
          id: d.id,
          filename: d.filename,
          score: Number(d.score.toFixed(4)),
          tags: d.tags,
          preview: d.preview,
        })),
        trace: {
          algorithm: result.rag.algorithm,
          top_k: result.rag.top_k,
          min_score: result.rag.min_score,
          tag_filter_mode: result.rag.tag_filter_mode,
          required_tags: result.rag.required_tags,
          matched_docs: result.docs.length,
        },
      });
    } catch (err) {
      return res.status(400).json({ error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
