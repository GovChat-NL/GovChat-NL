// General: settings for all templates.
import * as api from "../api.js";
import { h, card, field, bound, toast, formatDate } from "../dom.js";
import { toggle } from "../components/toggle.js";

// Per kind of data: the last retention sweep, and the last one that deleted something
// (lib/beleidskompas/retention/retention.js).
function retentionNotice(kinds, retention) {
  const lines = kinds.filter((kind) => retention?.[kind.id]?.at).map((kind) => {
    const { at, last_deletion: last } = retention[kind.id];
    return last
      ? `${kind.label}: op ${formatDate(last.at)} ${last.deleted} verwijderd, ouder dan ${last.days} dagen. Laatste controle: ${formatDate(at)}.`
      : `${kind.label}: laatste controle ${formatDate(at)}, niets verwijderd.`;
  });
  if (!lines.length) return null;
  return h("div", { class: "notice notice-info", role: "status" }, h("span", {}, ...lines.map((line) => h("div", {}, line))));
}

export function renderGeneral({ store, render }) {
  const settings = { ...store.state.settings };

  const settingsCard = card(
    "Instellingen",
    retentionNotice(store.state.retention_kinds || [], store.state.retention),
    h(
      "div",
      { class: "form-grid" },
      ...(store.state.retention_kinds || []).map((kind) =>
        field(`Bewaartermijn ${kind.label.toLowerCase()} (dagen)`, bound(settings, kind.setting, { type: "number" }), kind.hint),
      ),
      field("Standaardmodel", bound(settings, "default_model"), "Moet een chatmodel van LiteLLM zijn (standaard govchat-default)."),
    ),
    h(
      "div",
      { class: "toggle-list" },
      toggle({ checked: settings.enforce_source_citation, label: "Bronvermelding verplicht", onChange: (v) => (settings.enforce_source_citation = v) }),
      toggle({ checked: settings.require_human_validation, label: "Menselijke validatie verplicht", onChange: (v) => (settings.require_human_validation = v) }),
    ),
    h(
      "div",
      { class: "card-actions" },
      h(
        "button",
        {
          class: "btn btn-primary",
          onClick: async () => {
            try {
              // Only what changed here, so an old page cannot undo a change made elsewhere.
              const changed = Object.fromEntries(Object.entries(settings).filter(([key, value]) => value !== store.state.settings[key]));
              const lowered = (store.state.retention_kinds || []).filter((kind) => changed[kind.setting] < store.state.settings[kind.setting]);
              const warning = lowered.map((kind) => `${kind.label} ouder dan ${changed[kind.setting]} dagen`).join(" en ");
              if (lowered.length && !confirm(`${warning} worden meteen verwijderd. Doorgaan?`)) return;
              const res = await api.saveSettings(changed);
              store.state.settings = res.settings;
              if (res.retention) store.state.retention = res.retention;
              toast("Instellingen opgeslagen", "success");
              render();
            } catch (err) {
              toast(`Opslaan mislukt: ${err.message}`, "error");
            }
          },
        },
        "Instellingen opslaan",
      ),
    ),
  );

  return { subtitle: "Geldt voor alle templates", content: h("div", { class: "stack" }, settingsCard) };
}
