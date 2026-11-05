// Flow builder: the template's steps, each with its texts, system prompt, search settings and documents.
import * as api from "../api.js";
import { h, icon, card, field, bound } from "../dom.js";
import { flowList } from "../components/flow-list.js";
import { dropdown } from "../components/dropdown.js";
import { toggle } from "../components/toggle.js";
import { template } from "../app.js";

const SEARCH_METHODS = [
  { value: "hybrid", label: "Hybride (aanbevolen)" },
  { value: "needle", label: "Needle: precieze passages" },
  { value: "haystack", label: "Haystack: brede context" },
];

export function renderFlow({ store, render, markDirty }) {
  const tpl = template();
  const steps = store.flow.steps;
  const changed = () => { markDirty(); render(); };

  const notice = h(
    "p",
    { class: "notice notice-info" },
    icon("info", 14),
    "Titels, beschrijvingen en substappen verschijnen na publiceren op de Beleidskompas-pagina. " +
      "Prompts, zoekinstellingen en stapdocumenten worden opgeslagen in het template, maar de assistent leest ze nog niet.",
  );

  const list = flowList({
    steps,
    expandedId: store.ui.stepId,
    onToggle: (id) => { store.ui.stepId = id; render(); },
    onMove: (idx, delta) => {
      const [step] = steps.splice(idx, 1);
      steps.splice(idx + delta, 0, step);
      changed();
    },
    onRemove: (idx) => {
      if (!confirm(`Stap “${steps[idx].title}” verwijderen?`)) return;
      steps.splice(idx, 1);
      changed();
    },
    onAdd: () => {
      const n = steps.length + 1;
      const id = `stap${Date.now().toString(36)}`;
      steps.push({
        id,
        title: `Nieuwe stap ${n}`,
        description: "",
        prompt: "",
        doc_tags: [],
        rag: { enabled: true, algorithm: "hybrid", top_k: 3, min_score: 0.08, tag_filter_mode: "any", required_tags: [] },
        substeps: [],
      });
      store.ui.stepId = id;
      changed();
    },
    renderEditor: (step) => stepEditor(step, { tpl, store, markDirty, render }),
  });

  return { content: h("div", { class: "stack" }, notice, list) };
}

function stepEditor(step, { tpl, store, markDirty, render }) {
  step.rag = step.rag || {};
  const docIds = api.getStepDocumentIds(tpl.id, step, store.documents);

  const texts = h(
    "div",
    { class: "stack-sm" },
    field("Titel", bound(step, "title", { onInput: markDirty })),
    field("Beschrijving", bound(step, "description", { multiline: true, rows: 2, onInput: markDirty })),
    field("Systeemprompt", bound(step, "prompt", { multiline: true, rows: 6, onInput: markDirty }), "Instructie voor de assistent in deze stap."),
  );

  const search = h(
    "div",
    { class: "inline-controls" },
    toggle({ checked: step.rag.enabled !== false, label: "Gebruik documenten", onChange: (v) => { step.rag.enabled = v; markDirty(); render(); } }),
    dropdown({
      label: "Zoekmethode",
      value: step.rag.algorithm || "hybrid",
      options: SEARCH_METHODS,
      disabled: step.rag.enabled === false,
      onChange: (v) => { step.rag.algorithm = v; markDirty(); },
    }),
  );

  const docs = store.documents.filter((d) => api.isDocumentActive(tpl.id, d.id));
  const docList = h(
    "div",
    { class: `doc-checks${step.rag.enabled === false ? " is-disabled" : ""}` },
    docs.length
      ? docs.map((d) =>
          toggle({
            form: "check",
            checked: docIds.has(d.id),
            disabled: step.rag.enabled === false,
            label: d.filename,
            hint: (d.tags || []).join(", "),
            onChange: (v) => { api.setStepDocument(tpl.id, step.id, d.id, v); markDirty(); },
          }),
        )
      : h("p", { class: "muted" }, "Geen actieve documenten in de bibliotheek van dit template."),
  );

  const substeps = h(
    "div",
    { class: "substeps" },
    (step.substeps || []).map((sub, i) =>
      h(
        "div",
        { class: "substep" },
        h("span", { class: "substep-id" }, sub.id),
        bound(sub, "title", { onInput: markDirty }),
        bound(sub, "description", { onInput: markDirty }),
        h("button", { class: "icon-btn is-danger", "aria-label": "Substap verwijderen", onClick: () => { step.substeps.splice(i, 1); markDirty(); render(); } }, icon("trash", 14)),
      ),
    ),
    h(
      "button",
      {
        class: "btn btn-small btn-secondary",
        onClick: () => {
          const idx = store.flow.steps.indexOf(step) + 1;
          step.substeps = [...(step.substeps || []), { id: `${idx}.${(step.substeps?.length || 0) + 1}`, title: "", description: "" }];
          markDirty();
          render();
        },
      },
      icon("plus", 14),
      "Substap toevoegen",
    ),
  );

  const advanced = h(
    "details",
    { class: "advanced" },
    h("summary", {}, "Geavanceerd"),
    h(
      "div",
      { class: "form-grid" },
      field("Stap-id", bound(step, "id", { onInput: () => { store.ui.stepId = step.id; markDirty(); } })),
      field("Workflow-id", bound(step, "workflow_id", { onInput: markDirty })),
      field("Webhook-pad", bound(step, "webhook_path", { onInput: markDirty })),
      field("Aantal passages (top_k)", bound(step.rag, "top_k", { type: "number", onInput: markDirty })),
      field("Minimale score (0–1)", bound(step.rag, "min_score", { type: "number", onInput: markDirty })),
    ),
  );

  return h(
    "div",
    { class: "stack" },
    texts,
    card("Documenten", search, docList),
    card("Substappen", substeps),
    advanced,
  );
}
