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
import { renderDeploy } from "./pages/deploy.js";
import { renderFeedback } from "./pages/feedback.js";

const ROUTES = {
  general: { title: "Algemeen", page: renderGeneral },
  editor: { title: "Editor", page: renderEditor, editor: true },
  // gated: only open once a template is selected in the Editor.
  "editor/documents": { title: "Documentenbibliotheek", page: renderDocuments, editor: true, gated: true },
  "editor/flow": { title: "Flow builder", page: renderFlow, editor: true, gated: true },
  "editor/deploy": { title: "Deploy", page: renderDeploy },
  feedback: { title: "Feedback", page: renderFeedback },
};
const DEFAULT_ROUTE = "editor";

export const store = {
  state: null, // server state: draft, live, versions, documents, settings
  manifest: null,
  templates: [],
  templateId: null, // nothing selected until the admin picks a template in the Editor
  flow: null, // working copy of the selected template's newest version; saved as a whole
  dirty: false,
  documents: [],
  feedback: null,
  ui: { docId: null, stepId: null, fbTemplate: "all", fbVersion: "all", fbPeriod: "30", fbFrom: "", fbTo: "", depTemplate: null, depVersion: null },
};

export const template = () => store.templates.find((t) => t.id === store.templateId) || null;

// Version labels count from the oldest version: v1, v2, …
export function versionLabel(tpl, versionId) {
  const ordered = [...(tpl?.versions || [])].sort((a, b) => a.published_at.localeCompare(b.published_at));
  const idx = ordered.findIndex((v) => v.id === versionId);
  return idx < 0 ? "onbekende versie" : `v${idx + 1}`;
}

export const newestVersion = (tpl) => [...tpl.versions].sort((a, b) => b.published_at.localeCompare(a.published_at))[0];

// The editor always works on the newest saved version, live or not.
function flowOf(tpl) {
  return tpl ? structuredClone(newestVersion(tpl)?.snapshot || store.state.live) : null;
}

async function loadDocuments() {
  const tpl = template();
  store.documents = !tpl ? [] : tpl.mock ? tpl.documents : await api.listDocuments();
}

export async function reload() {
  const { state, workflow_manifest } = await api.getState();
  store.state = state;
  store.manifest = workflow_manifest;
  store.templates = api.listTemplates(state);
  store.flow = flowOf(template());
  store.dirty = false;
  store.feedback = null;
  await loadDocuments();
}

export async function selectTemplate(id) {
  if (store.dirty && !confirm("Er zijn niet-opgeslagen wijzigingen. Toch wisselen van template?")) return;
  store.templateId = id;
  store.flow = flowOf(template());
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

async function saveVersion() {
  const tpl = template();
  const note = await askText({ title: `Opslaan als nieuwe versie van ${tpl.name}`, label: "Wat is er veranderd? (optioneel)", placeholder: "Bijv. typfout in stap 2 hersteld", confirm: "Opslaan" });
  if (note === null) return;
  try {
    const { version } = await api.saveVersion(store.flow, note);
    await reload();
    toast(`Opgeslagen als ${versionLabel(template(), version.id)}. Live zetten doe je via Deploy.`, "success");
    render();
  } catch (err) {
    toast(`Opslaan mislukt: ${err.message}`, "error");
  }
}

async function saveAsNewTemplate() {
  const name = await askText({ title: "Opslaan als nieuw template", label: "Naam van het nieuwe template", placeholder: "Bijv. SiS 4.0 – Mobiliteit", confirm: "Opslaan", required: true });
  if (!name) return;
  const tpl = api.saveAsNewTemplate(name, store.flow);
  store.templates = api.listTemplates(store.state);
  store.dirty = false;
  await selectTemplate(tpl.id);
  toast(`Template “${name}” aangemaakt`, "success");
}

// ── Routing (hash routes, so the browser's back button works) ─────
const currentRoute = () => {
  const r = location.hash.replace(/^#\/?/, "");
  if (!ROUTES[r]) return DEFAULT_ROUTE;
  if (ROUTES[r].gated && !template()) {
    history.replaceState(null, "", `#/${DEFAULT_ROUTE}`);
    return DEFAULT_ROUTE;
  }
  return r;
};

window.addEventListener("hashchange", render);

window.addEventListener("beforeunload", (e) => {
  if (store.dirty) e.preventDefault();
});

function crumbsFor(route) {
  const def = ROUTES[route];
  if (!def.editor) return route.startsWith("editor/") ? [{ label: "Editor", route: "editor" }, { label: def.title, route }] : [{ label: def.title, route }];
  const tpl = template();
  const crumbs = [{ label: "Editor", route: "editor" }, ...(tpl ? [{ label: tpl.name, route: "editor" }] : [])];
  if (route !== "editor") crumbs.push({ label: def.title, route });
  return crumbs;
}

export const dirtyFlag = () =>
  h("span", { id: "dirty-flag", class: "dirty-flag", hidden: !store.dirty }, " · niet-opgeslagen wijzigingen");

function subtitleFor(def) {
  if (!def.editor) return def.subtitle;
  const tpl = template();
  return ["Template ", h("strong", {}, tpl.name), ` · ${versionStatus(tpl)}`, dirtyFlag()];
}

// "v2 live", "v3 nieuwste · v2 live" when the newest version is not deployed yet, or "v2 nieuwste · niet live".
export function versionStatus(tpl) {
  const newest = newestVersion(tpl);
  const live = tpl.live_version_id ? `${versionLabel(tpl, tpl.live_version_id)} live` : "niet live";
  return newest.id === tpl.live_version_id ? live : `${versionLabel(tpl, newest.id)} nieuwste · ${live}`;
}

let lastRoute = null;

export function render() {
  const route = currentRoute();
  const def = ROUTES[route];
  document.title = `${def.title} - Beleidskompas Admin`;
  document.getElementById("sidebar").replaceChildren(...sidebar(route, { locked: !template() }));

  const tpl = template();
  const actions = def.editor && tpl
    ? [
        h("button", { class: "btn btn-secondary", onClick: saveAsNewTemplate }, icon("branch", 14), "Opslaan als nieuw template"),
        h("button", { class: "btn btn-primary", onClick: saveVersion, disabled: tpl.mock, title: tpl.mock ? "Voorbeeldtemplate: opslaan is niet beschikbaar" : undefined }, "Opslaan als nieuwe versie"),
      ]
    : [];
  document.getElementById("toolbar").replaceChildren(
    ...toolbar({ crumbs: crumbsFor(route), actions }),
  );

  const { controls, content, subtitle } = def.page({ store, render, markDirty, selectTemplate, saveAsNewTemplate, reload });
  const body = document.getElementById("body");
  // Only a new page starts at the top; a redraw of the same page keeps the scroll position.
  const scrollTop = route === lastRoute ? body.scrollTop : 0;
  body.replaceChildren(header({ title: def.title, subtitle: subtitle ?? subtitleFor(def), controls }), content);
  body.scrollTop = scrollTop;
  lastRoute = route;
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
