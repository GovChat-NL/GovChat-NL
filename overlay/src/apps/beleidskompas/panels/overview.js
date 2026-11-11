// The overview of the steps with their status, and the switch between the
// overview and the workspace. The overview redraws itself when the active
// step or a report changes.

import { escapeHTML } from "../../../shared/html.js";
import { requireElement } from "../../../shared/dom.js";

export function setupOverview(store) {
  const { steps } = store;
  const overviewEl = requireElement("gc-bk-overview");
  const overviewCardsEl = requireElement("gc-bk-overview-cards");
  const workspaceEl = requireElement("gc-bk-workspace");
  const viewToggleBtn = requireElement("gc-bk-view-toggle");

  function renderOverview() {
    overviewCardsEl.innerHTML = steps
      .map((s, idx) => {
        const done = store.stepDone(s.id);
        const isActive = s === store.activeStep();
        const status = done ? "Uitgewerkt" : isActive ? "Actief" : "Open";
        const statusClass = done ? "is-done" : isActive ? "is-active" : "";
        return `
          <button type="button" class="gc-bk-overview-card ${statusClass}" data-overview-step="${idx}">
            <span class="gc-bk-overview-nr">Stap ${escapeHTML(String(s.nr))}</span>
            <span class="gc-bk-overview-title">${escapeHTML(s.title)}</span>
            <span class="gc-bk-overview-short">${escapeHTML(s.short || "")}</span>
            <span class="gc-bk-overview-status ${statusClass}">${status}</span>
          </button>`;
      })
      .join("");
  }

  function setView(view) {
    const isOverview = view === "overview";
    overviewEl.hidden = !isOverview;
    workspaceEl.hidden = isOverview;
    viewToggleBtn.textContent = isOverview ? "Naar de uitwerking" : "Stappenoverzicht";
    viewToggleBtn.setAttribute("aria-pressed", isOverview ? "true" : "false");
  }

  viewToggleBtn.addEventListener("click", () => setView(overviewEl.hidden ? "overview" : "workspace"));
  overviewCardsEl.addEventListener("click", (e) => {
    const card = e.target.closest("[data-overview-step]");
    if (!card) return;
    store.setActiveStep(Number(card.getAttribute("data-overview-step")));
    setView("workspace");
  });

  store.subscribe("steps", renderOverview);

  return { setView };
}
