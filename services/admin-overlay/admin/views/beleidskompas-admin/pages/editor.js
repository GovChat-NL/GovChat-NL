// Editor landing page: template picker, template settings, versions, export/import.
import * as api from "../api.js";
import { h, icon, card, field, bound, toast, formatDate, reveal } from "../dom.js";
import { templateSelector } from "../components/template-selector.js";
import { template, versionLabel, versionStatus, dirtyFlag } from "../app.js";

export function renderEditor({ store, render, markDirty, selectTemplate, saveAsNewTemplate, reload }) {
  const tpl = template();
  const flow = store.flow;

  // The picker replaces the subtitle: it already names the template and its versions.
  const picker = templateSelector({
    templates: store.templates,
    currentId: tpl?.id,
    meta: tpl ? versionStatus(tpl) : null,
    onSelect: selectTemplate,
    onNew: saveAsNewTemplate,
  });

  // Gate: the template settings, Documentenbibliotheek and Flow builder open once a template is picked.
  if (!tpl) {
    return {
      subtitle: picker,
      content: h("div", { class: "stack" }, h("p", { class: "empty" }, "Kies een template of maak een nieuw template aan."), h("button", { class: "btn btn-primary", onClick: saveAsNewTemplate }, "Nieuw template")),
    };
  }

  const settingsCard = card(
    "Template-instellingen",
    field("Titel", bound(flow, "title", { onInput: markDirty }), "Getoond boven de Beleidskompas-pagina."),
    field("Disclaimer", bound(flow, "disclaimer", { multiline: true, onInput: markDirty })),
    field("Specialistenteam", bound(flow, "specialist_team", { multiline: true, onInput: markDirty }), "Wie de gebruiker moet betrekken bij grote impact."),
    h(
      "details",
      { class: "advanced" },
      h("summary", {}, "Geavanceerd"),
      h(
        "div",
        { class: "form-grid" },
        field("Orchestrator workflow-id", bound(flow, "orchestrator_workflow_id", { onInput: markDirty })),
        field("Orchestrator webhook-pad", bound(flow, "orchestrator_webhook_path", { onInput: markDirty })),
        field("Webhook-token", bound(flow, "webhook_token", { type: "password", onInput: markDirty }), "Leeg = token uit de serverconfiguratie."),
      ),
    ),
  );

  const versionsCard = card(
    "Versies",
    h("p", { class: "muted" }, "Kleine wijzigingen sla je op als nieuwe versie. Grotere, bewuste wijzigingen sla je op als nieuw template. Live zetten doe je via Deploy."),
    h(
      "table",
      { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Versie"), h("th", {}, "Opgeslagen"), h("th", {}, "Door"), h("th", {}, "Omschrijving"), h("th", {}, ""))),
      h(
        "tbody",
        {},
        tpl.versions.map((v) =>
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
                      onClick: async () => {
                        const label = versionLabel(tpl, v.id);
                        if (!confirm(`${label} herstellen als nieuwe versie? Niet-opgeslagen wijzigingen gaan verloren.`)) return;
                        try {
                          // Restoring saves the old content as a new version (not live), so the history only grows.
                          const { version } = await api.saveVersion(tpl.id, v.snapshot, `Hersteld van ${label}`);
                          await reload();
                          toast(`${label} hersteld als ${versionLabel(template(), version.id)}. Live zetten doe je via Deploy.`, "success");
                          render();
                          reveal(document.getElementById("versions"));
                        } catch (err) {
                          toast(`Herstellen mislukt: ${err.message}`, "error");
                        }
                      },
                    },
                    "Herstellen als nieuwe versie",
                  ),
              v.id !== tpl.live_version_id && tpl.versions.length > 1
                ? h(
                    "button",
                    {
                      class: "btn btn-small btn-danger",
                      onClick: async () => {
                        const label = versionLabel(tpl, v.id);
                        if (!confirm(`${label} van ${tpl.name} definitief verwijderen? Niet-opgeslagen wijzigingen gaan verloren.`)) return;
                        try {
                          await api.deleteVersion(tpl.id, v.id);
                          await reload();
                          toast(`${label} verwijderd`, "success");
                          render();
                        } catch (err) {
                          toast(`Verwijderen mislukt: ${err.message}`, "error");
                        }
                      },
                    },
                    icon("trash", 14),
                    "Verwijderen",
                  )
                : null,
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
      if (!confirm("Dit bestand als nieuw template importeren?")) return;
      const { template: imported } = await api.importState(json);
      await reload();
      await selectTemplate(imported.id);
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
    h("p", { class: "muted" }, "Exporteer de nieuwste versie met de gekoppelde documenten. Importeren maakt een nieuw template; live zetten doe je via Deploy."),
    h(
      "div",
      { class: "card-actions" },
      h("a", { class: "btn btn-secondary", href: api.exportUrl(tpl.id), download: "beleidskompas-template.json" }, icon("download", 14), "Exporteren"),
      h("button", { class: "btn btn-secondary", onClick: () => importInput.click() }, icon("upload", 14), "Importeren"),
      importInput,
    ),
  );

  const isLive = Boolean(tpl.live_version_id);
  const deleteCard = card(
    "Template verwijderen",
    h("p", { class: "muted" }, isLive ? "Dit template staat live. Zet eerst een ander template live via Deploy." : "Verwijdert het template met al zijn versies, voor alle beheerders. Documenten blijven in de bibliotheek."),
    h(
      "div",
      { class: "card-actions" },
      h(
        "button",
        {
          class: "btn btn-danger",
          disabled: isLive,
          onClick: async () => {
            if (!confirm(`Template “${tpl.name}” met ${tpl.versions.length} versie(s) definitief verwijderen?`)) return;
            try {
              await api.deleteTemplate(tpl.id);
              await reload();
              toast(`Template “${tpl.name}” verwijderd`, "success");
              render();
            } catch (err) {
              toast(`Verwijderen mislukt: ${err.message}`, "error");
            }
          },
        },
        icon("trash", 14),
        "Template verwijderen",
      ),
    ),
  );

  versionsCard.id = "versions"; // scrolled into view after a restore
  return { subtitle: [picker, dirtyFlag()], content: h("div", { class: "stack" }, settingsCard, versionsCard, transferCard, deleteCard) };
}
