"use strict";
const { resolve } = require("../../services/admin-overlay/admin/lib/manual-model");
function fixture() {
  return resolve({ enabled: true, sections: [{ id: "intro", title: "Welkom", content: '<p>Lees <a href="manual:secret">dit onderwerp</a>.</p>', items: [{ id: "secret", title: "Rechten", content: "<p>Vertrouwelijke instructie</p>", requires: ["prompts"], rights: ["prompts.share"] }] }], errorCategories: [{ id: "category", title: "Fouten", articles: [{ id: "err1", title: "Foutdocument", content: "<p>Controleer document</p>", requires: ["upload"], codes: ["bad_document"] }] }] });
}
module.exports = { fixture };
