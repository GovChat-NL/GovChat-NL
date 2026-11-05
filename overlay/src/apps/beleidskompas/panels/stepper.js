// The stepper on the left: one collapsible group per step with its title
// and its substeps. The active step is open and its active substep is
// marked; substeps with a report are marked done, and a step once all its
// substeps are. Redraws itself when the active substep or a report
// changes.

import { escapeHTML } from "../../../shared/html.js";
import { requireElement } from "../../../shared/dom.js";
import { openStepInfo } from "../popups.js";

const CHEVRON_DOWN_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>';

export function setupStepper(store) {
  const { steps, substeps } = store;
  const stepGroupsEl = requireElement("gc-bk-step-groups");

  function substepHTML(substep) {
    const classes = ["gc-bk-step-link", "is-substep"];
    if (substep.id === store.activeSubstep().id) classes.push("is-active");
    if (store.substepDone(substep.id)) classes.push("is-done");
    const index = substeps.findIndex((s) => s.id === substep.id);
    return `<button type="button" class="${classes.join(" ")}" data-substep-index="${index}">${escapeHTML(substep.id)} ${escapeHTML(substep.title)}${store.substepDone(substep.id) ? " ✓" : ""}</button>`;
  }

  function renderStepper() {
    stepGroupsEl.innerHTML = steps
      .map((s, idx) => {
        const isActive = s === store.activeStep();
        const isDone = store.stepDone(s.id);
        const classes = ["gc-bk-step-group"];
        if (isActive) classes.push("is-open", "is-active");
        if (isDone && !isActive) classes.push("is-done");
        return `
          <section class="${classes.join(" ")}">
            <button type="button" class="gc-bk-step-group-head" data-step-index="${idx}" aria-expanded="${isActive ? "true" : "false"}" aria-controls="gc-bk-step-items-${idx}">
              <span>Stap ${escapeHTML(String(s.nr))}${isDone ? " ✓" : ""}</span>
              ${CHEVRON_DOWN_ICON}
            </button>
            <div class="gc-bk-step-group-items" id="gc-bk-step-items-${idx}">
              <button type="button" class="gc-bk-step-link is-title" data-step-info="${idx}" title="Toelichting bij deze stap">${escapeHTML(s.title)}</button>
              ${s.substeps.map(substepHTML).join("")}
            </div>
          </section>`;
      })
      .join("");
  }

  stepGroupsEl.addEventListener("click", (e) => {
    const infoBtn = e.target.closest("[data-step-info]");
    if (infoBtn) {
      openStepInfo(steps[Number(infoBtn.getAttribute("data-step-info"))]);
      return;
    }
    const substepBtn = e.target.closest("[data-substep-index]");
    if (substepBtn) {
      store.setActiveSubstep(Number(substepBtn.getAttribute("data-substep-index")));
      return;
    }
    const head = e.target.closest("[data-step-index]");
    if (head && steps[Number(head.getAttribute("data-step-index"))] !== store.activeStep()) {
      store.setActiveStep(Number(head.getAttribute("data-step-index")));
    }
  });

  store.subscribe("steps", renderStepper);
}
