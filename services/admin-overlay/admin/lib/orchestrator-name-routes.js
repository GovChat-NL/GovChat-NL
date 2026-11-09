"use strict";
const { validateName } = require("./orchestrator-name");

function registerNameRoutes(app, { store, isAuthenticated }) {
  const adminPath = "/api/orchestrator/name";
  function noStore(req, res, next) {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
    next();
  }
  app.use(adminPath, noStore, (req, res, next) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: "Beheerderssessie vereist" });
    if (req.method !== "GET") {
      const origin = req.get("origin");
      const site = req.get("sec-fetch-site");
      let allowed = !origin;
      if (origin) {
        try {
          const parsed = new URL(origin);
          allowed = ["http:", "https:"].includes(parsed.protocol) && parsed.origin === origin && parsed.host === req.get("host");
        } catch { allowed = false; }
      }
      if (!allowed || (site && !["same-origin", "none"].includes(site))) return res.status(403).json({ error: "Cross-site verzoek geweigerd" });
      if (req.method === "POST" && !req.is("application/json")) return res.status(415).json({ error: "JSON vereist" });
    }
    next();
  });
  function read(req, res) {
    try { res.json(store.read()); }
    catch { res.status(503).json({ error: "Naamconfiguratie ongeldig of onbereikbaar; herstel of reset vereist" }); }
  }
  app.get(adminPath, read);
  app.get("/api/config/orchestrator/name", noStore, read);
  app.post(adminPath, (req, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).join(",") !== "display_name") return res.status(400).json({ error: "Uitsluitend display_name toegestaan" });
    try { validateName(req.body.display_name); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try { res.json(store.save(req.body.display_name)); }
    catch { res.status(503).json({ error: "Naam kon niet veilig worden opgeslagen of gepubliceerd" }); }
  });
  app.delete(adminPath, (req, res) => {
    try { res.json(store.reset()); }
    catch { res.status(503).json({ error: "Reset mislukt; controleer opslag en omgeving" }); }
  });
  // Publish the effective environment/default name before accepting traffic.
  store.read();
}
module.exports = { registerNameRoutes };
