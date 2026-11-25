"use strict";

const { HttpError } = require("./errors");

/**
 * Returns a function that adds a route to `app`. Such a route lets a
 * request through only when `requireAuth` does: the login of the admin UI,
 * or the token of n8n. The route answers 503 while `get` has nothing to
 * give, which is until the database is ready. What `get` gives is passed
 * to the handler of the route.
 *
 * An HttpError is answered with its status and message. Any other error is
 * logged and answered with 500 and `failure`, so no details leak.
 */
function createRoute(app, { requireAuth, get, failure }) {
  return (method, path, run) => app[method](path, requireAuth, async (req, res) => {
    try {
      const target = get();
      if (!target) throw new HttpError(503, "Beleidskompas database is not available");
      await run(target, req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(`[govchat-admin] ${failure}:`, err);
      res.status(500).json({ error: failure });
    }
  });
}

module.exports = { createRoute };
