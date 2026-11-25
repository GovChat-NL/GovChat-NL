"use strict";

/** The endpoints of the document library. */

const { StoreError } = require("../store");

function mount(app, { requireAuth, getStore }) {
  // Puts a document back in the queue, so it is indexed once more.
  // Answers 404 when the document does not exist.
  app.post("/api/beleidskompas/documents/:docId/reindex", requireAuth, async (req, res) => {
    try {
      const store = getStore();
      if (!store) throw new StoreError(503, "Beleidskompas database is not available");

      // A document id is a whole number above zero, written without a leading zero.
      const isId = /^[1-9]\d*$/.test(req.params.docId);
      const found = isId && (await store.requeue(req.params.docId));
      if (!found) throw new StoreError(404, "Document not found");

      res.json({ ok: true });
    } catch (err) {
      if (err instanceof StoreError) return res.status(err.status).json({ error: err.message });
      console.error("[govchat-admin] Document request failed:", err);
      res.status(500).json({ error: "Document request failed" });
    }
  });
}

module.exports = { mount };
