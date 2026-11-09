// Flow builder: the template's steps, each with its texts, system prompt, search settings and documents.
import * as api from "../api.js";
import { h, icon, card, field, bound } from "../dom.js";
import { flowList } from "../components/flow-list.js";
import { dropdown } from "../components/dropdown.js";
import { toggle } from "../components/toggle.js";

const SEARCH_METHODS = [
  { value: "hybrid", label: "Hybride (aanbevolen)" },
  { value: "needle", label: "Needle: precieze passages" },
  { value: "haystack", label: "Haystack: brede context" },
];

export function renderFlow({ store, render, markDirty }) {
  const steps = store.flow.steps;
  const changed = () => { markDirty(); render(); };
  // Adds a new step at the end, collapsed.
  const addStep = () => {
    const id = `stap${Date.now().toString(36)}`;
    steps.push({
      id,
      title: `Nieuwe stap ${steps.length + 1}`,
      description: "",
      prompt: "",
      doc_tags: [],
      rag: { algorithm: "hybrid", top_k: 3, min_score: 0.08, tag_filter_mode: "any", required_tags: [] },
      substeps: [],
    });
    changed();
  };

  const notice = h(
    "p",
    { class: "notice notice-info" },
    icon("info", 14),
    "Titels, beschrijvingen en substappen verschijnen op de Beleidskompas-pagina zodra de versie live staat (Deploy). " +
      "Prompts, zoekinstellingen en de documenten per stap worden opgeslagen in het template, maar de assistent leest ze nog niet.",
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
    onAdd: addStep,
    renderEditor: (step) => stepEditor(step, { store, markDirty, render }),
  });

  return { content: h("div", { class: "stack" }, notice, list) };
}

function stepEditor(step, { store, markDirty, render }) {
  step.rag = step.rag || {};
  const docIds = api.stepDocumentIds(step, store.documents);

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
    dropdown({
      label: "Zoekmethode",
      value: step.rag.algorithm || "hybrid",
      options: SEARCH_METHODS,
      onChange: (v) => { step.rag.algorithm = v; markDirty(); },
    }),
  );

  const docList = h(
    "div",
    { class: "doc-checks" },
    store.documents.length
      ? store.documents.map((d) =>
          toggle({
            form: "check",
            checked: docIds.has(d.id),
            label: d.filename,
            onChange: (v) => {
              if (v) docIds.add(d.id);
              else docIds.delete(d.id);
              step.document_ids = [...docIds];
              markDirty();
            },
          }),
        )
      : h("p", { class: "muted" }, "Nog geen documenten in de Documentenbibliotheek."),
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
      // Step id, workflow id and webhook path are not shown: they link the step to n8n and feedback.
      // Editing them safely needs a fixed internal id first (private notes, ADMIN_UI_FUTURE_WORK.md §9).
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
    h(
      "div",
      { class: "flow-editor-foot" },
      advanced,
      // Edits are already in the working copy; this only closes the step. The server gets them with "Opslaan als nieuwe versie".
      h(
        "button",
        { class: "btn btn-primary", title: "Bewaart de stap in je wijzigingen; opslaan op de server doe je met “Opslaan als nieuwe versie”", onClick: () => { store.ui.stepId = null; render(); } },
        "Stap opslaan",
      ),
    ),
  );
}
