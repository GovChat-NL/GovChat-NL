"use strict";

/**
 * The HTTP endpoints of the Beleidskompas store.
 *
 * There are two kinds of caller. n8n is trusted: it sends the store token
 * (BELEIDSKOMPAS_STORE_TOKEN) with every request, as a bearer token or in
 * the header x-govchat-token, the same two ways the other internal
 * endpoints of this service take a token. Because n8n is trusted, it also
 * names the user the case belongs to (`user_id`, the LibreChat user id the
 * bridge passes on). The page is not trusted: it sends no token and names
 * no user; the user is read from the LibreChat login (`resolveUser`, the
 * same check the service does for the transcript sessions). The page can
 * only read, under /my. The repository checks every case against the user.
 *
 * The handlers are plain functions: they take `{ headers, params, query,
 * body }` and return `{ status, body }`. That keeps them testable without
 * express. mount() ties them to an express app; only there is express
 * loaded.
 *
 * Every endpoint answers JSON. An error from the repository (400, 403, 404, or
 * 503 while the database is not ready yet) becomes the HTTP status;
 * anything else is a 500 with a generic message.
 */

const { HttpError } = require("../shared/errors");
const { createTokenCheck } = require("../shared/internal-token");

function createBeleidskompasHandlers({ repository, internalToken, resolveUser, getLive }) {
  const refuseToken = createTokenCheck(internalToken);

  /** The answer when a request from n8n may not go through, or null when
   *  it may. */
  function refuse(req) {
    if (!repository) return { status: 503, body: { error: "Beleidskompas store is not configured" } };
    return refuseToken(req.headers);
  }

  // The user comes from the body of a write and from the query of a read.
  function userOf(req) {
    return String((req.body && req.body.user_id) || (req.query && req.query.user_id) || "").trim();
  }

  /** Turns the result of `work`, or the error it raised, into a response. */
  async function answer(work) {
    try {
      return { status: 200, body: await work() };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
      console.error("[beleidskompas-store]", err);
      return { status: 500, body: { error: "Beleidskompas store error" } };
    }
  }

  /** For n8n: runs `work` when the token is right. */
  function handle(req, work) {
    const refused = refuse(req);
    if (refused) return Promise.resolve(refused);
    return answer(work);
  }

  /** For the page: runs `work(userId)` for the logged-in LibreChat user. */
  function handleMine(req, work) {
    if (!repository) return Promise.resolve({ status: 503, body: { error: "Beleidskompas store is not configured" } });
    const user = typeof resolveUser === "function" ? resolveUser(req) : null;
    const userId = String((user && user.id) || "").trim();
    if (!userId) return Promise.resolve({ status: 401, body: { error: "Unauthorized" } });
    return answer(() => work(userId));
  }

  const q = (req) => req.query || {};
  const b = (req) => req.body || {};
  const p = (req) => req.params || {};

  return {
    // The live template for the orchestrator, read from the template tables.
    live: (req) => Promise.resolve(refuseToken(req.headers) || answer(async () => (typeof getLive === "function" ? getLive() : {}))),

    myCases: (req) => handleMine(req, (userId) => repository.listCases({ userId, limit: q(req).limit })),

    myCase: (req) =>
      handleMine(req, async (userId) => {
        const state = await repository.getState({ caseId: p(req).id, userId, maxTurns: q(req).max_turns });
        if (!state) throw new HttpError(404, "Unknown case");
        return state;
      }),

    listCases: (req) => handle(req, () => repository.listCases({ userId: userOf(req), limit: q(req).limit })),

    // The orchestrator also reads new cases, so an unknown case is empty
    // here. For the page it stays a 404.
    getCase: (req) =>
      handle(req, async () => {
        const state = await repository.getState({ caseId: p(req).id, userId: userOf(req), maxTurns: q(req).max_turns });
        return state || { id: p(req).id, case_text: null, reports: {}, turns: [] };
      }),

    setText: (req) => handle(req, () => repository.setCaseText({ caseId: p(req).id, userId: userOf(req), text: b(req).text })),

    setTitle: (req) =>
      handle(req, async () => {
        await repository.setTitle({ caseId: p(req).id, userId: userOf(req), title: b(req).title });
        return { ok: true };
      }),

    addReport: (req) =>
      handle(req, () =>
        repository.addReport({
          caseId: p(req).id,
          userId: userOf(req),
          substepId: b(req).substep_id,
          text: b(req).text,
          citations: b(req).citations,
          retrievalTrace: b(req).retrieval_trace,
        }),
      ),

    addTurn: (req) =>
      handle(req, () =>
        repository.addTurn({
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

/** Ties the handlers to an express app under `/api/beleidskompas`. The
 *  page's endpoints get the whole request, because `resolveUser` reads the
 *  cookies. */
function mount(app, { repository, internalToken, resolveUser, getLive }) {
  const handlers = createBeleidskompasHandlers({ repository, internalToken, resolveUser, getLive });
  const route = (handler) => (req, res) =>
    handler({ headers: req.headers, params: req.params, query: req.query, body: req.body, cookies: req.cookies }).then((answer) =>
      res.status(answer.status).json(answer.body),
    );
  app.get("/api/beleidskompas/live", route(handlers.live));
  app.get("/api/beleidskompas/my/cases", route(handlers.myCases));
  app.get("/api/beleidskompas/my/cases/:id", route(handlers.myCase));
  app.get("/api/beleidskompas/cases", route(handlers.listCases));
  app.get("/api/beleidskompas/cases/:id", route(handlers.getCase));
  app.put("/api/beleidskompas/cases/:id/text", route(handlers.setText));
  app.put("/api/beleidskompas/cases/:id/title", route(handlers.setTitle));
  app.post("/api/beleidskompas/cases/:id/reports", route(handlers.addReport));
  app.post("/api/beleidskompas/cases/:id/turns", route(handlers.addTurn));
}

module.exports = { createBeleidskompasHandlers, mount };
