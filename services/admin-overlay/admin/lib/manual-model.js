"use strict";

// One compiler for admin preview, authenticated browser reads and agent source data.
const { Parser } = require("htmlparser2");
const crypto = require("node:crypto");
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const CAPABILITIES = Object.freeze(["chat", "history", "upload", "files", "prompts", "temporaryChat", "sharedLinks", "webSearch", "fileSearch", "models", "beleidskompas", "image", "transcript", "simplifier", "nos_news", "l1_news", "holidays", "time", "calculator", "openbesluitvorming", "topdesk"]);
const RIGHTS = Object.freeze(["prompts.use", "prompts.create", "prompts.edit", "prompts.share", "prompts.sharePublic"]);
const ORG = ["appName", "name", "helpdeskEmail", "aiEmail", "trainingEmail", "privacyEmail", "courseUrl", "policyUrl", "incidentUrl"];
const PLACEHOLDERS = { APP_NAME: "appName", ORG_NAME: "name", SUPPORT_EMAIL: "helpdeskEmail", AI_EMAIL: "aiEmail", TRAINING_EMAIL: "trainingEmail", PRIVACY_EMAIL: "privacyEmail", COURSE_URL: "courseUrl", POLICY_URL: "policyUrl", INCIDENT_URL: "incidentUrl" };
class ManualError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (message) => { throw new ManualError("INVALID_MANUAL", message); };
const clone = value => JSON.parse(JSON.stringify(value));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function object(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}: object vereist`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}: onbekend veld ${key}`);
}
function string(value, label, max = 400) {
  if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(`${label}: ongeldige tekst`);
  return value;
}
function array(value, label, max = 200) {
  if (!Array.isArray(value) || value.length > max) fail(`${label}: ongeldige lijst`);
  return value;
}
function safeHref(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f\\]/.test(value)) return null;
  if (/^\{\{(?:COURSE_URL|POLICY_URL|INCIDENT_URL)\}\}$/.test(value) || /^mailto:\{\{(?:SUPPORT_EMAIL|AI_EMAIL|TRAINING_EMAIL|PRIVACY_EMAIL)\}\}$/.test(value)) return value;
  if (/^manual:[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) return value;
  if (/^\/(?!\/)/.test(value)) {
    try {
      const u = new URL(value, "https://manual.invalid");
      if (u.origin !== "https://manual.invalid") return null;
      if (u.pathname === "/c/new" && u.searchParams.has("manual")) return ID.test(u.searchParams.get("manual")) ? `manual:${u.searchParams.get("manual")}` : null;
      return value;
    } catch { return null; }
  }
  if (/^mailto:[^?@<>]+@[^?@<>]+\.[^?@<>]+$/.test(value)) return value;
  try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
const TAGS = new Set(["p", "br", "strong", "em", "b", "i", "ul", "ol", "li", "h3", "h4", "blockquote", "code", "pre", "a", "hr"]);
const BLOCKED = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "form", "input", "button", "textarea", "select"]);
function sanitize(html, linkTransform = x => x) {
  let result = "", hidden = 0;
  const stack = [];
  const parser = new Parser({
    onopentag(tag, attrs) {
      const blocked = BLOCKED.has(tag);
      if (blocked) hidden++;
      const emitted = !hidden && TAGS.has(tag);
      stack.push({ tag, blocked, emitted });
      if (!emitted) return;
      let attributes = "";
      if (tag === "a" && attrs.href) {
        const safe = safeHref(attrs.href);
        if (!safe) fail("Onveilige of ongeldige link in inhoud");
        const href = linkTransform(safe);
        if (href) attributes = ` href="${escape(href)}" rel="noopener noreferrer"`;
      }
      result += `<${tag}${attributes}>`;
    },
    ontext(text) { if (!hidden) result += escape(text); },
    onclosetag(tag) {
      const item = stack.pop();
      if (item?.emitted && !["br", "hr"].includes(tag)) result += `</${tag}>`;
      if (item?.blocked) hidden--;
    },
  }, { decodeEntities: true });
  parser.write(html); parser.end();
  return result;
}
function plain(html) {
  let text = "";
  const parser = new Parser({ ontext: t => { text += t; }, onclosetag: tag => { if (["p", "li", "h3", "h4", "pre", "blockquote"].includes(tag)) text += "\n"; }, onopentag: tag => { if (tag === "br") text += "\n"; } });
  parser.write(html); parser.end();
  return text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}
