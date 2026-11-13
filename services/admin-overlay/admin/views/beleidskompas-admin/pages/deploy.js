// Deploy: pick a template and one of its saved versions, and make that version live.
import * as api from "../api.js";
import { h, icon, card, toast, formatDate } from "../dom.js";
import { dropdown } from "../components/dropdown.js";
import { versionLabel, newestVersion, versionOptions } from "../app.js";

export function renderDeploy({ store, render, reload }) {
  const ui = store.ui;
  const tpl = store.templates.find((t) => String(t.id) === String(ui.depTemplate)) || store.templates.find((t) => t.id === store.templateId) || store.templates[0];
  const version = tpl.versions.find((v) => String(v.id) === String(ui.depVersion)) || newestVersion(tpl);
  const live = tpl.versions.find((v) => v.id === tpl.live_version_id);

  const filters = h(
    "div",
    { class: "filter-bar" },
    dropdown({
      label: "Template",
      value: tpl.id,
      options: store.templates.map((t) => ({ value: t.id, label: t.name })),
      onChange: (v) => { ui.depTemplate = v; ui.depVersion = null; render(); },
    }),
    dropdown({ label: "Versie", value: version.id, options: versionOptions(tpl), onChange: (v) => { ui.depVersion = v; render(); } }),
  );

  const describe = (v) => (v ? `${versionLabel(tpl, v.id)} · opgeslagen ${formatDate(v.published_at)}${v.note ? ` · ${v.note}` : ""}` : "—");
  const isLive = version.id === tpl.live_version_id;

  const deployCard = card(
    "Live zetten",
    h("dl", { class: "kv" }, h("dt", {}, "Nu live"), h("dd", {}, describe(live)), h("dt", {}, "Gekozen"), h("dd", {}, describe(version))),
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
              if (!tpl.mock) await reload();
              toast(`${label} is live`, "success");
              render();
            } catch (err) {
              toast(`Live zetten mislukt: ${err.message}`, "error");
            }
          },
        },
        icon("upload", 14),
        isLive ? "Deze versie is al live" : `${versionLabel(tpl, version.id)} live zetten`,
      ),
    ),
  );

  const notice = tpl.mock
    ? h("p", { class: "notice notice-info" }, icon("info", 14), "Voorbeeldtemplate: live zetten geldt alleen in dit tabblad.")
    : null;

  return { subtitle: "Kies een template en een opgeslagen versie om live te zetten.", content: h("div", { class: "stack" }, notice, filters, deployCard) };
}
