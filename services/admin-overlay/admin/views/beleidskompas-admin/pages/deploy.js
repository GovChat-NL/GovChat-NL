// Deploy: pick a template and one of its saved versions, and make that version live.
import * as api from "../api.js";
import { h, icon, card, toast, formatDate } from "../dom.js";
import { dropdown } from "../components/dropdown.js";
import { templateSelector } from "../components/template-selector.js";
import { versionLabel, newestVersion, versionOptions } from "../app.js";

export function renderDeploy({ store, render, reload }) {
  const ui = store.ui;
  const tpl = store.templates.find((t) => t.id === ui.depTemplate) || store.templates.find((t) => t.id === store.templateId) || store.templates[0];
  if (!tpl) return { content: h("p", { class: "empty" }, "Maak eerst een template aan in de Editor.") };
  const version = tpl.versions.find((v) => v.id === ui.depVersion) || newestVersion(tpl);
  // One version of one template is live at a time.
  const liveTpl = store.templates.find((t) => t.live_version_id);
  const live = liveTpl?.versions.find((v) => v.id === liveTpl.live_version_id);

  const filters = h(
    "div",
    { class: "filter-bar" },
    templateSelector({
      templates: store.templates,
      currentId: tpl.id,
      onSelect: (v) => { ui.depTemplate = v; ui.depVersion = null; render(); },
    }),
    dropdown({ label: "Versie", value: version.id, options: versionOptions(tpl), onChange: (v) => { ui.depVersion = v; render(); } }),
  );

  const describe = (t, v) => (v ? `${t.name} ${versionLabel(t, v.id)} · opgeslagen ${formatDate(v.published_at)}${v.note ? ` · ${v.note}` : ""}` : "—");
  const isLive = version.id === tpl.live_version_id;

  const deployCard = card(
    "Live zetten",
    h("dl", { class: "kv" }, h("dt", {}, "Nu live"), h("dd", {}, describe(liveTpl, live)), h("dt", {}, "Gekozen"), h("dd", {}, describe(tpl, version))),
    h(
      "div",
      { class: "card-actions" },
      h(
        "button",
        {
          class: "btn btn-primary",
          disabled: isLive,
          onClick: async () => {
            const label = `${tpl.name} ${versionLabel(tpl, version.id)}`;
            const lose = store.dirty ? " Niet-opgeslagen wijzigingen in de Editor gaan verloren." : "";
            if (!confirm(`${label} live zetten? Gebruikers zien deze versie direct op de Beleidskompas-pagina.${lose}`)) return;
            try {
              await api.deployVersion(tpl, version.id);
              await reload();
              toast(`${label} staat live`, "success");
              render();
            } catch (err) {
              toast(`Live zetten mislukt: ${err.message}`, "error");
            }
          },
        },
        icon("upload", 14),
        isLive ? "Deze versie staat al live" : `${versionLabel(tpl, version.id)} live zetten`,
      ),
    ),
  );

  return { subtitle: "Kies een template en een opgeslagen versie om live te zetten.", content: h("div", { class: "stack" }, filters, deployCard) };
}
