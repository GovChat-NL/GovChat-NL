"use strict";

const crypto = require("node:crypto");

function registerPromptRoutes(app, { store, isAuthenticated, token, extractToken }) {
  const adminPath = "/api/orchestrator/prompt";
  const runtimePath = "/api/internal/orchestrator/prompt";
  function noStore(req, res, next) {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
    next();
  }
  function adminAuth(req, res, next) {
    if (!isAuthenticated(req)) return res.status(401).json({ error: "Beheerderssessie vereist" });
    if (req.method !== "GET") {
      const site = req.get("sec-fetch-site");
      const origin = req.get("origin");
      let originAllowed = !origin;
      if (origin) {
        try {
          const parsed = new URL(origin);
          // TLS may terminate at the existing management proxy, not Express.
          originAllowed = ["http:", "https:"].includes(parsed.protocol) && parsed.origin === origin && parsed.host === req.get("host");
        } catch { originAllowed = false; }
      }
      if ((site && site !== "same-origin" && site !== "none") || !originAllowed) {
        return res.status(403).json({ error: "Cross-site verzoek geweigerd" });
      }
    }
    next();
  }
  function runtimeAuth(req, res, next) {
    if (!token) return res.status(503).json({ error: "Interne promptauthenticatie is niet geconfigureerd" });
    const supplied = Buffer.from(String(extractToken(req) || ""));
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  }
  function read(req, res) {
    try { res.json(store.read()); }
    catch { res.status(503).json({ error: "Masterpromptconfiguratie is ongeldig of onbereikbaar; herstel of reset vereist" }); }
  }
  app.use(adminPath, noStore, adminAuth);
  app.use(runtimePath, noStore, runtimeAuth);
  app.get(adminPath, read);
  app.get(runtimePath, read);
  app.post(adminPath, (req, res) => {
    const body = req.body;
    if (!body || Array.isArray(body) || Object.keys(body).join(",") !== "prompt") {
      return res.status(400).json({ error: "Verzoek moet uitsluitend het veld prompt bevatten" });
    }
    try {
      const { validatePrompt } = require("./orchestrator-prompt");
      validatePrompt(body.prompt);
    } catch (error) { return res.status(400).json({ error: error.message }); }
    try { res.json(store.save(body.prompt)); }
    catch { res.status(503).json({ error: "Masterprompt kon niet veilig worden opgeslagen" }); }
  });
  app.delete(adminPath, (req, res) => {
    try { res.json(store.reset()); }
    catch { res.status(503).json({ error: "Reset mislukt; controleer opslag en omgevingsconfiguratie" }); }
  });
}

module.exports = { registerPromptRoutes };
