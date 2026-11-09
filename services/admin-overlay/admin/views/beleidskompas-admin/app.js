// Beleidskompas admin UI: state, routing and the page frame (sidebar, toolbar, header).
import * as api from "./api.js";
import { h, icon, toast, askText } from "./dom.js";
import { sidebar } from "./components/sidebar.js";
import { toolbar } from "./components/toolbar.js";
import { header } from "./components/header.js";
import { renderGeneral } from "./pages/general.js";
import { renderEditor } from "./pages/editor.js";
import { renderDocuments } from "./pages/documents.js";
import { renderFlow } from "./pages/flow.js";
import { renderFeedback } from "./pages/feedback.js";

const ROUTES = {
  general: { title: "Algemeen", page: renderGeneral },
  editor: { title: "Editor", page: renderEditor, editor: true },
  "editor/documents": { title: "Documentenbibliotheek", page: renderDocuments, editor: true },
  "editor/flow": { title: "Flow builder", page: renderFlow, editor: true },
  feedback: { title: "Feedback", page: renderFeedback },
};
const DEFAULT_ROUTE = "editor";

export const store = {
  state: null, // server state: templates, settings, live
  manifest: null,
  templates: [],
  templateId: null,
  flow: null, // working copy of the selected template; published as a whole
  dirty: false,
  documents: [],
  feedback: null,
  ui: { docId: null, stepId: null, fbTemplate: "all", fbPeriod: "30", fbFrom: "", fbTo: "" },
};

export const template = () => store.templates.find((t) => t.id === store.templateId) || store.templates[0];

// Version labels count from the oldest version: v1, v2, …
export function versionLabel(tpl, versionId) {
  const ordered = [...(tpl?.versions || [])].sort((a, b) => a.published_at.localeCompare(b.published_at));
  const idx = ordered.findIndex((v) => v.id === versionId);
  return idx < 0 ? "onbekende versie" : `v${idx + 1}`;
}

function liveFlowOf(tpl) {
  return structuredClone((tpl.versions.find((v) => v.id === tpl.live_version_id) || tpl.versions[0]).snapshot);
}

async function loadDocuments() {
  store.documents = await api.listDocuments(template().id);
}

export async function reload() {
  const state = await api.getState();
  store.state = state;
  store.manifest = state.workflow_manifest;
  store.templates = api.listTemplates(state);
  if (!store.templates.some((t) => t.id === store.templateId)) store.templateId = store.templates[0]?.id;
  store.flow = liveFlowOf(template());
  store.dirty = false;
  store.feedback = null;
  await loadDocuments();
}

export async function selectTemplate(id) {
  if (store.dirty && !confirm("Er zijn niet-opgeslagen wijzigingen. Toch wisselen van template?")) return;
  store.templateId = id;
  store.flow = liveFlowOf(template());
  store.dirty = false;
  store.ui.stepId = null;
  store.ui.docId = null;
  await loadDocuments();
  render();
}

export function markDirty() {
  store.dirty = true;
  const el = document.getElementById("dirty-flag");
  if (el) el.hidden = false;
}

async function save() {
  const tpl = template();
  const note = await askText({ title: `Opslaan als nieuwe versie van ${tpl.name}`, label: "Wat is er veranderd? (optioneel)", placeholder: "Bijv. typfout in stap 2 hersteld", confirm: "Opslaan" });
  if (note === null) return;
  try {
    const { version } = await api.publishVersion(tpl.id, store.flow, note);
    await reload();
    toast(`Opgeslagen als ${versionLabel(template(), version.id)}`, "success");
    render();
  } catch (err) {
    toast(`Opslaan mislukt: ${err.message}`, "error");
  }
}

async function saveAsNewTemplate() {
  const name = await askText({ title: "Opslaan als nieuw template", label: "Naam van het nieuwe template", placeholder: "Bijv. SiS 4.0 – Mobiliteit", confirm: "Opslaan", required: true });
  if (!name) return;
  try {
    const t = await api.saveAsNewTemplate(template().id, name, store.flow);
    await reload();
    await selectTemplate(t.id);
  } catch (err) {
    return toast(`Opslaan mislukt: ${err.message}`, "error");
  }
  toast(`Template “${name}” aangemaakt`, "success");
}

// ── Routing (hash routes, so the browser's back button works) ─────
const currentRoute = () => {
  const r = location.hash.replace(/^#\/?/, "");
  return ROUTES[r] ? r : DEFAULT_ROUTE;
};

window.addEventListener("hashchange", render);

window.addEventListener("beforeunload", (e) => {
  if (store.dirty) e.preventDefault();
});

function crumbsFor(route) {
  const def = ROUTES[route];
  if (!def.editor) return [{ label: def.title, route }];
  const crumbs = [{ label: "Editor", route: "editor" }, { label: template().name, route: "editor" }];
  if (route !== "editor") crumbs.push({ label: def.title, route });
  return crumbs;
}

function subtitleFor(def) {
  if (!def.editor) return def.subtitle;
  const tpl = template();
  return [
    "Template ",
    h("strong", {}, tpl.name),
    ` · ${versionLabel(tpl, tpl.live_version_id)} live`,
    h("span", { id: "dirty-flag", class: "dirty-flag", hidden: !store.dirty }, " · niet-opgeslagen wijzigingen"),
  ];
}

export function render() {
  const route = currentRoute();
  const def = ROUTES[route];
  document.title = `${def.title} - Beleidskompas Admin`;
  document.getElementById("sidebar").replaceChildren(...sidebar(route));

  const tpl = template();
  const actions = def.editor
    ? [
        h("button", { class: "btn btn-secondary", onClick: saveAsNewTemplate }, icon("branch", 14), "Opslaan als nieuw template"),
        h("button", { class: "btn btn-primary", onClick: save, disabled: tpl.mock, title: tpl.mock ? "Voorbeeldtemplate: opslaan is niet beschikbaar" : undefined }, "Opslaan"),
      ]
    : [];
  document.getElementById("toolbar").replaceChildren(
    ...toolbar({ crumbs: crumbsFor(route), actions }),
  );

  const { controls, content, subtitle } = def.page({ store, render, markDirty, selectTemplate, saveAsNewTemplate, reload });
  const body = document.getElementById("body");
  body.replaceChildren(header({ title: def.title, subtitle: subtitle ?? subtitleFor(def), controls }), content);
  body.scrollTop = 0;
}

async function init() {
  try {
    await reload();
  } catch (err) {
    document.getElementById("body").replaceChildren(h("p", { class: "error" }, `Laden mislukt: ${err.message}`));
    return;
  }
  render();
}

init();
