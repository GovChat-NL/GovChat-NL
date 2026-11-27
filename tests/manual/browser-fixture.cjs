"use strict";
// Loopback-only fixture. Content is compiled/published by the production model,
// store and routes; only LibreChat identity/product configuration is synthetic.
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cookieParser = require("cookie-parser");
const { resolve } = require("../../services/admin-overlay/admin/lib/manual-model");
const { createManualStore } = require("../../services/admin-overlay/admin/lib/manual-store");
const { createManualContext } = require("../../services/admin-overlay/admin/lib/manual-context");
const { registerManualRoutes } = require("../../services/admin-overlay/admin/lib/manual-routes");
const ROOT = path.resolve(__dirname, "../..");

function model(autoOpen = "never") {
  return resolve({ enabled: true, agentEnabled: true, autoOpen,
    title: "GovChat — openbare testhandleiding", subtitle: "Synthetische browserfixture · geen productiegegevens",
    organization: { name: "Testorganisatie", appName: "GovChat Fixture" },
    visibility: { chapters: { verborgen: false }, topics: { verborgenonderwerp: false }, errors: true, categories: { verborgencategorie: false }, articles: { verborgenartikel: false } },
    sections: [
      { id: "welkom", title: "Welkom bij GovChat", content: '<p>Dit is openbare, synthetische testinhoud. Uw gesprek blijft beschikbaar.</p><p>Lees <a href="manual:documenten">Documenten gebruiken</a> of <a href="manual:rechten">Promptrechten</a>.</p><ul><li>Controleer bronnen en antwoorden.</li><li>Deel geen vertrouwelijke gegevens.</li></ul>', items: [
        { id: "documenten", title: "Documenten gebruiken", content: '<p>Upload een testdocument en controleer de leesbaarheid.</p><h3>Bronnen controleren</h3><p>Open een handleidingcitaat zonder uw gesprek te verlaten.</p>', requires: ["upload"] },
        { id: "rechten", title: "Promptrechten", content: "<p>RIGHTS_SENTINEL: alleen voor gebruikers met deelrechten.</p>", requires: ["prompts"], rights: ["prompts.share"] },
        { id: "verborgenonderwerp", title: "Verborgen onderwerp", content: "<p>HIDDEN_TOPIC_SENTINEL</p>" }
      ] },
      { id: "verborgen", title: "Verborgen ouder", content: "<p>HIDDEN_PARENT_SENTINEL</p>", items: [{ id: "ouderkind", title: "Kind van verborgen ouder", content: "<p>HIDDEN_CHILD_SENTINEL</p>" }] },
      { id: "beleidskompas", title: "Beleidskompas gebruiken", content: "<p>Maak een synthetische casus en doorloop de beleidsvragen.</p>", requires: ["beleidskompas"] }
    ],
    errorCategories: [
      { id: "problemen", title: "Problemen oplossen", articles: [
        { id: "probleem-algemeen", title: "Algemene probleemhulp", content: "<p>Controleer uw verbinding. Neem bij aanhoudende problemen contact op met uw testbeheerder.</p>" },
        { id: "bad-document", title: "Document kan niet worden gelezen", content: "<p>Gebruik een leesbaar testdocument. Probeer een kleiner bestand.</p>", codes: ["bad_document"], messages: ["Exacte vaste testmelding"], requires: ["upload"] },
        { id: "verborgenartikel", title: "Verborgen foutartikel", content: "<p>HIDDEN_ARTICLE_SENTINEL</p>", codes: ["hidden_error"] }
      ] },
      { id: "verborgencategorie", title: "Verborgen categorie", articles: [{ id: "categoriekind", title: "Kind van verborgen categorie", content: "<p>HIDDEN_CATEGORY_SENTINEL</p>" }] },
      { id: "oudercategorie", title: "Categorie onder verborgen hoofdstuk", parentId: "verborgen", articles: [{ id: "hoofdstukfout", title: "Fout onder verborgen ouder", content: "<p>HIDDEN_ERROR_PARENT_SENTINEL</p>" }] }
    ]
  });
}

