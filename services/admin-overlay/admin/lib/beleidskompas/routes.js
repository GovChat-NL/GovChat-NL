"use strict";

/**
 * The HTTP endpoints of the Beleidskompas store, for n8n.
 *
 * n8n is a trusted caller: it sends the store token
 * (BELEIDSKOMPAS_STORE_TOKEN) with every request, as a bearer token or in
 * the header x-govchat-token, the same two ways the other internal
 * endpoints of this service take a token. Because n8n is trusted, it also
 * names the user the case belongs to (`user_id`, the LibreChat user id the
 * bridge passes on); the store checks every case against that user.
 *
 * The handlers are plain functions: they take `{ headers, params, query,
 * body }` and return `{ status, body }`. That keeps them testable without
 * express. mount() ties them to an express app; only there is express
 * loaded.
 *
 * Every endpoint answers JSON. An error from the store (400, 403, 404)
 * becomes the HTTP status; anything else is a 500 with a generic message.
 */

const { StoreError } = require("./store");

function suppliedToken(headers) {
  const auth = String((headers && headers.authorization) || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String((headers && headers["x-govchat-token"]) || "").trim();
}

function createBeleidskompasHandlers({ store, internalToken }) {
  const token = String(internalToken || "").trim();

  /** The answer when a request may not go through, or null when it may. */
  function refuse(req) {
    if (!store) return { status: 503, body: { error: "Beleidskompas store is not configured" } };
    if (!token) return { status: 503, body: { error: "Server misconfiguratie: BELEIDSKOMPAS_STORE_TOKEN ontbreekt" } };
    if (suppliedToken(req.headers) !== token) return { status: 401, body: { error: "Unauthorized" } };
    return null;
  }

  // The user comes from the body of a write and from the query of a read.
  function userOf(req) {
    return String((req.body && req.body.user_id) || (req.query && req.query.user_id) || "").trim();
  }

  /** Runs `work` for a request that passed the token check, and turns the
   *  result or the error into a response. */
  async function handle(req, work) {
    const refused = refuse(req);
    if (refused) return refused;
    try {
      return { status: 200, body: await work() };
    } catch (err) {
      if (err instanceof StoreError) return { status: err.status, body: { error: err.message } };
      console.error("[beleidskompas-store]", err);
      return { status: 500, body: { error: "Beleidskompas store error" } };
    }
  }

  const q = (req) => req.query || {};
  const b = (req) => req.body || {};
  const p = (req) => req.params || {};

  return {
    listCases: (req) => handle(req, () => store.listCases({ userId: userOf(req), limit: q(req).limit })),

    getCase: (req) =>
      handle(req, async () => {
        const state = await store.getState({ caseId: p(req).id, userId: userOf(req), maxTurns: q(req).max_turns });
        if (!state) throw new StoreError(404, "Unknown case");
        return state;
      }),

    setText: (req) => handle(req, () => store.setCaseText({ caseId: p(req).id, userId: userOf(req), text: b(req).text })),

    setTitle: (req) =>
      handle(req, async () => {
        await store.setTitle({ caseId: p(req).id, userId: userOf(req), title: b(req).title });
        return { ok: true };
      }),

    addReport: (req) =>
      handle(req, () =>
        store.addReport({
          caseId: p(req).id,
          userId: userOf(req),
          substepId: b(req).substep_id,
          content: b(req).content,
          text: b(req).text,
          citations: b(req).citations,
          retrievalTrace: b(req).retrieval_trace,
        }),
      ),

    addTurn: (req) =>
      handle(req, () =>
        store.addTurn({
          caseId: p(req).id,
          userId: userOf(req),
          role: b(req).role,
          stepId: b(req).step_id,
          askedFrom: b(req).asked_from,
          text: b(req).text,
        }),
      ),
  };
}

/** Ties the handlers to an express app under `/api/beleidskompas`. */
function mount(app, { store, internalToken }) {
  const handlers = createBeleidskompasHandlers({ store, internalToken });
  const route = (handler) => (req, res) =>
    handler({ headers: req.headers, params: req.params, query: req.query, body: req.body }).then((answer) =>
      res.status(answer.status).json(answer.body),
    );
  app.get("/api/beleidskompas/cases", route(handlers.listCases));
  app.get("/api/beleidskompas/cases/:id", route(handlers.getCase));
  app.put("/api/beleidskompas/cases/:id/text", route(handlers.setText));
  app.put("/api/beleidskompas/cases/:id/title", route(handlers.setTitle));
  app.post("/api/beleidskompas/cases/:id/reports", route(handlers.addReport));
  app.post("/api/beleidskompas/cases/:id/turns", route(handlers.addTurn));
}

module.exports = { createBeleidskompasHandlers, mount };
