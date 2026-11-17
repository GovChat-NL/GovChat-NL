// The step card on the right: the title and the elaboration of the active
// step, its sources and the buttons to move between steps. Redraws itself
// when the active step or an elaboration changes.

import { escapeHTML } from "../../../shared/html.js";
import { requireElement } from "../../../shared/dom.js";
import { formatRichText, formatTime, needsSpecialistTeam, parseAdvice, verdictClass } from "../format.js";
import { citationButtonHTML, openCitationFromClick, openStepInfo } from "../popups.js";

function adviceHTML(advice, specialistTeam) {
  const collapsedByDefault = (heading) => /redenering|aannames/i.test(heading);
  const blocks = advice.sections
    // The list of sources is in the message itself (for the normal
    // LibreChat view); here the clickable source chips already show them.
    .filter((s) => !/^bronnen$/i.test(s.heading) && s.text)
    .map((s) => {
      const open = collapsedByDefault(s.heading) ? "" : " open";
      const badge = s.verdict
        ? `<span class="gc-bk-verdict ${verdictClass(s.verdict)}">${escapeHTML(s.verdict)}</span>`
        : "";
      return `<details class="gc-bk-advice-block"${open}><summary><span class="gc-bk-advice-heading">${escapeHTML(
        s.heading,
      )}</span>${badge}</summary><div class="gc-bk-advice-text">${formatRichText(s.text)}</div></details>`;
    })
    .join("");

  const demoBadge = advice.isDemo
    ? '<div class="gc-bk-advice-demo" role="status">Demo-uitvoer: deterministische placeholder, geen AI-beoordeling.</div>'
    : "";
  const specialist =
    needsSpecialistTeam(advice) && specialistTeam
      ? `<div class="gc-bk-specialist"><strong>Niet eenduidig beoordeeld.</strong> ${escapeHTML(specialistTeam)}</div>`
      : "";
  const disclaimer = advice.disclaimer
    ? `<p class="gc-bk-advice-disclaimer">${escapeHTML(advice.disclaimer)}</p>`
    : "";

  return `${demoBadge}${specialist}<div class="gc-bk-advice">${blocks}</div>${disclaimer}`;
}

export function setupStepCard(store, { specialistTeam }) {
  const { state, steps } = store;
  const stepInfoBtn = requireElement("gc-bk-step-info");
  const formTitleEl = requireElement("gc-bk-form-title");
  const formShortEl = requireElement("gc-bk-form-short");
  const prevBtn = requireElement("gc-bk-prev");
  const nextBtn = requireElement("gc-bk-next");
  const saveStepBtn = requireElement("gc-bk-save-step");
  const nextStepBtn = requireElement("gc-bk-next-step");
  const reportStatusEl = requireElement("gc-bk-report-status");
  const reportBodyEl = requireElement("gc-bk-report-body");
  const reportMetaEl = requireElement("gc-bk-report-meta");
  const reportSourcesEl = requireElement("gc-bk-report-sources");

  function renderStepCard() {
    const step = store.activeStep();
    const data = store.stepResult(step.id);
    formTitleEl.textContent = `Stap ${step.nr} · ${step.title}`;
    formShortEl.textContent = step.short || "";
    reportStatusEl.textContent = data.report_text ? `Uitwerking beschikbaar voor stap ${step.nr}.` : "";

    const hasReport = Boolean(String(data.report_text || "").trim());
    const advice = hasReport ? parseAdvice(data.report_text) : null;
    if (advice) reportBodyEl.innerHTML = adviceHTML(advice, specialistTeam);
    else if (hasReport) reportBodyEl.innerHTML = formatRichText(data.report_text);
    else reportBodyEl.textContent = "Begin met het invoeren van een casus en start het proces. De uitwerking van deze stap verschijnt hier.";
    reportBodyEl.classList.toggle("is-placeholder", !hasReport);

    const trace = data.retrieval_trace || null;
    const tsText = data.updated_at ? ` · bijgewerkt: ${formatTime(data.updated_at)}` : "";
    reportMetaEl.textContent = trace
      ? `RAG: ${String(trace.algorithm || "-")} · top_k: ${Number(trace.top_k || 0)} · matched_docs: ${Number(
          trace.matched_docs || 0,
        )}${tsText}`
      : "";
    reportSourcesEl.innerHTML = data.citations.map(citationButtonHTML).join("");

    prevBtn.disabled = state.activeStep <= 0;
    nextBtn.disabled = state.activeStep >= steps.length - 1;
    nextStepBtn.disabled = state.activeStep >= steps.length - 1;
  }

  stepInfoBtn.addEventListener("click", () => openStepInfo(store.activeStep()));
  reportSourcesEl.addEventListener("click", openCitationFromClick);
  prevBtn.addEventListener("click", () => store.setActiveStep(state.activeStep - 1));
  nextBtn.addEventListener("click", () => store.setActiveStep(state.activeStep + 1));
  saveStepBtn.addEventListener("click", () => {
    store.addMessage("assistant", `Stap ${store.activeStep().nr} opgeslagen. Wil je verder met de volgende stap?`);
  });
  nextStepBtn.addEventListener("click", () => {
    if (state.activeStep >= steps.length - 1) return;
    store.setActiveStep(state.activeStep + 1);
    const step = store.activeStep();
    store.addMessage("assistant", `Doorgaan naar stap ${step.nr}: ${step.title}.`);
  });

  store.subscribe("steps", renderStepCard);
}