async function startFixture() {
  const temp = path.join(ROOT, ".manual-tools/tmp"); fs.mkdirSync(temp, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temp, "browser-"));
  const store = createManualStore({ dataDir: path.join(directory, "data"), publishDir: path.join(directory, "public") });
  store.init(); store.publish(store.save(model(), store.adminState()));
  const app = express(); app.use(express.json({ limit: '2200kb', strict: true })); app.use(cookieParser());
  const calls = [];
  app.use((req, res, next) => { calls.push({ method: req.method, path: req.path }); next(); });
  const apps = { enabled: true, landing: { enabled: true, apps: ["chat", "beleidskompas"] }, apps: [
    { id: "chat", title: "Chat", name: "Chat", target: "navigate", url: "/c/fixture-conversation" },
    { id: "beleidskompas", title: "Beleidskompas", name: "Beleidskompas", target: "navigate", url: "/beleidskompas/" }
  ] };
  let restrictedShares = false;
  const userFor = req => req.get("authorization") === "Bearer fixture-privileged" ? "privileged" : req.get("authorization") === "Bearer fixture-restricted" ? "restricted" : null;
  app.post("/api/auth/refresh", (req, res) => req.cookies.fixtureUser === "anonymous" ? res.sendStatus(401) : res.json({ token: `fixture-${req.cookies.fixtureUser === "privileged" ? "privileged" : "restricted"}` }));
  app.get("/api/user", (req, res) => { const user = userFor(req); return user ? res.json({ id: `fixture-${user}`, role: user === "privileged" ? "ADMIN" : "USER" }) : res.sendStatus(401); });
  app.get("/api/config", (_req, res) => res.json({ appTitle: "GovChat Fixture", interface: { prompts: true } }));
  app.get("/api/convos", (_req, res) => res.json({ conversations: [], hasMore: false }));
  app.get("/api/roles/:role", (req, res) => userFor(req) ? res.json({ permissions: { PROMPTS: { USE: true, SHARE: userFor(req) === "privileged" || restrictedShares } } }) : res.sendStatus(401));
  app.get("/api/files/config", (_req, res) => res.json({ endpoints: { default: { disabled: false } } }));
  app.get("/govchat-overlay/apps.json", (_req, res) => res.json(apps));
  app.get("/govchat-overlay/beleidskompas-config.json", (_req, res) => res.json({}));
  let base;
  const context = createManualContext({ baseUrl: "http://127.0.0.1", readApps: () => apps,
    fetchImpl: (url, options) => {
      const parsed = new URL(url);
      if (parsed.origin !== "http://127.0.0.1" || !/^\/api\/(user|config|roles\/[^/]+|files\/config)$/.test(parsed.pathname)) throw Error("Fixture forbids outbound network");
      return fetch(base + parsed.pathname, options);
    }
  });
  // Equivalent local proxy mapping, before production route registration.
  app.use((req, _res, next) => { if (req.url.startsWith("/govchat-api/manual/")) req.url = req.url.replace("/govchat-api/manual/", "/api/manual/"); next(); });
  const admin = req => req.cookies.authfixture === "manual-browser-admin";
  registerManualRoutes(app, { store, context, isAuthenticated: admin, token: "fixture-internal-only" });
  app.get("/help-editor", (req, res) => admin(req) ? res.set("Cache-Control", "private, no-store").sendFile(path.join(ROOT, "services/admin-overlay/admin/views/help-editor.html")) : res.redirect("/login"));
  app.use("/help-editor-assets", (req, res, next) => admin(req) ? next() : res.redirect("/login"), express.static(path.join(ROOT, "services/admin-overlay/admin/views/help-editor-assets")));
  app.use("/overlay/src", express.static(path.join(ROOT, "overlay/src")));
  app.use("/govchat-overlay/src", express.static(path.join(ROOT, "overlay/src")));
  app.use("/start", express.static(path.join(ROOT, "overlay/src/apps/start")));
  app.use("/beleidskompas", express.static(path.join(ROOT, "overlay/src/apps/beleidskompas")));
  // Production page imports are relative to their deployed assets.
  app.use("/shared", express.static(path.join(ROOT, "overlay/src/shared")));
  app.use("/tests/manual", express.static(__dirname));
  app.get(["/c/:id", "/fixture"], (_req, res) => res.type("html").send(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GovChat acceptance fixture</title><style>body{font:16px/1.5 system-ui;margin:0;background:#f2f5f8;color:#203542}main{max-width:1000px;margin:40px auto;padding:24px}button{padding:10px;margin:6px}textarea{width:90%;min-height:70px}.dark body{background:#111b23;color:#edf4f8}aside{padding:16px;background:#dee8ef}</style></head><body><main id="fixture-chat"><h1>GovChat browserfixture</h1><p>Openbare synthetische acceptatietest · native slots zijn fixtures, geen volledige LibreChat-build.</p><div id="native-menu" data-govchat-manual-slot="menu"></div><div id="native-footer" data-govchat-manual-slot="footer"></div><button id="manual-open" data-gc-manual-entry>Handleiding openen</button><p id="conversation">Synthetisch gesprek: mijn testdocument</p><label>Testbericht<textarea id="composer">Niet-verzonden testbericht blijft behouden</textarea></label><p id="citations"></p><aside id="exact-error" data-govchat-manual-error data-govchat-error-code="bad_document"><span>Exacte vaste testmelding</span><div data-govchat-manual-error-actions></div></aside><aside id="unknown-error" data-govchat-manual-error data-govchat-error-code="unknown_fixture"><span>Onbekende testfout</span><div data-govchat-manual-error-actions></div></aside><p id="ordinary-text">bad_document in gewone gesprekstekst is geen foutcomponent</p></main><div id="already-inert" inert>Reeds inert testelement</div><script type="module" src="/tests/manual/browser-harness.js"></script></body></html>`));
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, store, setRestrictedShares(value) { restrictedShares = value === true; }, async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); } };
}
module.exports = { startFixture, model };
