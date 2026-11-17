// General: settings for all templates and the status of the generated workflows.
import * as api from "../api.js";
import { h, icon, card, field, bound, toast } from "../dom.js";
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

  const statusBody = h("div", { class: "status-body" }, h("p", { class: "muted" }, "Status laden…"));
  const loadStatus = async () => {
    try {
      const s = await api.getWorkflowStatus();
      statusBody.replaceChildren(
        h(
          "dl",
          { class: "kv" },
          h("dt", {}, "n8n"), h("dd", {}, s.n8n_base_url || "—"),
          h("dt", {}, "Webhook-token"), h("dd", {}, s.token_configured ? "Ingesteld" : "Niet ingesteld"),
          h("dt", {}, "Stappen in live template"), h("dd", {}, String(s.step_count_expected)),
          h("dt", {}, "Stappen met workflowbestand"), h("dd", {}, String(s.step_count_mapped)),
        ),
        s.step_mismatch
          ? h("p", { class: "notice notice-warn" }, icon("info", 14), "Het aantal stappen en workflowbestanden komt niet overeen. Synchroniseer de workflows.")
          : h("p", { class: "notice notice-ok" }, icon("check", 14), "Workflowbestanden zijn in sync met het live template."),
      );
    } catch (err) {
      statusBody.replaceChildren(h("p", { class: "error" }, `Status laden mislukt: ${err.message}`));
    }
  };
  loadStatus();

  const statusCard = card(
    "Workflows",
    statusBody,
    h(
      "div",
      { class: "card-actions" },
      h(
        "button",
        {
          class: "btn btn-secondary",
          onClick: async () => {
            try {
              await api.syncWorkflows();
              toast("Workflows gesynchroniseerd", "success");
              loadStatus();
            } catch (err) {
              toast(`Synchroniseren mislukt: ${err.message}`, "error");
            }
          },
        },
        "Workflows synchroniseren",
      ),
    ),
  );

  return { subtitle: "Geldt voor alle templates", content: h("div", { class: "stack" }, settingsCard, statusCard) };
}
