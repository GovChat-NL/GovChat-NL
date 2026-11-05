// Editor landing page: template choice, template settings, versions, export/import.
import * as api from "../api.js";
import { h, icon, card, field, bound, toast, formatDate } from "../dom.js";
import { templateSelector } from "../components/template-selector.js";
import { template, versionLabel } from "../app.js";

export function renderEditor({ store, render, markDirty, selectTemplate, saveAsNewTemplate, reload }) {
  const tpl = template();
  const flow = store.flow;

  const controls = templateSelector({
    templates: store.templates,
    currentId: tpl.id,
    onSelect: selectTemplate,
    onNew: saveAsNewTemplate,
  });

  const shortcuts = h(
    "div",
    { class: "shortcut-grid" },
    shortcut("editor/documents", "folder", "Documentenbibliotheek", `${store.documents.length} documenten`),
    shortcut("editor/flow", "flow", "Flow builder", `${flow.steps.length} stappen`),
  );

  const settingsCard = card(
    "Template-instellingen",
    field("Titel", bound(flow, "title", { onInput: markDirty }), "Getoond boven de Beleidskompas-pagina."),
    field("Disclaimer", bound(flow, "disclaimer", { multiline: true, onInput: markDirty })),
    field("Specialistenteam", bound(flow, "specialist_team", { multiline: true, onInput: markDirty }), "Wie de gebruiker moet betrekken bij grote impact."),
    field("Bronnen", chipEditor(flow, "sources", markDirty), "Getoond als bronnenlijst op de Beleidskompas-pagina."),
    h(
      "details",
      { class: "advanced" },
      h("summary", {}, "Geavanceerd"),
      h(
        "div",
        { class: "form-grid" },
        field("Hoofdagent workflow-id", bound(flow, "orchestrator_workflow_id", { onInput: markDirty })),
        field("Hoofdagent webhook-pad", bound(flow, "orchestrator_webhook_path", { onInput: markDirty })),
        field("Webhook-token", bound(flow, "webhook_token", { type: "password", onInput: markDirty }), "Leeg = token uit de serverconfiguratie."),
      ),
    ),
  );

  const versions = [...tpl.versions].sort((a, b) => b.published_at.localeCompare(a.published_at));
  const versionsCard = card(
    "Versies",
    h("p", { class: "muted" }, "Kleine wijzigingen publiceer je als nieuwe versie. Grotere, bewuste wijzigingen sla je op als nieuw template."),
    h(
      "table",
      { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Versie"), h("th", {}, "Gepubliceerd"), h("th", {}, "Door"), h("th", {}, "Omschrijving"), h("th", {}, ""))),
      h(
        "tbody",
        {},
        versions.map((v) =>
          h(
            "tr",
            {},
            h("td", {}, h("strong", {}, versionLabel(tpl, v.id))),
            h("td", {}, formatDate(v.published_at)),
            h("td", {}, v.published_by || "—"),
            h("td", {}, v.note || h("span", { class: "muted" }, "—")),
            h(
              "td",
              { class: "cell-right" },
              v.id === tpl.live_version_id
                ? h("span", { class: "badge badge-live" }, "Live")
                : h(
                    "button",
                    {
                      class: "btn btn-small btn-secondary",
                      disabled: tpl.mock,
                      onClick: async () => {
                        if (!confirm(`${versionLabel(tpl, v.id)} weer live zetten? Niet-gepubliceerde wijzigingen gaan verloren.`)) return;
                        try {
                          await api.rollback(v.id);
                          await reload();
                          toast(`${versionLabel(template(), v.id)} staat weer live`, "success");
                          render();
                        } catch (err) {
                          toast(`Terugzetten mislukt: ${err.message}`, "error");
                        }
                      },
                    },
                    "Terugzetten",
                  ),
            ),
          ),
        ),
      ),
    ),
  );

  const importInput = h("input", { type: "file", accept: "application/json,.json", hidden: true });
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      if (!confirm("De huidige configuratie wordt overschreven met dit bestand. Doorgaan?")) return;
      await api.importState(json);
      await reload();
      toast("Configuratie geïmporteerd", "success");
      render();
    } catch (err) {
      toast(`Importeren mislukt: ${err.message}`, "error");
    } finally {
      importInput.value = "";
    }
  });
  const transferCard = card(
    "Export en import",
    h("p", { class: "muted" }, "De volledige configuratie (template, versies, documenten en instellingen) als JSON-bestand."),
    h(
      "div",
      { class: "card-actions" },
      tpl.mock
        ? h("button", { class: "btn btn-secondary", disabled: true }, icon("download", 14), "Exporteren")
        : h("a", { class: "btn btn-secondary", href: api.exportUrl(), download: "beleidskompas-config.json" }, icon("download", 14), "Exporteren"),
      h("button", { class: "btn btn-secondary", disabled: tpl.mock, onClick: () => importInput.click() }, icon("upload", 14), "Importeren"),
      importInput,
    ),
  );

  return { controls, content: h("div", { class: "stack" }, shortcuts, settingsCard, versionsCard, transferCard) };
}

function shortcut(route, iconName, title, meta) {
  return h("a", { class: "shortcut", href: `#/${route}` }, h("span", { class: "shortcut-icon" }, icon(iconName, 20)), h("span", {}, h("strong", {}, title), h("span", { class: "muted" }, meta)), icon("chevronRight", 14));
}

// Editable list of short strings shown as chips.
export function chipEditor(obj, key, onChange) {
  const wrap = h("div", { class: "chips" });
  const input = h("input", { class: "chip-input", type: "text", placeholder: "Toevoegen en Enter…", "aria-label": "Item toevoegen" });
  const draw = () => {
    wrap.replaceChildren(
      ...(obj[key] || []).map((value, i) =>
        h(
          "span",
          { class: "chip" },
          value,
          h("button", { class: "chip-x", "aria-label": `${value} verwijderen`, onClick: (e) => { e.preventDefault(); obj[key].splice(i, 1); onChange(); draw(); } }, "×"),
        ),
      ),
      input,
    );
  };
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    obj[key] = [...(obj[key] || []), value];
    input.value = "";
    onChange();
    draw();
    input.focus();
  });
  draw();
  return wrap;
}
