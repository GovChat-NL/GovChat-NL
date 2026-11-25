"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { mount } = require("../lib/beleidskompas/documents/search-routes");

const TOKEN = "store-secret";

/** Sends a request to the search endpoint as express would, and returns
 *  `{ status, body }` of the answer. */
async function post(search, { token, body }) {
  let handlers;
  mount({ post: (path, ...added) => { handlers = added; } }, { internalToken: TOKEN, getSearch: () => search });

  const answer = { status: 200, body: null };
  const res = {
    status(code) { answer.status = code; return res; },
    json(value) { answer.body = value; },
  };
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body };
  const [requireToken, run] = handlers;
  let allowed = false;
  requireToken(req, res, () => { allowed = true; });
  if (allowed) await run(req, res);
  return answer;
}

test("the search endpoint needs the store token and passes the step and the question on", async () => {
  const asked = [];
  const search = { searchStep: async (stepId, question) => { asked.push([stepId, question]); return { document_count: 1, chunks: [] }; } };
  const body = { step_id: "stap1", question: "Welke rol past?" };

  assert.equal((await post(search, { body })).status, 401);
  assert.deepEqual(asked, []);

  assert.deepEqual(await post(search, { token: TOKEN, body }), { status: 200, body: { document_count: 1, chunks: [] } });
  assert.deepEqual(asked, [["stap1", "Welke rol past?"]]);

  assert.equal((await post(null, { token: TOKEN, body })).status, 503);
});
