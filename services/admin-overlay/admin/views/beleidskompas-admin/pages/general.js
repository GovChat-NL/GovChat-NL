// General: settings for all templates.
import * as api from "../api.js";
import { h, card, field, bound, toast } from "../dom.js";
import { toggle } from "../components/toggle.js";

export function renderGeneral({ store }) {
  const settings = { ...store.state.settings };

  const settingsCard = card(
    "Instellingen",
    h(
      "div",
      { class: "form-grid" },
      field("Bewaartermijn casussen (dagen)", bound(settings, "retention_days", { type: "number" })),
      field("Standaardmodel", bound(settings, "default_model")),
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
              const res = await api.saveSettings(settings);
              store.state.settings = res.settings;
              toast("Instellingen opgeslagen", "success");
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
