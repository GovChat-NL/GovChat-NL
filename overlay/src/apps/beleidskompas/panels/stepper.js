// The stepper on the left: one collapsible group per step with its title and
// check questions. The active step is open; steps with an elaboration are
// marked done. Redraws itself when the active step or an elaboration changes.

import { escapeAttr, escapeHTML } from "../../../shared/html.js";
import { requireElement } from "../../../shared/dom.js";
import { openStepInfo } from "../popups.js";

const CHEVRON_DOWN_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>';

export function setupStepper(store) {
  const { state, steps } = store;
  const stepGroupsEl = requireElement("gc-bk-step-groups");

  function renderStepper() {
    stepGroupsEl.innerHTML = steps
      .map((s, idx) => {
        const isActive = idx === state.activeStep;
        const isDone = store.stepDone(s.id);
        const classes = ["gc-bk-step-group"];
        if (isActive) classes.push("is-open", "is-active");
        if (isDone && !isActive) classes.push("is-done");
        const questions = Array.isArray(s.help) ? s.help : [];
        return `
          <section class="${classes.join(" ")}">
            <button type="button" class="gc-bk-step-group-head" data-step-index="${idx}" aria-expanded="${isActive ? "true" : "false"}" aria-controls="gc-bk-step-items-${idx}">
              <span>Stap ${escapeHTML(String(s.nr))}${isDone ? " ✓" : ""}</span>
              ${CHEVRON_DOWN_ICON}
            </button>
            <div class="gc-bk-step-group-items" id="gc-bk-step-items-${idx}">
              <button type="button" class="gc-bk-step-link is-title" data-step-info="${idx}" title="Toelichting bij deze stap">${escapeHTML(s.title)}</button>
              ${questions
                .map(
                  (q) =>
                    `<button type="button" class="gc-bk-step-link" data-step-info="${idx}" title="${escapeAttr(q)}">${escapeHTML(q)}</button>`,
                )
                .join("")}
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
    const head = e.target.closest("[data-step-index]");
    if (head) store.setActiveStep(Number(head.getAttribute("data-step-index")));
  });

  store.subscribe("steps", renderStepper);
}
