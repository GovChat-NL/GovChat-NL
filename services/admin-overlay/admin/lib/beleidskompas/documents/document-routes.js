"use strict";

/** The endpoints of the document library. */

const { createAdminRoute } = require("../shared/admin-route");

function mount(app, { requireAuth, getRepository }) {
  const route = createAdminRoute(app, { requireAuth, get: getRepository, failure: "Document request failed" });

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

  // Puts a document back in the queue, so it is indexed once more.
  route("post", "/api/beleidskompas/documents/:docId/reindex", async (repository, req, res) => {
    await repository.requeue(req.params.docId);
    res.json({ ok: true });
  });
}

module.exports = { mount };
