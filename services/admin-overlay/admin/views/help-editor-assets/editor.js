/* Private Dutch admin editor. The server compiler remains the validation authority. */
(function () {
  "use strict";
  const clone = value => JSON.parse(JSON.stringify(value));
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
  const get = (object, path) => path.split(".").reduce((value, key) => own(value, key) ? value[key] : undefined, object);
  function put(object, path, value) {
    const parts = path.split(".");
    let target = object;
    for (const part of parts.slice(0, -1)) {
      if (part === "__proto__") throw new Error("Ongeldig veld");
      if (!own(target, part)) target[part] = {};
      target = target[part];
    }
    const last = parts.at(-1);
    if (last === "__proto__") throw new Error("Ongeldig veld");
    target[last] = clone(value);
  }
  const CAPABILITIES = ["chat", "history", "upload", "files", "prompts", "temporaryChat", "sharedLinks", "webSearch", "fileSearch", "models", "beleidskompas", "image", "transcript", "simplifier", "nos_news", "l1_news", "holidays", "time", "calculator", "openbesluitvorming", "topdesk"];
  const RIGHTS = ["prompts.use", "prompts.create", "prompts.edit", "prompts.share", "prompts.sharePublic"];
  const CAP_LABELS = ["Chat", "Geschiedenis", "Uploaden", "Bestanden", "Promptbibliotheek", "Tijdelijke chat", "Gedeelde links", "Webzoeken", "Bestandszoeken", "Modelkeuze", "Beleidskompas", "Afbeeldingen", "Transcriptie", "Versimpelaar", "NOS-nieuws", "L1-nieuws", "Feestdagen", "Tijd", "Rekenmachine", "OpenBesluitvorming", "Topdesk"];
  const RIGHT_LABELS = ["Prompts gebruiken", "Prompts maken", "Prompts bewerken", "Prompts delen", "Prompts openbaar delen"];
  const ORG = { appName: "Naam van de toepassing", name: "Organisatienaam", helpdeskEmail: "E-mail helpdesk", aiEmail: "E-mail AI-vragen", trainingEmail: "E-mail opleidingen", privacyEmail: "E-mail privacyvragen", courseUrl: "Link naar cursus", policyUrl: "Link naar beleid", incidentUrl: "Link voor incidentmeldingen" };
  const SOURCE = { default: "Generieke standaard", profile: "Gekozen profiel", "deployment-file": "Deploymentbestand", admin: "Opgeslagen beheerwijziging", "admin-import": "Geïmporteerd concept", cli: "Bestandsbeheer" };
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function safeLink(value) {
    if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f\\]/.test(value)) return false;
    if (/^manual:[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) return true;
    if (/^\{\{(?:COURSE_URL|POLICY_URL|INCIDENT_URL)\}\}$/.test(value) || /^mailto:\{\{(?:SUPPORT_EMAIL|AI_EMAIL|TRAINING_EMAIL|PRIVACY_EMAIL)\}\}$/.test(value)) return true;
    if (/^\/(?!\/)/.test(value)) return true;
    if (/^mailto:[^?@<>]+@[^?@<>]+\.[^?@<>]+$/.test(value)) return true;
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  }
  function blankNode(id, title) { return { id, title, content: "<p>Schrijf hier de uitleg.</p>", items: [], aliases: [], requires: [], rights: [], related: [], codes: [], messages: [] }; }
  function entries(model) {
    return [
      ...model.sections.flatMap(s => [{ node: s, kind: "chapters", root: "sections", parent: null }, ...s.items.map(node => ({ node, kind: "topics", root: "sections", parent: s }))]),
      ...model.errorCategories.flatMap(c => [{ node: c, kind: "categories", root: "errorCategories", parent: null }, ...c.articles.map(node => ({ node, kind: "articles", root: "errorCategories", parent: c }))])
    ];
  }
  function matching(entry, query) {
    const text = [entry.node.id, entry.node.title, entry.node.content || "", ...(entry.node.codes || []), ...(entry.node.messages || []), ...(entry.node.aliases || [])].join(" ").toLocaleLowerCase("nl");
    return query.toLocaleLowerCase("nl").trim().split(/\s+/).every(word => text.includes(word));
  }
  function uniqueId(model, prefix) {
    const ids = new Set(entries(model).flatMap(e => [e.node.id, ...(e.node.aliases || [])]));
    let index = 1;
    while (ids.has(`${prefix}-${index}`)) index++;
    return `${prefix}-${index}`;
  }
  function move(list, index, step) {
    const target = index + step;
    if (index < 0 || target < 0 || target >= list.length) return false;
    [list[index], list[target]] = [list[target], list[index]];
    return true;
  }
  function previewPage(passage) {
    // Only compiler HTML is inserted here. Metadata is always escaped. The frame is sandboxed.
    const inertHTML = passage.html.replace(/ href="[^"]*"/g, "");
    return '<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body><h1>' + escape(passage.title) + '</h1>' + inertHTML + '</body></html>';
  }
  function reasonText(reason) {
    const fixed = { "manual-disabled": "Handleiding uitgeschakeld", "deployment-disabled": "Deploymentvergrendeling", "chapters-hidden": "Hoofdstuk of ouderhoofdstuk verborgen", "topics-hidden": "Onderwerp of ouderonderwerp verborgen", "articles-hidden": "Artikel verborgen", "errors-hidden": "Hele foutennaslagwerk verborgen", "categories-hidden": "Categorie verborgen", "category-hidden": "Categorie verborgen" };
    if (fixed[reason]) return `${fixed[reason]} (${reason})`;
    if (reason.startsWith("capability:")) { const id = reason.slice(11); return `Functie niet aangetoond: ${CAP_LABELS[CAPABILITIES.indexOf(id)] || id} (${reason})`; }
    if (reason.startsWith("right:")) { const id = reason.slice(6); return `Recht niet aangetoond: ${RIGHT_LABELS[RIGHTS.indexOf(id)] || id} (${reason})`; }
    return reason;
  }
  function importPayload(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Een JSON-object is vereist");
    let model = value, explicit = false;
    if (value.type === "govchat-manual-overrides" && value.overrides) { model = value.overrides; explicit = true; }
    else if (value.ok === true && value.model) model = value.model;
    if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error("Een JSON-model is vereist");
    const legacy = !explicit && model.schemaVersion === undefined && Array.isArray(model.sections) && Object.keys(model).every(k => ["title", "subtitle", "sections"].includes(k));
    const full = !explicit && model.schemaVersion !== undefined;
    return { path: full || legacy ? "/import" : "/draft", method: full || legacy ? "POST" : "PUT", model };
  }
  class Session {
    constructor(fetchImpl, base) { this.fetch = fetchImpl; this.base = base; this.state = null; this.conflict = false; this.uncertain = false; }
    accept(state) { this.state = state; this.overrides = clone(state.overrides); this.model = clone(state.model); this.conflict = false; this.uncertain = false; }
    get dirty() { return !!this.state && JSON.stringify(this.overrides) !== JSON.stringify(this.state.overrides); }
    edit(path, value) { put(this.overrides, path, value); put(this.model, path, value); }
    array(root) { if (!own(this.overrides, root)) this.overrides[root] = clone(this.model[root]); this.model[root] = this.overrides[root]; return this.model[root]; }
    async request(path = "", method = "GET", body) {
      let response;
      try { response = await this.fetch(this.base + path, { method, credentials: "same-origin", cache: "no-store", redirect: "error", headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
      catch { const error = new Error("Verbinding mislukt. Controleer de actuele staat voordat u opnieuw wijzigt."); error.status = 0; throw error; }
      let data;
      try { data = await response.json(); } catch { const error = new Error("Ongeldig serverantwoord. Herlaad de actuele staat; uw lokale wijzigingen zijn behouden."); error.status = response.status >= 400 ? response.status : 503; throw error; }
      if (!response.ok || data.ok !== true) {
        const error = new Error(data.error?.message || "Het verzoek is niet uitgevoerd"); error.status = response.status; error.code = data.error?.code; throw error;
      }
      return data;
    }
    async mutate(path, body = {}, method = "POST") {
      if (!this.state || this.conflict || this.uncertain) throw new Error("Laad en vergelijk eerst de actuele staat; er wordt niet blind opnieuw geprobeerd.");
      const payload = { ...body, baseRevision: this.state.baseRevision, draftRevision: this.state.draftRevision };
      try { const state = await this.request(path, method, payload); this.accept(state); return state; }
      catch (error) { if (error.status === 409) this.conflict = true; if (error.status === 0 || error.status >= 500) this.uncertain = true; throw error; }
    }
  }
  const core = { Session, get, put, entries, matching, uniqueId, move, blankNode, safeLink, previewPage, importPayload, CAPABILITIES, RIGHTS };
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (typeof document === "undefined") return;

  const $ = id => document.getElementById(id);
  const session = new Session(window.fetch.bind(window), new URL("api/admin/manual", new URL(".", window.location.href)).pathname);
  let tab = "settings", selected = null, query = "", categoryFilter = "", visibilityFilter = "", busy = false, previewDocument = null;
  let serial = 0;
  function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
  function button(text, handler, className) { const node = el("button", text, className); node.type = "button"; node.addEventListener("click", handler); return node; }
  function say(message, error = false) { $("status").textContent = message; $("status").classList.toggle("error", error); $("status").setAttribute("role", error ? "alert" : "status"); }
  function fail(error) {
    say(error.status === 401 ? "Uw beheerderssessie is verlopen. Meld u opnieuw aan; download zo nodig eerst uw lokale wijzigingen." : `${error.message}${error.code ? ` (${error.code})` : ""}`, true);
    if (session.conflict || session.uncertain) { $("conflict").hidden = false; $("conflict-title").textContent = session.conflict ? "Een andere beheerder heeft iets gewijzigd" : "De uitkomst is onzeker — controleer de actuele staat"; }
    updateActions();
  }
  async function run(action) {
    if (busy) return;
    busy = true; updateActions(); $("workspace").inert = true; $("workspace").setAttribute("aria-busy", "true");
    try { await action(); } catch (error) { fail(error); }
    finally { busy = false; $("workspace").inert = false; $("workspace").setAttribute("aria-busy", "false"); updateActions(); }
  }
  function updateActions() {
    const loaded = !!session.state, locked = session.conflict || session.uncertain;
    for (const id of ["save", "publish", "disable"]) $(id).disabled = busy || !loaded || locked;
    $("publish").disabled ||= session.dirty || !!session.state?.hardDisabled;
    for (const id of ["preview", "export"]) $(id).disabled = busy || !loaded;
    $("export").disabled ||= session.dirty;
    for (const id of ["reload", "compare", "reload-conflict", "local-export"]) $(id).disabled = busy;
    if (loaded) $("revision").textContent = `Live revisie: ${session.state.baseRevision} · Conceptrevisie: ${session.state.draftRevision} · ${session.dirty ? "Niet-bewaarde wijzigingen" : "Concept bewaard"}`;
  }
  function edited() {
    previewDocument = null;
    $("preview-panel").hidden = true;
    say("Lokale wijziging. Bewaar het concept en controleer daarna de preview; er is nog niets gepubliceerd."); updateActions(); refreshSources();
  }
  function source(path, container) {
    const line = el("div", undefined, "source"), description = el("span"); line.append(description);
    const reset = button("Terug naar overerving", () => run(async () => {
      if (session.dirty) { say("Bewaar eerst het concept. Reset verwijdert daarna uitsluitend deze opgeslagen override; overige velden blijven behouden.", true); return; }
      if (!window.confirm(`Override voor ${path} verwijderen en terugvallen op profiel/deployment/standaard? Dit wijzigt alleen het concept.`)) return;
      await session.mutate("/reset", { path }); previewDocument = null; render(); say("Override verwijderd. Controleer het concept vóór publicatie.");
    }));
    line.updateSource = () => {
      const value = get(session.overrides, path), saved = get(session.state.overrides, path), explicit = value !== undefined;
      const from = explicit && JSON.stringify(value) !== JSON.stringify(saved) ? "Lokale wijziging (nog niet bewaard)" : SOURCE[session.state.sources[path]] || session.state.sources[path] || (explicit ? "Expliciete override" : "Overgeërfd");
      description.textContent = `Bron: ${from}${explicit ? " · expliciete override" : " · overgeërfd"}`;
      reset.disabled = !explicit || session.conflict || session.uncertain;
    };
    line.append(" ", reset); line.updateSource(); container.append(line); return line;
  }
  function refreshSources() { for (const line of document.querySelectorAll(".source")) line.updateSource?.(); }
  function field(parent, label, value, onChange, options = {}) {
    const box = el("div", undefined, "field"), id = `field-${++serial}`;
    const caption = el("label", label); caption.htmlFor = id;
    const input = el(options.choices ? "select" : options.multiline ? "textarea" : "input"); input.id = id;
    if (options.choices) for (const [key, title] of options.choices) { const option = el("option", title); option.value = key; input.append(option); }
    else if (!options.multiline) input.type = options.type || "text";
    if (options.max) input.maxLength = options.max;
    input.value = value ?? "";
    input.addEventListener(options.choices ? "change" : "input", () => onChange(options.boolean ? input.value === "true" : input.value));
    box.append(caption, input);
    if (options.hint) { const hint = el("p", options.hint, "hint"); hint.id = `${id}-hint`; input.setAttribute("aria-describedby", hint.id); box.append(hint); }
    parent.append(box); return box;
  }
  function settings() {
    const panel = el("section", undefined, "panel"); panel.append(el("h2", "Instellingen"));
    panel.append(el("p", "Leeg is bewust leeg; ‘Nee’ is bewust uit. Gebruik ‘Terug naar overerving’ om een opgeslagen override te verwijderen. Profielafhankelijke waarden worden na concept bewaren opnieuw samengesteld.", "hint"));
    const grid = el("div", undefined, "grid"); panel.append(grid);
    const definitions = [
      ["enabled", "Handleiding beschikbaar", { choices: [["false", "Nee (standaard)"], ["true", "Ja"]], boolean: true }],
      ["agentEnabled", "Handleidingtool voor de agent", { choices: [["true", "Ja, wanneer de handleiding beschikbaar is"], ["false", "Nee"]], boolean: true }],
      ["autoOpen", "Automatisch openen", { choices: [["never", "Nooit"], ["first-use", "Bij eerste gebruik"], ["new-revision", "Bij nieuwe inhoudsrevisie"], ["every-session", "Iedere sessie"]] }],
      ["profile", "Organisatieprofiel", { choices: [["generic", "Generiek"], ["limburg", "Limburg / LAICA (controle vereist)"]] }],
      ["title", "Titel", { max: 400 }], ["subtitle", "Ondertitel", { max: 1000 }],
      ["reviewedAt", "Datum inhoud gecontroleerd", { max: 40, hint: "Bijvoorbeeld 2026-11-27. Vul alleen een werkelijk uitgevoerde controle in." }]
    ];
    for (const [path, label, options] of definitions) {
      const box = field(grid, label, get(session.model, path), value => { session.edit(path, value); edited(); if (path === "profile") say("Profiel gewijzigd. Bewaar het concept om de overgeërfde organisatievelden en profielwaarschuwing te vernieuwen."); }, options); source(path, box);
    }
    const review = session.state.profileReview;
    if (review) { const note = el("div", undefined, "notice warning"); note.append(el("h3", "Profielcontrole vereist"), el("p", review.note), el("pre", JSON.stringify(review.required, null, 2))); panel.append(note); }
    panel.append(el("h2", "Organisatie en contactgegevens"));
    const org = el("div", undefined, "grid"); panel.append(org);
    for (const [key, label] of Object.entries(ORG)) {
      const path = `organization.${key}`;
      const box = field(org, label, get(session.model, path), value => { session.edit(path, value); edited(); }, { type: key.endsWith("Email") ? "email" : "text", max: 2048 }); source(path, box);
    }
    panel.append(el("p", "In teksten kunt u deze invulvelden gebruiken: {{APP_NAME}}, {{ORG_NAME}}, {{SUPPORT_EMAIL}}, {{AI_EMAIL}}, {{TRAINING_EMAIL}}, {{PRIVACY_EMAIL}}, {{COURSE_URL}}, {{POLICY_URL}}, {{INCIDENT_URL}}. De preview vult ze veilig in.", "hint"));
    $("workspace").append(panel);
  }
  function visibleReasons(entry) {
    if (previewDocument && entry.kind !== "categories") return previewDocument.passages.find(p => p.id === entry.node.id)?.hiddenReasons || [];
    const why = [], flags = session.model.visibility;
    if (session.state.hardDisabled) why.push("deployment-disabled"); else if (!session.model.enabled) why.push("manual-disabled");
    if (flags[entry.kind]?.[entry.node.id] === false) why.push(`${entry.kind}-hidden`);
    if (entry.parent && flags[entry.kind === "topics" ? "chapters" : "categories"]?.[entry.parent.id] === false) why.push("ouder verborgen");
    if (["categories", "articles"].includes(entry.kind)) {
      if (!flags.errors) why.push("errors-hidden");
      const parentId = entry.kind === "categories" ? entry.node.parentId : entry.parent.parentId;
      const parent = entries(session.model).find(e => e.node.id === parentId);
      if (parent && visibleReasons(parent).length) why.push("gekoppeld hoofdstuk/onderwerp beperkt");
    }
    if ((entry.node.requires || []).length || (entry.node.rights || []).length || (entry.parent?.requires || []).length || (entry.parent?.rights || []).length) why.push("afhankelijk van functies/rechten");
    return [...new Set(why)];
  }
  function catalog() {
    const root = tab === "chapters" ? "sections" : "errorCategories";
    const panel = el("section", undefined, "panel");
    panel.append(el("h2", tab === "chapters" ? "Hoofdstukken en onderwerpen" : "Foutcategorieën en artikelen"));
    panel.append(el("p", "Een bewerking vervangt de volledige geordende lijst als override, inclusief ongewijzigde en verborgen onderdelen. Er is geen automatische samenvoeging op ID. Nieuwe standaardinhoud wordt dan niet vanzelf toegevoegd. Reset van deze lijst herstelt overerving voor de hele lijst.", "notice warning"));
    source(root, panel);
    if (tab === "errors") visibility(panel, "visibility.errors", "Hele foutennaslagwerk beschikbaar");
    const split = el("div", undefined, "split"), left = el("div"), right = el("div"); split.append(left, right); panel.append(split);
    const searchBox = field(left, "Zoeken in titel, ID, code, melding en inhoud", query, value => { query = value; fillList(); }, { type: "search" });
    if (tab === "errors") field(left, "Categorie filteren", categoryFilter, value => { categoryFilter = value; fillList(); }, { choices: [["", "Alle categorieën"], ...session.model.errorCategories.map(c => [c.id, c.title])] });
    field(left, "Zichtbaarheidsfilter", visibilityFilter, value => { visibilityFilter = value; fillList(); }, { choices: [["", "Alle onderdelen"], ["limited", "Verborgen of voorwaardelijk"], ["general", "Geen bekende beperking"]] });
    const list = el("div", undefined, "catalog"); list.setAttribute("aria-label", "Onderdelen");
    const count = el("p", "", "hint"); left.append(count, list);
    const add = button(tab === "chapters" ? "Hoofdstuk toevoegen" : "Categorie toevoegen", () => {
      const array = session.array(root), id = uniqueId(session.model, tab === "chapters" ? "hoofdstuk" : "categorie");
      array.push(tab === "chapters" ? blankNode(id, "Nieuw hoofdstuk") : { id, title: "Nieuwe categorie", articles: [] }); selected = id; edited(); render(); focusEditor();
    }); left.append(add);
    function fillList() {
      list.replaceChildren();
      const all = entries(session.model).filter(e => e.root === root);
      const filtered = all.filter(e => matching(e, query) && (!categoryFilter || e.node.id === categoryFilter || e.parent?.id === categoryFilter) && (!visibilityFilter || (visibleReasons(e).length > 0) === (visibilityFilter === "limited")));
      count.textContent = `${filtered.length} van ${all.length} onderdelen. ‘Geen bekende beperking’ is geen bewijs van gebruikerszichtbaarheid; controleer de serverpreview.`;
      for (const entry of filtered) {
        const item = button(entry.node.title, () => { selected = entry.node.id; fillList(); editNode(right, entry.node.id); focusEditor(); }, entry.parent ? "child" : "");
        if (selected === entry.node.id) item.setAttribute("aria-current", "true");
        item.append(el("small", `${entry.node.id} · ${visibleReasons(entry).map(reasonText).join(", ") || "geen bekende beperking"}`)); list.append(item);
      }
      if (!filtered.length) list.append(el("p", "Geen onderdelen gevonden. Pas de filters aan."));
    }
    fillList();
    if (!allEntry(selected, root)) selected = entries(session.model).find(e => e.root === root)?.node.id || null;
    if (selected) editNode(right, selected); else right.append(el("p", "Voeg een onderdeel toe om te beginnen."));
    $("workspace").append(panel);
    // Keep references for immediate title/filter updates without replacing the focused field.
    panel.refreshList = fillList; searchBox.classList.add("search"); fillList();
  }
  function allEntry(id, root) { return entries(session.model).find(e => e.node.id === id && (!root || e.root === root)); }
  function focusEditor() { $("node-heading")?.focus(); }
  function visibility(parent, path, title) {
    const value = get(session.model, path);
    const box = field(parent, title, value === false ? "false" : "true", v => { session.edit(path, v); edited(); refreshList(); }, { choices: [["true", "Toestaan, als ouders/functies/rechten dit toelaten"], ["false", "Verbergen"]], boolean: true });
    source(path, box);
    box.append(el("p", "Een zichtbaar kind kan een verborgen ouder niet overrulen. Deze instelling schakelt geen toepassing of gebruikersrecht in.", "hint"));
  }
  function refreshList() { for (const panel of $("workspace").children) if (panel.refreshList) panel.refreshList(); }
  function editNode(parent, id) {
    parent.replaceChildren();
    const entry = allEntry(id); if (!entry) return;
    const { node, kind, root } = entry;
    const title = el("h3", node.title); title.id = "node-heading"; title.tabIndex = -1; parent.append(title);
    function change(key, value) {
      session.array(root); const target = allEntry(selected).node; target[key] = value; edited(); refreshList();
    }
    field(parent, "Titel", node.title, value => { change("title", value); title.textContent = value; }, { max: 400 });
    const identity = el("details"); identity.append(el("summary", "ID en verwijzingen (geavanceerd)")); parent.append(identity);
    field(identity, "Stabiel ID", node.id, () => {}, { hint: "Een bestaand ID wijzigen kan oude links breken. Gebruik de knop om het ID bewust te wijzigen en de oude naam als alias te bewaren." });
    identity.querySelector("input").readOnly = true;
    identity.append(button("ID wijzigen", () => {
      const next = window.prompt("Nieuw uniek ID (letters/cijfers, underscore of koppelteken, maximaal 80 tekens)", node.id);
      if (!next || next === node.id) return;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(next) || entries(session.model).some(e => e.node.id === next || e.node.aliases?.includes(next))) { say("Dit ID is ongeldig of al in gebruik.", true); return; }
      if (!window.confirm("Het oude ID blijft als alias behouden voor passages. Verwijzingen en zichtbaarheid worden bijgewerkt. Categorieën hebben geen aliases. Doorgaan?")) return;
      rename(entry, next); edited(); render(); focusEditor();
    }));
    if (kind === "categories") {
      field(parent, "Hoofdstuk of onderwerp waarvan deze categorie erft", node.parentId || "", value => {
        session.array(root); const target = allEntry(selected).node; if (value) target.parentId = value; else delete target.parentId; edited(); refreshList();
      }, { choices: [["", "Geen gekoppelde ouder (wel naslagwerk-instelling)"], ...entries(session.model).filter(e => ["chapters", "topics"].includes(e.kind)).map(e => [e.node.id, e.node.title])] });
    } else {
      richEditor(parent, node.content, value => change("content", value));
      for (const [key, label, hint] of [["aliases", "Alternatieve IDs (één per regel)", "Behoud oude passage-IDs als alias."], ["related", "Gerelateerde passage-IDs (één per regel)", "Verwijs alleen naar bestaande IDs of aliases."], ["codes", "Exacte foutcodes (één per regel)", "Geen persoonlijke logs of tokens invoeren."], ["messages", "Exacte foutmeldingen (één per regel)", "Vrije providerteksten zijn niet volledig voorspelbaar."]]) {
        field(identity, label, (node[key] || []).join("\n"), value => change(key, value.split(/\r?\n/).map(v => v.trim()).filter(Boolean)), { multiline: true, hint });
      }
      checks(parent, "Alle vereiste functies", CAPABILITIES, CAP_LABELS, node.requires, value => change("requires", value));
      checks(parent, "Alle vereiste promptrechten", RIGHTS, RIGHT_LABELS, node.rights, value => change("rights", value));
      parent.append(el("p", "Alle aangevinkte voorwaarden zijn nodig. Een ontbrekende vertrouwde beschikbaarheidsadapter kan een passage verborgen houden. De preview toont de serverredenen; de editor kent geen vrij te kiezen gebruikersrollen.", "hint"));
    }
    visibility(parent, `visibility.${kind}.${node.id}`, "Zichtbaarheid van dit onderdeel");
    const actions = el("div", undefined, "actions"); parent.append(actions);
    const list = entry.parent ? (kind === "topics" ? entry.parent.items : entry.parent.articles) : session.model[root];
    for (const [step, label] of [[-1, "Omhoog"], [1, "Omlaag"]]) {
      const item = button(label, () => { session.array(root); const current = allEntry(selected); const array = current.parent ? (kind === "topics" ? current.parent.items : current.parent.articles) : session.model[root]; move(array, array.indexOf(current.node), step); edited(); render(); focusEditor(); });
      item.disabled = list.indexOf(node) + step < 0 || list.indexOf(node) + step >= list.length; actions.append(item);
    }
    if (kind === "chapters" || kind === "categories") actions.append(button(kind === "chapters" ? "Onderwerp toevoegen" : "Artikel toevoegen", () => {
      session.array(root); const target = allEntry(selected).node; const id = uniqueId(session.model, kind === "chapters" ? "onderwerp" : "artikel");
      (kind === "chapters" ? target.items : target.articles).push(blankNode(id, kind === "chapters" ? "Nieuw onderwerp" : "Nieuw foutartikel")); selected = id; edited(); render(); focusEditor();
    }));
    if (entry.parent) field(parent, kind === "topics" ? "Verplaatsen naar hoofdstuk" : "Verplaatsen naar categorie", entry.parent.id, value => {
      session.array(root); const current = allEntry(selected); const key = kind === "topics" ? "items" : "articles";
      current.parent[key].splice(current.parent[key].indexOf(current.node), 1); session.model[root].find(n => n.id === value)[key].push(current.node); edited(); render(); focusEditor();
    }, { choices: session.model[root].map(n => [n.id, n.title]) });
    actions.append(button("Verwijderen", () => {
      if (!window.confirm(`‘${node.title}’ en eventuele kinderen verwijderen uit de volledige conceptlijst? Interne links naar deze onderdelen moeten eerst worden aangepast; validatie blokkeert onbekende verwijzingen.`)) return;
      session.array(root); const current = allEntry(selected);
      const removed = new Set([current.node.id, ...(current.node.items || current.node.articles || []).map(n => n.id)]);
      const array = current.parent ? (kind === "topics" ? current.parent.items : current.parent.articles) : session.model[root]; array.splice(array.indexOf(current.node), 1);
      // Visibility entries must refer only to existing IDs. Other links stay explicit for review.
      for (const group of ["chapters", "topics", "categories", "articles"]) for (const deleted of removed) {
        if (own(session.model.visibility[group], deleted)) delete session.model.visibility[group][deleted];
        if (own(session.overrides.visibility?.[group], deleted)) delete session.overrides.visibility[group][deleted];
      }
      selected = null; edited(); render();
    }, "danger"));
  }
  function rename(entry, next) {
    const old = entry.node.id;
    session.array(entry.root);
    const target = allEntry(old).node;
    if (entry.kind !== "categories") target.aliases = [...(target.aliases || []), old];
    target.id = next;
    // Renames deliberately also override any list containing references to the renamed ID.
    for (const root of ["sections", "errorCategories"]) {
      const relevant = entries(session.model).some(e => e.root === root && (e.node.parentId === old || e.node.related?.includes(old) || (e.node.content || "").includes(`manual:${old}`)));
      if (!relevant) continue;
      session.array(root);
      for (const e of entries(session.model).filter(e => e.root === root)) {
        if (e.node.parentId === old) e.node.parentId = next;
        if (e.node.related) e.node.related = e.node.related.map(id => id === old ? next : id);
        if (e.node.content) e.node.content = e.node.content.replace(/manual:([A-Za-z0-9_-]+)/g, (full, id) => id === old ? `manual:${next}` : full);
      }
    }
    const flag = get(session.model, `visibility.${entry.kind}.${old}`);
    if (flag !== undefined) { session.edit(`visibility.${entry.kind}.${next}`, flag); delete session.model.visibility[entry.kind][old]; if (session.overrides.visibility?.[entry.kind]) delete session.overrides.visibility[entry.kind][old]; }
    selected = next;
  }
  function checks(parent, title, values, labels, selected, changed) {
    const set = el("fieldset"); set.append(el("legend", title));
    for (let i = 0; i < values.length; i++) {
      const label = el("label"), input = el("input"); input.type = "checkbox"; input.value = values[i]; input.checked = (selected || []).includes(values[i]);
      input.addEventListener("change", () => changed([...set.querySelectorAll("input:checked")].map(i => i.value))); label.append(input, `${labels[i]} (${values[i]})`); set.append(label);
    }
    parent.append(set);
  }
  function safeRich(fragment, destination) {
    const tags = new Set(["p", "br", "strong", "em", "b", "i", "ul", "ol", "li", "h3", "h4", "blockquote", "code", "pre", "a", "hr"]);
    const blocked = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "form", "input", "button", "textarea", "select"]);
    function copy(source, target) {
      for (const child of source.childNodes) {
        if (child.nodeType === 3) { target.append(document.createTextNode(child.textContent)); continue; }
        if (child.nodeType !== 1 || blocked.has(child.localName)) continue;
        let into = target;
        if (tags.has(child.localName)) {
          into = el(child.localName);
          if (child.localName === "a" && safeLink(child.getAttribute("href"))) into.setAttribute("href", child.getAttribute("href"));
          target.append(into);
        }
        copy(child, into);
      }
    }
    destination.replaceChildren(); copy(fragment, destination);
  }
  function richFragment(html) {
    // Template contents are inert, including resource-loading elements. Never parse raw source
    // in an active document or copy attributes wholesale. Only safeRich's allowlist is mounted.
    const template = document.createElement("template"); template.innerHTML = html; return template.content;
  }
  function richEditor(parent, content, changed) {
    let currentContent = content;
    const emit = value => { currentContent = value; changed(value); };
    const id = `rich-${++serial}`, label = el("label", "Inhoud"); label.id = `${id}-label`; parent.append(label);
    const toolbar = el("div", undefined, "toolbar"), rich = el("div", undefined, "rich"); rich.id = id; rich.contentEditable = "true"; rich.setAttribute("role", "textbox"); rich.setAttribute("aria-multiline", "true"); rich.setAttribute("aria-labelledby", label.id);
    safeRich(richFragment(content), rich);
    rich.addEventListener("click", event => { if (event.target.closest("a")) event.preventDefault(); });
    rich.addEventListener("focus", () => document.execCommand?.("defaultParagraphSeparator", false, "p"));
    rich.addEventListener("input", () => emit(rich.innerHTML));
    // Paste plain text only: never put arbitrary clipboard HTML into an active document.
    rich.addEventListener("paste", event => { event.preventDefault(); const text = event.clipboardData?.getData("text/plain") || ""; document.execCommand("insertText", false, text); emit(rich.innerHTML); });
    rich.addEventListener("drop", event => event.preventDefault());
    for (const [text, command, value] of [["Vet", "bold"], ["Cursief", "italic"], ["Alinea", "formatBlock", "p"], ["Kop", "formatBlock", "h3"], ["Opsomming", "insertUnorderedList"], ["Nummering", "insertOrderedList"], ["Opmaak wissen", "removeFormat"]]) {
      const item = button(text, () => { rich.focus(); document.execCommand(command, false, value); emit(rich.innerHTML); }); item.addEventListener("mousedown", e => e.preventDefault()); toolbar.append(item);
    }
    const link = button("Link invoegen", () => {
      const href = window.prompt("Link: https://…, /pad, mailto:… of manual:passage-ID"); if (!href) return;
      if (!safeLink(href)) { say("Deze link is niet toegestaan.", true); return; }
      rich.focus(); document.execCommand("createLink", false, href); emit(rich.innerHTML);
    }); link.addEventListener("mousedown", e => e.preventDefault()); toolbar.append(link);
    parent.append(toolbar, rich);
    parent.append(el("p", "Selecteer tekst en gebruik de opmaakknoppen. Plakken neemt alleen tekst over. Gebruik de serverpreview om opmaak, links en invulvelden te controleren. Afbeeldingen en actieve inhoud zijn niet toegestaan.", "hint"));
    const details = el("details"); details.append(el("summary", "HTML-bron bewerken (geavanceerd)"));
    const box = field(details, "Veilige HTML-bron", content, () => {}, { multiline: true, max: 24000 });
    const sourceInput = box.querySelector("textarea");
    details.addEventListener("toggle", () => { if (details.open) sourceInput.value = currentContent; });
    sourceInput.addEventListener("input", () => { safeRich(richFragment(sourceInput.value), rich); emit(sourceInput.value); });
    rich.addEventListener("input", () => { sourceInput.value = rich.innerHTML; }); parent.append(details);
  }
  function transfer() {
    const panel = el("section", undefined, "panel"); panel.append(el("h2", "Privébestand importeren"));
    panel.append(el("p", "Import vervangt het opgeslagen concept, nooit direct de publicatie. Een volledig model is een volledige override (ook arrays en lege velden). Een overrides-bestand bevat alleen expliciete velden. Oude helpbestanden worden door de server naar een privéconcept gemigreerd. Controleer oude beleidsclaims vóór publicatie.", "notice warning"));
    const box = field(panel, "JSON-bestand", "", () => {}, { type: "file" });
    const input = box.querySelector("input"); input.accept = ".json,application/json";
    panel.append(button("Bestand als concept importeren", () => run(async () => {
      if (session.dirty) { say("Bewaar of download eerst uw lokale wijzigingen; import vervangt het concept.", true); return; }
      const file = input.files?.[0]; if (!file) { say("Kies eerst een JSON-bestand.", true); return; }
      if (file.size > 2100 * 1024) { say("Het bestand is te groot (maximaal 2100 kB; de API begrenst JSON-verzoeken).", true); return; }
      let model; try { model = JSON.parse(await file.text()); } catch { say("Dit bestand bevat geen geldige JSON.", true); return; }
      if (!model || typeof model !== "object" || Array.isArray(model)) { say("Een JSON-object is vereist.", true); return; }
      if (!window.confirm("Dit bestand vervangt het opgeslagen concept. Niets wordt automatisch gepubliceerd. Doorgaan?")) return;
      // /import regards absent schemaVersion as legacy; explicit overrides always use /draft.
      const imported = importPayload(model);
      await session.mutate(imported.path, { model: imported.model }, imported.method);
      previewDocument = null; render(); say("Import opgeslagen als concept. Controleer instellingen, bronvelden en preview vóór publicatie.");
    })));
    panel.append(button("Lokale overrides downloaden", exportLocal));
    const details = el("details"); details.append(el("summary", "Expliciete lokale overrides bekijken"), el("pre", JSON.stringify(session.overrides, null, 2))); panel.append(details);
    panel.append(el("h2", "Eerdere publicaties"), el("p", "Terugzetten publiceert de historische effectieve inhoud als een nieuwe revisie. Oude citaten blijven oud. Het concept wordt door de server bijgewerkt. Bewaar lokale wijzigingen eerst. Er zijn maximaal tien eerdere publicaties."));
    if (!session.state.history.length) panel.append(el("p", "Nog geen eerdere publicaties beschikbaar."));
    for (const history of session.state.history) {
      const row = el("div", undefined, "panel"); row.append(el("p", `${history.revision} · ${history.publishedAt || "datum onbekend"} · ${SOURCE[history.source] || history.source}`));
      const restore = button("Deze publicatie terugzetten", () => run(async () => {
        if (!clean()) return;
        if (!window.confirm("Deze historische versie nu als nieuwe live revisie publiceren? Controleer ook de historische organisatiegegevens en beschikbaarheidsinstellingen.")) return;
        await session.mutate("/rollback", { revision: history.revision }); previewDocument = null; render(); say("Historische versie gepubliceerd met een nieuwe inhoudsrevisie.");
      })); restore.disabled = session.conflict || session.uncertain || session.state.hardDisabled; row.append(restore); panel.append(row);
    }
    $("workspace").append(panel);
  }
  function render() {
    $("workspace").replaceChildren();
    if (!previewDocument) $("preview-panel").hidden = true;
    $("conflict").hidden = !session.conflict && !session.uncertain;
    const state = session.state;
    const locks = [state.hardDisabled ? "Deploymentvergrendeling: de handleiding is extern uitgeschakeld. Deze editor kan dit niet overrulen." : "", state.blocked ? "Publicatie geblokkeerd na een opslagfout. Live inhoud is niet beschikbaar. Laat een operator opslag/lock controleren; een expliciete geslaagde publicatie kan het blok opheffen." : ""].filter(Boolean);
    $("locks").hidden = !locks.length; $("locks").textContent = locks.join(" ");
    const live = el("p", `Live status: ${state.effective.enabled ? "aan" : "uit"} · Agenttool: ${state.effective.agentEnabled ? "aan" : "uit"} · Automatisch openen: ${state.effective.autoOpen} · Conceptbron: ${SOURCE[state.source] || state.source} · Schemaversie: ${state.model.schemaVersion}`, "hint");
    $("workspace").append(live);
    if (tab === "settings") settings(); else if (tab === "transfer") transfer(); else catalog();
    updateActions();
  }
  function clean() { if (session.dirty) { say("Bewaar eerst het concept. Deze actie neemt niet stilzwijgend lokale wijzigingen mee.", true); return false; } return true; }
  function download(value, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }));
    const link = el("a"); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportLocal() { if (session.state) download({ type: "govchat-manual-overrides", overrides: session.overrides }, "handleiding-lokale-overrides.json"); }
  async function reload() {
    if ((session.dirty || session.conflict || session.uncertain) && !window.confirm("Actueel concept overnemen en lokale bewerkingen vervangen? Download lokale overrides eerst als u ze wilt bewaren.")) return;
    const state = await session.request(); session.accept(state); previewDocument = null; $("preview-panel").hidden = true; $("comparison").replaceChildren(); render(); say("Actueel concept geladen. Er is niets gepubliceerd.");
  }
  function previewList() {
    const query = $("preview-filter").value.toLocaleLowerCase("nl");
    const list = $("preview-list"); list.replaceChildren();
    for (const passage of previewDocument?.passages || []) {
      if (!`${passage.title} ${passage.id} ${passage.hiddenReasons.join(" ")}`.toLocaleLowerCase("nl").includes(query)) continue;
      const details = el("details", undefined, "panel"); details.append(el("summary", `${passage.title} (${passage.id}) · ${passage.hiddenReasons.length ? "verborgen / beperkt" : "algemene context toegestaan"}`));
      details.append(el("p", passage.hiddenReasons.length ? `Verborgen redenen: ${passage.hiddenReasons.map(reasonText).join(", ")}` : "Geen verborgen redenen in deze algemene previewcontext.", "hint"));
      // Lazy frames keep the full error inventory responsive.
      let frame;
      details.addEventListener("toggle", () => { if (details.open && !frame) { frame = el("iframe"); frame.title = `Preview: ${passage.title}`; frame.setAttribute("sandbox", ""); frame.srcdoc = previewPage(passage); details.append(frame); } }); list.append(details);
    }
  }
  $("save").addEventListener("click", () => run(async () => { await session.mutate("/draft", { model: session.overrides }, "PUT"); previewDocument = null; render(); say("Concept gevalideerd en bewaard. Niets is gepubliceerd. Controleer de preview."); }));
  $("preview").addEventListener("click", () => run(async () => {
    const result = await session.request("/preview", "POST", { model: session.overrides });
    if (result.preview !== true || !Array.isArray(result.passages) || result.passages.some(p => typeof p.html !== "string" || !Array.isArray(p.hiddenReasons))) throw new Error("Geen geldig privépreviewantwoord ontvangen");
    previewDocument = result; $("preview-panel").hidden = false; $("preview-state").textContent = `${result.title} · ${result.enabled ? "ingeschakeld in concept" : "uitgeschakeld"} · ${result.passages.length} passages inclusief verborgen inhoud · ${session.dirty ? "lokale, niet-bewaarde wijzigingen" : "opgeslagen concept"}`;
    previewList(); refreshList(); $("preview-title").tabIndex = -1; $("preview-title").focus(); say("Privépreview samengesteld door de server. Dit is geen bewijs van zichtbaarheid voor iedere gebruiker.");
  }));
  $("preview-filter").addEventListener("input", previewList);
  $("publish").addEventListener("click", () => run(async () => {
    if (!clean()) return;
    if (!window.confirm(`Opgeslagen concept nu publiceren? Handleiding: ${session.model.enabled ? "aan" : "uit"}. Controleer de preview, profielcontacten en beleidsclaims. Gebruikers en agent krijgen een nieuwe inhoudsrevisie.`)) return;
    await session.mutate("/publish"); previewDocument = null; render(); say("Concept expliciet gepubliceerd met een nieuwe inhoudsrevisie.");
  }));
  $("disable").addEventListener("click", () => run(async () => {
    if (!clean()) return;
    if (!window.confirm("De live handleiding en handleidingtool nu uitschakelen? Dit publiceert niet een ander concept.")) return;
    await session.mutate("/disable"); previewDocument = null; render(); say("Live handleiding uitgeschakeld. Controleer het actuele concept voordat u opnieuw publiceert.");
  }));
  $("export").addEventListener("click", () => run(async () => { if (!clean()) return; const result = await session.request("/export"); download(result.model, "handleiding-concept.json"); say("Opgeslagen effectief concept privé geëxporteerd. Dit is een volledige override bij herimport."); }));
  $("reload").addEventListener("click", () => run(reload)); $("reload-conflict").addEventListener("click", () => run(reload)); $("local-export").addEventListener("click", exportLocal);
  $("compare").addEventListener("click", () => run(async () => {
    const latest = await session.request(); const box = $("comparison"); box.replaceChildren();
    box.append(el("p", `Actuele live revisie: ${latest.baseRevision} · Actueel concept: ${latest.draftRevision}. Lokale revisies zijn niet bijgewerkt; mutaties blijven geblokkeerd.`));
    const details = el("details"); details.open = true; details.append(el("summary", "Uw lokale overrides"), el("pre", JSON.stringify(session.overrides, null, 2))); box.append(details);
    const server = el("details"); server.open = true; server.append(el("summary", "Actuele opgeslagen overrides"), el("pre", JSON.stringify(latest.overrides, null, 2))); box.append(server);
  }));
  for (const button of document.querySelectorAll("[data-tab]")) button.addEventListener("click", () => {
    if (busy || !session.state) return;
    tab = button.dataset.tab; query = ""; categoryFilter = ""; visibilityFilter = "";
    for (const other of document.querySelectorAll("[data-tab]")) other.removeAttribute("aria-current"); button.setAttribute("aria-current", "page"); render();
  });
  window.addEventListener("beforeunload", event => { if (session.dirty) { event.preventDefault(); event.returnValue = ""; } });
  run(reload);
})();
