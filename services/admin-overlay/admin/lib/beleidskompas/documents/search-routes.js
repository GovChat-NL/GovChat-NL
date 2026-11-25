"use strict";

/** The endpoint an agent in n8n searches the documents of a step with. */

const { createRoute } = require("../shared/route");
const { requireToken } = require("../shared/internal-token");

function mount(app, { internalToken, getSearch }) {
  const route = createRoute(app, { requireAuth: requireToken(internalToken), get: getSearch, failure: "Search request failed" });

  route("post", "/api/beleidskompas/search", async (search, req, res) => {
    res.json(await search.searchStep(req.body?.step_id, req.body?.question));
  });
}

module.exports = { mount };
