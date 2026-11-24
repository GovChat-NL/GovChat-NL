// General feedback: free-text messages about Beleidskompas as a whole, newest first, with the sender's e-mail address.
import * as api from "../api.js";
import { h, formatDate } from "../dom.js";
import { versionLabel } from "../app.js";

export function renderGeneralFeedback({ store, render }) {
  if (!store.generalFeedback) {
    api
      .listGeneralFeedback()
      .then((items) => { store.generalFeedback = items; store.generalFeedbackError = null; render(); })
      .catch((err) => { store.generalFeedback = []; store.generalFeedbackError = err.message; render(); });
    return { subtitle: "Berichten van gebruikers", content: h("p", { class: "muted" }, "Feedback laden…") };
  }

  const items = store.generalFeedback;
  const list = items.length
    ? h("div", { class: "fb-group" }, items.map((item) => row(item, store)))
    : h("p", { class: "empty" }, "Nog geen algemene feedback.");

  return {
    subtitle: `${items.length} ${items.length === 1 ? "bericht" : "berichten"}`,
    content: h(
      "div",
      { class: "stack" },
      store.generalFeedbackError ? h("p", { class: "error" }, `Feedback laden mislukt: ${store.generalFeedbackError}`) : null,
      h("div", { class: "filter-bar" }, h("button", { class: "btn btn-secondary filter-refresh", onClick: () => { store.generalFeedback = null; render(); } }, "Vernieuwen")),
      list,
    ),
  };
}

// The template version the user had open ("<template> v<n>") and the step in it
// ("Stap N · title", as on the answer feedback page); the raw step id when the version is unknown.
function contextOf(item, store) {
  const versionId = String(item.version_id);
  const tpl = store.templates.find((t) => t.versions.some((v) => v.id === versionId));
  const steps = tpl?.versions.find((v) => v.id === versionId)?.snapshot?.steps || [];
  const idx = steps.findIndex((st) => st.id === item.step_id);
  return {
    version: tpl ? `${tpl.name} ${versionLabel(tpl, versionId)}` : null,
    step: idx >= 0 ? `Stap ${idx + 1} · ${steps[idx].title}` : item.step_id || null,
  };
}

function row(item, store) {
  const { version, step } = contextOf(item, store);
  return h(
    "article",
    { class: "fb-row is-general" },
    h(
      "div",
      { class: "fb-main" },
      h("div", { class: "fb-meta" }, h("time", { datetime: item.created_at }, formatDate(item.created_at)), h("span", {}, item.email), step ? h("span", { class: "fb-version" }, step) : null, version ? h("span", { class: "fb-version" }, version) : null),
      h("p", { class: "fb-comment" }, item.text),
    ),
  );
}
