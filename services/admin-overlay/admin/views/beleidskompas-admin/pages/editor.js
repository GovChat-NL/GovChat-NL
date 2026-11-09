// Editor landing page: template picker, template settings, versions, export/import.
import * as api from "../api.js";
import { h, icon, card, field, bound, toast, formatDate } from "../dom.js";
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
    onNew: tpl ? saveAsNewTemplate : null,
  });

  // Gate: the template settings, Documentenbibliotheek and Flow builder open once a template is picked.
  if (!tpl) {
    return {
      subtitle: picker,
      content: h("p", { class: "empty" }, "Kies eerst een template. Daarna kun je de instellingen, de Documentenbibliotheek en de Flow builder openen."),
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
        field("Hoofdagent workflow-id", bound(flow, "orchestrator_workflow_id", { onInput: markDirty })),
        field("Hoofdagent webhook-pad", bound(flow, "orchestrator_webhook_path", { onInput: markDirty })),
        field("Webhook-token", bound(flow, "webhook_token", { type: "password", onInput: markDirty }), "Leeg = token uit de serverconfiguratie."),
      ),
    ),
  );

  const versions = [...tpl.versions].sort((a, b) => b.published_at.localeCompare(a.published_at));
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
                        const label = versionLabel(tpl, v.id);
                        if (!confirm(`${label} herstellen als nieuwe versie? Niet-opgeslagen wijzigingen gaan verloren.`)) return;
                        try {
                          // Restoring saves the old content as a new version (not live), so the history only grows.
                          const { version } = await api.saveVersion(v.snapshot, `Hersteld van ${label}`);
                          await reload();
                          toast(`${label} hersteld als ${versionLabel(template(), version.id)}. Live zetten doe je via Deploy.`, "success");
                          render();
                        } catch (err) {
                          toast(`Herstellen mislukt: ${err.message}`, "error");
                        }
                      },
                    },
                    "Herstellen als nieuwe versie",
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

  return { subtitle: [picker, dirtyFlag()], content: h("div", { class: "stack" }, settingsCard, versionsCard, transferCard) };
}
