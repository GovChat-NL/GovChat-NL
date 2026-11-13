// Flow builder: the four fixed steps, each with its texts, role, substeps, search settings and documents; plus the rules, prompts and messages for all steps.
import * as api from "../api.js";
import { h, icon, card, field, bound, reveal } from "../dom.js";
import { flowList } from "../components/flow-list.js";
import { dropdown } from "../components/dropdown.js";
import { toggle } from "../components/toggle.js";

const SEARCH_METHODS = [
  { value: "hybrid", label: "Hybride (aanbevolen)" },
  { value: "needle", label: "Needle: precieze passages" },
  { value: "haystack", label: "Haystack: brede context" },
];

// The step's <li> in the rendered list (index in store.flow.steps).
const stepEl = (idx) => document.querySelectorAll(".flow-list > .flow-step")[idx];

export function renderFlow({ store, render, markDirty }) {
  const steps = store.flow.steps;
  const flow = store.flow;
  const text = (obj, key, rows, hint) => field(LABELS[key], bound(obj, key, { multiline: true, rows, onInput: markDirty }), hint);

  const notice = h(
    "p",
    { class: "notice notice-info" },
    icon("info", 14),
    "Titel, beschrijving, deelstappen, instructies, regels en prompts gaan bij Deploy naar de pagina en de assistent. " +
      "De vier stappen zelf staan vast (SiS 4.0). Documenten en zoekmethode leest de assistent nog niet.",
  );

  const list = flowList({
    steps,
    expandedId: store.ui.stepId,
    onToggle: (id) => {
      store.ui.stepId = id;
      render();
      if (id) reveal(stepEl(steps.findIndex((s) => s.id === id)));
    },
    renderEditor: (step) => stepEditor(step, { store, markDirty, render }),
  });

  // Shared by every step: rules ({{rules}}) and the prompt templates of the step and orchestrator agents.
  const prompts = card(
    "Regels en prompts",
    text(flow, "rules", 6, "Eén regel per regel. Gelden voor elke stap."),
    text(flow, "report_prompt", 10, "Prompt voor het stapresultaat. Plaatshouders: {{role}} {{substeps}} {{rules}} {{substep_format}}."),
    text(flow, "conversation_prompt", 10, "Prompt voor de gewone gespreksbeurten in een stap."),
    text(flow, "orchestrator_prompt", 6, "Prompt waarmee de assistent de stap kiest. Plaatshouders: {{steps}} {{active_nr}}."),
    text(flow, "report_disclaimer", 2, "Staat onder elk stapresultaat."),
  );

  const messages = card(
    "Meldingen",
    text(flow.messages, "unknown_step", 2, "Getoond als de assistent geen stap kan kiezen."),
    text(flow.messages, "store_missing", 2, "Getoond als de casusopslag niet is geconfigureerd."),
    text(flow.messages, "store_failed", 2, "Getoond als de casus niet kan worden opgeslagen."),
    text(flow.messages, "store_warning", 2, "Toegevoegd onder het antwoord als opslaan tijdelijk mislukt."),
  );

  return { content: h("div", { class: "stack" }, notice, prompts, messages, list) };
}

const LABELS = {
  rules: "Regels voor alle stappen",
  report_prompt: "Prompt stapresultaat",
  conversation_prompt: "Prompt gesprek",
  orchestrator_prompt: "Prompt stapkeuze",
  report_disclaimer: "Disclaimer onder stapresultaat",
  unknown_step: "Stap onbekend",
  store_missing: "Casusopslag ontbreekt",
  store_failed: "Opslaan mislukt",
  store_warning: "Waarschuwing bij opslaan",
};

function stepEditor(step, { store, markDirty, render }) {
  step.rag = step.rag || {};
  const docIds = api.stepDocumentIds(step);

  const texts = h(
    "div",
    { class: "stack-sm" },
    field("Titel", bound(step, "title", { onInput: markDirty })),
    field("Beschrijving", bound(step, "description", { multiline: true, rows: 2, onInput: markDirty }), "Getoond in het overzicht en de uitleg van de stap op de Beleidskompas-pagina."),
    field("Instructies", bound(step, "prompt", { multiline: true, rows: 6, onInput: markDirty }), "De rol van het model voor deze stap."),
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
        h(
          "div",
          { class: "stack-sm" },
          field("Titel", bound(sub, "title", { onInput: markDirty })),
          field("Instructies", bound(sub, "prompt", { multiline: true, rows: 3, onInput: markDirty })),
          field("Vereiste antwoordstructuur", bound(sub, "answer_format", { multiline: true, rows: 3, onInput: markDirty })),
        ),
        h("button", { class: "icon-btn is-danger", "aria-label": "Substap verwijderen", onClick: () => { step.substeps.splice(i, 1); markDirty(); render(); } }, icon("trash", 18)),
      ),
    ),
    h(
      "button",
      {
        class: "btn btn-small btn-secondary",
        onClick: () => {
          const idx = store.flow.steps.indexOf(step) + 1;
          step.substeps = [...(step.substeps || []), { id: `${idx}.${(step.substeps?.length || 0) + 1}`, title: "", prompt: "", answer_format: "" }];
          markDirty();
          render();
          const row = document.querySelector(".flow-step.is-open .substep:last-of-type");
          reveal(row);
          row?.querySelector("input")?.focus({ preventScroll: true });
        },
      },
      icon("plus", 14),
      "Substap toevoegen",
    ),
  );

  // Not shown: the step id (fixed, stap1..stap4). rag.top_k and rag.min_score stay in the template as they are.
  return h(
    "div",
    { class: "stack" },
    texts,
    // MOCK #2: saved with the step, but retrieval does not read them yet.
    card(
      ["Documenten ", h("span", { class: "badge badge-mock", title: "Wordt opgeslagen, maar de assistent gebruikt dit nog niet" }, "Mock")],
      h("p", { class: "field-hint" }, "Zoekmethode en documentkeuze worden opgeslagen, maar de assistent gebruikt ze nog niet."),
      search,
      docList,
    ),
    card("Substappen", substeps),
    h(
      "div",
      { class: "flow-editor-foot" },
      // Edits are already in the working copy; this only closes the step. The server gets them with "Opslaan als nieuwe versie".
      h(
        "button",
        {
          class: "btn btn-primary",
          title: "Bewaart de stap in je wijzigingen; opslaan op de server doe je met “Opslaan als nieuwe versie”",
          onClick: () => {
            store.ui.stepId = null;
            render();
            reveal(stepEl(store.flow.steps.indexOf(step)));
          },
        },
        "Stap opslaan",
      ),
    ),
  );
}