function interpolate(value, organization, html = false) {
  const interpolated = value.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(PLACEHOLDERS, key)) fail(`Onbekende placeholder ${key}`);
    const replacement = organization[PLACEHOLDERS[key]] || "";
    return html ? escape(replacement) : replacement;
  });
  return html ? interpolated.replace(/ href="mailto:"/g, "") : interpolated;
}
function resolve(input = {}) {
  object(input, ["schemaVersion", "enabled", "agentEnabled", "autoOpen", "profile", "organization", "title", "subtitle", "reviewedAt", "visibility", "sections", "errorCategories"], "Handleiding");
  if (input.organization !== undefined) object(input.organization, ORG, "Organisatie");
  if (input.visibility !== undefined) object(input.visibility, ["chapters", "topics", "errors", "categories", "articles"], "Zichtbaarheid");
  const base = clone(require("../defaults/manual.json"));
  const profile = input.profile === undefined ? "generic" : input.profile;
  if (!["generic", "limburg"].includes(profile)) fail("Onbekend profiel");
  const org = profile === "limburg" ? require("../defaults/manual-limburg.json").organization : {};
  const result = { ...base, ...input, profile, organization: { ...base.organization, ...org, ...(input.organization || {}) }, visibility: { ...base.visibility, ...(input.visibility || {}) } };
  return validate(result);
}
function validate(model) {
  object(model, ["schemaVersion", "enabled", "agentEnabled", "autoOpen", "profile", "organization", "title", "subtitle", "reviewedAt", "visibility", "sections", "errorCategories"], "Handleiding");
  if (model.schemaVersion !== 1) fail("Niet-ondersteunde schemaversie");
  for (const key of ["enabled", "agentEnabled"]) if (typeof model[key] !== "boolean") fail(`${key}: boolean vereist`);
  if (!["never", "first-use", "new-revision", "every-session"].includes(model.autoOpen)) fail("Ongeldig automatisch-openenbeleid");
  if (!["generic", "limburg"].includes(model.profile)) fail("Onbekend profiel");
  object(model.organization, ORG, "Organisatie");
  for (const [key, value] of Object.entries(model.organization)) {
    string(value, key, 2048);
    if (value && key.endsWith("Email") && !safeHref(`mailto:${value}`)) fail(`Ongeldig e-mailadres ${key}`);
    if (value && key.endsWith("Url") && !safeHref(value)) fail(`Ongeldige URL ${key}`);
  }
  string(model.title, "Titel"); string(model.subtitle, "Ondertitel", 1000); string(model.reviewedAt, "Controledatum", 40);
  object(model.visibility, ["chapters", "topics", "errors", "categories", "articles"], "Zichtbaarheid");
  if (typeof model.visibility.errors !== "boolean") fail("errors: boolean vereist");
  const ids = new Set(), aliases = new Set(), links = [], known = { chapters: new Set(), topics: new Set(), categories: new Set(), articles: new Set() };
  let count = 0, total = 0;
  function node(n, kind) {
    object(n, ["id", "title", "content", "items", "aliases", "requires", "rights", "related", "codes", "messages"], "Passage");
    if (++count > 1200 || !ID.test(n.id) || ids.has(n.id)) fail("Dubbel of ongeldig passage-ID");
    ids.add(n.id); known[kind].add(n.id);
    string(n.title, "Passagetitel"); string(n.content, "Inhoud", 24000); total += n.content.length;
    if (total > 2000000) fail("Handleiding te groot");
    n.content = sanitize(n.content);
    n.aliases = array(n.aliases || [], "Aliases", 30).map(a => { if (!ID.test(a) || aliases.has(a)) fail("Dubbele of ongeldige alias"); aliases.add(a); return a; });
    for (const [key, list] of [["requires", CAPABILITIES], ["rights", RIGHTS]]) {
      n[key] = array(n[key] || [], key, 30);
      if (n[key].some(v => !list.includes(v))) fail(`Onbekende ${key}`);
    }
    n.related = array(n.related || [], "Verwijzingen", 30);
    links.push(...n.related);
    const parser = new Parser({ onopentag: (tag, attr) => { if (tag === "a" && attr.href?.startsWith("manual:")) links.push(attr.href.slice(7)); } }); parser.write(n.content); parser.end();
    for (const key of ["codes", "messages"]) n[key] = array(n[key] || [], key, 100).map(v => string(v, key, 1000));
    n.items = array(n.items || [], "Subsecties", 100);
    if (kind !== "chapters" && n.items.length) fail("Alleen hoofdstukken mogen subsecties bevatten");
    for (const item of n.items) node(item, "topics");
  }
  for (const section of array(model.sections, "Hoofdstukken", 80)) node(section, "chapters");
  for (const category of array(model.errorCategories, "Foutcategorieën", 50)) {
    object(category, ["id", "title", "parentId", "articles"], "Foutcategorie");
    if (category.parentId !== undefined && !known.chapters.has(category.parentId) && !known.topics.has(category.parentId)) fail("Onbekende ouder van foutcategorie");
    if (!ID.test(category.id) || ids.has(category.id)) fail("Ongeldig categorie-ID");
    ids.add(category.id); known.categories.add(category.id); string(category.title, "Categorietitel");
    for (const article of array(category.articles, "Foutartikelen", 700)) node(article, "articles");
  }
  for (const alias of aliases) if (ids.has(alias)) fail("Alias overlapt een ID");
  for (const link of links) if (!ids.has(link) && !aliases.has(link)) fail(`Onbekende verwijzing ${link}`);
  for (const key of ["chapters", "topics", "categories", "articles"]) {
    const flags = model.visibility[key]; object(flags, [...known[key]], key);
    for (const value of Object.values(flags)) if (typeof value !== "boolean") fail("Zichtbaarheid: boolean vereist");
  }
  // Check placeholders now, including organization-derived links, not only at rendering time.
  for (const section of model.sections) for (const n of [section, ...section.items]) sanitize(interpolate(n.content, model.organization, true));
  for (const category of model.errorCategories) for (const n of category.articles) sanitize(interpolate(n.content, model.organization, true));
  return model;
}
function destination(id, revision) { return `/c/new?manual=${encodeURIComponent(id)}&manualRevision=${encodeURIComponent(revision)}`; }
function compile(model, { revision = "preview", capabilities = ["chat", "history"], rights = [], hardDisabled = false, preview = false } = {}) {
  model = validate(clone(model));
  const enabled = model.enabled && !hardDisabled;
  const result = { schemaVersion: 1, revision, enabled, autoOpen: enabled ? model.autoOpen : "never", title: interpolate(model.title, model.organization), subtitle: interpolate(model.subtitle, model.organization), reviewedAt: model.reviewedAt, sections: [], errorCategories: [], passages: [] };
  const candidates = [], reasons = {};
  function add(n, kind, parentId, inherited = []) {
    const why = [...inherited];
    if (!enabled) why.push(hardDisabled ? "deployment-disabled" : "manual-disabled");
    if (model.visibility[kind][n.id] === false) why.push(`${kind}-hidden`);
    for (const c of n.requires) if (!capabilities.includes(c)) why.push(`capability:${c}`);
    for (const r of n.rights) if (!rights.includes(r)) why.push(`right:${r}`);
    reasons[n.id] = [...new Set(why)];
    candidates.push({ n, kind, parentId, why });
    for (const child of n.items) add(child, "topics", n.id, why);
  }
  for (const section of model.sections) add(section, "chapters", null);
  for (const category of model.errorCategories) {
    const inherited = category.parentId ? [...reasons[category.parentId]] : [];
    if (!model.visibility.errors) inherited.push("errors-hidden");
    if (model.visibility.categories[category.id] === false) inherited.push("category-hidden");
    for (const article of category.articles) add(article, "articles", category.id, inherited);
  }
  const allowed = new Map();
  for (const { n, why } of candidates) if (!why.length || preview) { allowed.set(n.id, n.id); for (const alias of n.aliases) allowed.set(alias, n.id); }
  for (const { n, kind, parentId, why } of candidates) {
    if (why.length && !preview) continue;
    const html = sanitize(interpolate(n.content, model.organization, true), href => href.startsWith("manual:") ? (allowed.has(href.slice(7)) ? destination(allowed.get(href.slice(7)), revision) : null) : href);
    result.passages.push({ id: n.id, title: interpolate(n.title, model.organization), html, text: plain(html), kind, parentId, aliases: n.aliases, codes: n.codes, messages: n.messages, requires: n.requires, rights: n.rights, related: n.related.filter(id => allowed.has(id)).map(id => ({ id: allowed.get(id), href: destination(allowed.get(id), revision) })), href: destination(n.id, revision), ...(preview ? { hiddenReasons: reasons[n.id] } : {}) });
  }
  for (const section of model.sections) if (allowed.has(section.id)) result.sections.push({ id: section.id, title: interpolate(section.title, model.organization), items: section.items.filter(n => allowed.has(n.id)).map(n => ({ id: n.id, title: interpolate(n.title, model.organization) })) });
  for (const category of model.errorCategories) {
    const articles = category.articles.filter(n => allowed.has(n.id)).map(n => ({ id: n.id, title: n.title }));
    if (articles.length) result.errorCategories.push({ id: category.id, title: category.title, parentId: category.parentId || null, articles });
  }
  if (!enabled && !preview) { result.title = "Handleiding"; result.subtitle = ""; result.reviewedAt = ""; }
  if (preview) result.preview = true;
  return result;
}
function migrate(legacy) {
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) fail("Legacy handleiding: object vereist");
  if (legacy.schemaVersion !== undefined) return resolve(legacy);
  object(legacy, ["title", "subtitle", "sections"], "Legacy handleiding");
  const sections = array(legacy.sections, "Legacy hoofdstukken").map(s => ({ id: s.id, title: s.title || "Onderwerp", content: s.content || "", aliases: s.aliases || [], items: (s.items || []).map(i => ({ id: i.id, title: i.title || "Onderwerp", content: i.content || "", aliases: i.aliases || [] })) }));
  // Add new baseline topics without deleting or renaming legacy passages. This also keeps
  // catalog cross-references valid when the old manual had only a few sections.
  for (const base of clone(require("../defaults/manual.json")).sections) {
    const existing = sections.find(s => s.id === base.id);
    if (!existing) sections.push(base);
    else for (const item of base.items) if (!existing.items.some(i => i.id === item.id)) existing.items.push(item);
  }
  return resolve({ title: legacy.title || "Handleiding {{APP_NAME}}", subtitle: legacy.subtitle || "", sections, enabled: false });
}
function revision() { return crypto.randomUUID(); }
module.exports = { ManualError, ID, CAPABILITIES, RIGHTS, resolve, validate, compile, migrate, sanitize, plain, escape, safeHref, destination, revision, clone };
