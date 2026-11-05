// Feedback: user reactions on answers, filterable by template (version) and by time, grouped per step.
import * as api from "../api.js";
import { h, icon } from "../dom.js";
import { dropdown } from "../components/dropdown.js";
import { feedbackGroup } from "../components/feedback-row.js";
import { versionLabel } from "../app.js";

const PERIODS = [
  { value: "7", label: "Laatste 7 dagen" },
  { value: "30", label: "Laatste 30 dagen" },
  { value: "90", label: "Laatste 90 dagen" },
  { value: "all", label: "Altijd" },
  { value: "custom", label: "Aangepast…" },
];

export function renderFeedback({ store, render }) {
  const ui = store.ui;
  if (!store.feedback) {
    api
      .listFeedback(store.templates)
      .then((items) => { store.feedback = items; render(); })
      .catch((err) => { store.feedback = []; store.feedbackError = err.message; render(); });
    return { subtitle: "Alle templates", content: h("p", { class: "muted" }, "Feedback laden…") };
  }

  const templateOptions = [
    { value: "all", label: "Alle templates" },
    ...store.templates.map((t) => ({
      group: t.name,
      options: [
        { value: `t:${t.id}`, label: `${t.name}: alle versies` },
        ...[...t.versions]
          .sort((a, b) => b.published_at.localeCompare(a.published_at))
          .map((v) => ({ value: `v:${t.id}:${v.id}`, label: `${t.name} ${versionLabel(t, v.id)}${v.id === t.live_version_id ? " (live)" : ""}` })),
      ],
    })),
  ];

  const filters = h(
    "div",
    { class: "filter-bar" },
    dropdown({ label: "Template", value: ui.fbTemplate, options: templateOptions, onChange: (v) => { ui.fbTemplate = v; render(); } }),
    dropdown({ label: "Periode", value: ui.fbPeriod, options: PERIODS, onChange: (v) => { ui.fbPeriod = v; render(); } }),
    ui.fbPeriod === "custom"
      ? [
          dateInput("Van", ui.fbFrom, (v) => { ui.fbFrom = v; render(); }),
          dateInput("Tot en met", ui.fbTo, (v) => { ui.fbTo = v; render(); }),
        ]
      : null,
    h("button", { class: "btn btn-secondary filter-refresh", onClick: () => { store.feedback = null; render(); } }, "Vernieuwen"),
  );

  const items = store.feedback.filter((i) => matchesTemplate(i, ui.fbTemplate) && matchesPeriod(i, ui));
  const up = items.filter((i) => i.rating === "up").length;
  const stats = h(
    "div",
    { class: "stats" },
    stat("Reacties", items.length),
    stat("Positief", up, "thumbUp"),
    stat("Negatief", items.length - up, "thumbDown"),
    stat("% positief", items.length ? `${Math.round((up / items.length) * 100)}%` : "—"),
    stat("Met opmerking", items.filter((i) => i.comment).length, "chat"),
  );

  const groups = groupByStep(items, store);
  const results = groups.length
    ? groups.map((g) => feedbackGroup({ title: g.title, items: g.items, describeVersion: (i) => describe(i, store) }))
    : h("p", { class: "empty" }, "Geen feedback voor deze filters.");

  return {
    subtitle: subtitleFor(ui.fbTemplate, store),
    content: h("div", { class: "stack" }, store.feedbackError ? h("p", { class: "error" }, `Feedback laden mislukt: ${store.feedbackError}`) : null, filters, stats, results),
  };
}

function matchesTemplate(item, filter) {
  if (filter === "all") return true;
  const [kind, tplId, versionId] = filter.split(":");
  if (item.template_id !== tplId) return false;
  return kind === "t" || item.version_id === versionId;
}

function matchesPeriod(item, ui) {
  const t = new Date(item.created_at).getTime();
  if (ui.fbPeriod === "all") return true;
  if (ui.fbPeriod === "custom") {
    if (ui.fbFrom && t < new Date(`${ui.fbFrom}T00:00:00`).getTime()) return false;
    if (ui.fbTo && t > new Date(`${ui.fbTo}T23:59:59`).getTime()) return false;
    return true;
  }
  return t >= Date.now() - Number(ui.fbPeriod) * 86400000;
}

// Steps of the version the feedback belongs to (falls back to the template's live steps).
function stepsFor(item, store) {
  const tpl = store.templates.find((t) => t.id === item.template_id);
  if (!tpl) return [];
  const version = tpl.versions.find((v) => v.id === item.version_id) || tpl.versions.find((v) => v.id === tpl.live_version_id);
  return version?.snapshot?.steps || [];
}

function groupByStep(items, store) {
  const groups = new Map();
  for (const item of items) {
    const steps = stepsFor(item, store);
    const idx = steps.findIndex((s) => s.id === item.step_id);
    const tpl = store.templates.find((t) => t.id === item.template_id);
    const key = `${item.template_id}:${item.step_id}`;
    if (!groups.has(key)) {
      const stepName = idx >= 0 ? `Stap ${idx + 1} · ${steps[idx].title}` : `Onbekende stap (${item.step_id || "—"})`;
      const tplIdx = store.templates.indexOf(tpl);
      groups.set(key, { title: `${stepName} — ${tpl?.name || "onbekend template"}`, order: [tplIdx < 0 ? 999 : tplIdx, idx < 0 ? 999 : idx], items: [] });
    }
    groups.get(key).items.push(item);
  }
  return [...groups.values()]
    .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1])
    .map((g) => ({ ...g, items: g.items.sort((a, b) => b.created_at.localeCompare(a.created_at)) }));
}

function describe(item, store) {
  const tpl = store.templates.find((t) => t.id === item.template_id);
  return tpl ? `${tpl.name} ${versionLabel(tpl, item.version_id)}` : "Onbekend template";
}

function subtitleFor(filter, store) {
  if (filter === "all") return "Alle templates";
  const [, tplId, versionId] = filter.split(":");
  const tpl = store.templates.find((t) => t.id === tplId);
  return versionId ? `Template ${tpl?.name} · ${versionLabel(tpl, versionId)}` : `Template ${tpl?.name} · alle versies`;
}

function stat(label, value, iconName) {
  return h("div", { class: "stat" }, h("span", { class: "stat-label" }, iconName ? icon(iconName, 13) : null, label), h("span", { class: "stat-value" }, String(value)));
}

function dateInput(label, value, onChange) {
  const input = h("input", { class: "input input-date", type: "date", value, "aria-label": label });
  input.addEventListener("change", () => onChange(input.value));
  return h("label", { class: "dropdown" }, h("span", { class: "dropdown-label" }, label), input);
}
