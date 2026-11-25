"use strict";

/** The endpoint an agent in n8n searches the documents of a step with. */

const { createAdminRoute } = require("../shared/admin-route");
const { requireToken } = require("../shared/internal-token");

function mount(app, { internalToken, getSearch }) {
  const route = createAdminRoute(app, { requireAuth: requireToken(internalToken), get: getSearch, failure: "Search request failed" });

  route("post", "/api/beleidskompas/search", async (search, req, res) => {
    res.json(await search.searchStep(req.body?.step_id, req.body?.question));
  });
}

module.exports = { mount };
