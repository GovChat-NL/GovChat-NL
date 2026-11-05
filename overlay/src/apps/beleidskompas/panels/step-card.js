// The step card on the right. It shows the title and the report of the
// active substep, its sources, the arrows to browse the substeps and the
// buttons that ask for a report (for the first time, or again after the
// conversation about it). Browsing never asks for anything, only the
// buttons do. Redraws itself when the active substep, a report, the chat or
// the request under way changes.

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

export function setupStepCard(store, { specialistTeam, requestReport }) {
  const { state, substeps } = store;
  const stepInfoBtn = requireElement("gc-bk-step-info");
  const formTitleEl = requireElement("gc-bk-form-title");
  const formShortEl = requireElement("gc-bk-form-short");
  const prevBtn = requireElement("gc-bk-prev");
  const nextBtn = requireElement("gc-bk-next");
  const reportBtn = requireElement("gc-bk-request-report");
  const redoBtn = requireElement("gc-bk-redo");
  const staleEl = requireElement("gc-bk-report-stale");
  const reportStatusEl = requireElement("gc-bk-report-status");
  const reportBodyEl = requireElement("gc-bk-report-body");
  const reportMetaEl = requireElement("gc-bk-report-meta");
  const reportSourcesEl = requireElement("gc-bk-report-sources");

  function renderStepCard() {
    const substep = store.activeSubstep();
    const step = substep.step;
    const data = store.substepResult(substep.id);
    formTitleEl.textContent = `Stap ${step.nr} · ${step.title} · ${substep.id} ${substep.title}`;
    formShortEl.textContent = step.short || "";
    reportStatusEl.textContent = data.report_text ? `Uitwerking beschikbaar voor deelstap ${substep.id}.` : "";
    staleEl.hidden = !store.talkedSinceReport(substep.id);

    const hasReport = Boolean(String(data.report_text || "").trim());
    const advice = hasReport ? parseAdvice(data.report_text) : null;
    if (advice) reportBodyEl.innerHTML = adviceHTML(advice, specialistTeam);
    else if (hasReport) reportBodyEl.innerHTML = formatRichText(data.report_text);
    else if (state.asking === substep.id) reportBodyEl.textContent = "Wordt uitgewerkt…";
    else if (!store.caseStarted()) reportBodyEl.textContent = "Beschrijf je casus in de chat om te beginnen. De uitwerking van elke deelstap verschijnt hier.";
    else reportBodyEl.textContent = "Deze deelstap is nog niet uitgewerkt.";
    reportBodyEl.classList.toggle("is-placeholder", !hasReport);

    const trace = data.retrieval_trace || null;
    const tsText = data.updated_at ? ` · bijgewerkt: ${formatTime(data.updated_at)}` : "";
    reportMetaEl.textContent = trace
      ? `RAG: ${String(trace.algorithm || "-")} · top_k: ${Number(trace.top_k || 0)} · matched_docs: ${Number(
          trace.matched_docs || 0,
        )}${tsText}`
      : "";
    reportSourcesEl.innerHTML = data.citations.map(citationButtonHTML).join("");

    prevBtn.disabled = state.activeSubstep <= 0;
    nextBtn.disabled = state.activeSubstep >= substeps.length - 1;
    renderReportButton(substep);
  }

  /** The button says what it does. It asks for the report of this substep
   *  when there is none yet, and otherwise moves on to the next substep and
   *  asks for that report. The button waits while a request is under way,
   *  and until there is a case, because the first report comes from the
   *  case text the user types. */
  function renderReportButton(substep) {
    const isLast = state.activeSubstep >= substeps.length - 1;
    const done = store.substepDone(substep.id);
    reportBtn.textContent = done ? "Volgende deelstap uitwerken" : "Deze deelstap uitwerken";
    reportBtn.disabled = Boolean(state.asking) || !store.caseStarted() || (done && isLast);
    redoBtn.hidden = !done;
    redoBtn.disabled = Boolean(state.asking);
  }

  function requestReportForThisOrNext() {
    if (store.substepDone(store.activeSubstep().id)) {
      if (state.activeSubstep >= substeps.length - 1) return;
      store.setActiveSubstep(state.activeSubstep + 1);
    }
    const substep = store.activeSubstep();
    if (!store.substepDone(substep.id)) requestReport(substep);
  }

  stepInfoBtn.addEventListener("click", () => openStepInfo(store.activeStep()));
  reportSourcesEl.addEventListener("click", openCitationFromClick);
  prevBtn.addEventListener("click", () => store.setActiveSubstep(state.activeSubstep - 1));
  nextBtn.addEventListener("click", () => store.setActiveSubstep(state.activeSubstep + 1));
  reportBtn.addEventListener("click", requestReportForThisOrNext);
  redoBtn.addEventListener("click", () => requestReport(store.activeSubstep()));

  store.subscribe("steps", renderStepCard);
  // The conversation decides whether the report shown is behind on it.
  store.subscribe("chat", renderStepCard);
}
