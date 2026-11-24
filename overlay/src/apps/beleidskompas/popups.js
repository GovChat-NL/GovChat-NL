// The pop-ups of the Beleidskompas screen: the preview of a source, the
// explanation of a step and the general feedback form, plus the source chip that opens the preview
// (the chips appear under a chat message and in the step card).

import { escapeAttr, escapeHTML } from "../../shared/html.js";
import { citationLabel } from "./format.js";
import { fetchOwnEmail, sendBeleidskompasGeneralFeedback } from "./beleidskompas-api.js";

export function openCitationPreview(meta) {
  const docId = String(meta?.id || "").trim();
  const filename = String(meta?.filename || "Document").trim() || "Document";
  const scoreVal = Number(meta?.score || 0);
  const score = Number.isFinite(scoreVal) ? scoreVal.toFixed(4) : "-";
  const tags = Array.isArray(meta?.tags) ? meta.tags.filter(Boolean) : [];
  const preview = String(meta?.preview || "").trim() || "Geen preview beschikbaar voor deze bron.";
  const tagsLabel = tags.length ? tags.join(", ") : "geen tags";

  const existing = document.getElementById("gc-bk-doc-preview");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "gc-bk-doc-preview";
  modal.className = "gc-bk-doc-modal";
  modal.innerHTML = `
    <div class="gc-bk-doc-dialog" role="dialog" aria-modal="true" aria-label="Bronpreview">
      <div class="gc-bk-doc-head">
        <div>
          <div class="gc-bk-doc-title">${escapeHTML(filename)}</div>
          <div class="gc-bk-doc-meta">ID: ${escapeHTML(docId || "-")} · score: ${escapeHTML(score)} · tags: ${escapeHTML(tagsLabel)}</div>
        </div>
        <button type="button" class="gc-bk-doc-close" aria-label="Sluiten">✕</button>
      </div>
      <pre class="gc-bk-doc-body">${escapeHTML(preview)}</pre>
    </div>`;
  document.body.appendChild(modal);
  wireModal(modal);
}

/** The explanation of a step (info, check questions, deeper questions).
 *  Reuses the modal layout of the source preview. */
export function openStepInfo(step) {
  if (!step) return;
  const existing = document.getElementById("gc-bk-doc-preview");
  if (existing) existing.remove();

  const list = (items) =>
    Array.isArray(items) && items.length
      ? `<ul>${items.map((i) => `<li>${escapeHTML(i)}</li>`).join("")}</ul>`
      : "<p>-</p>";

  const modal = document.createElement("div");
  modal.id = "gc-bk-doc-preview";
  modal.className = "gc-bk-doc-modal";
  modal.innerHTML = `
    <div class="gc-bk-doc-dialog" role="dialog" aria-modal="true" aria-label="Toelichting bij de stap">
      <div class="gc-bk-doc-head">
        <div>
          <div class="gc-bk-doc-title">Stap ${escapeHTML(String(step.nr))} · ${escapeHTML(step.title)}</div>
          <div class="gc-bk-doc-meta">${escapeHTML(step.short || "")}</div>
        </div>
        <button type="button" class="gc-bk-doc-close" aria-label="Sluiten">✕</button>
      </div>
      <div class="gc-bk-doc-body is-rich">
        ${step.info === step.short ? "" : `<h5>Waar gaat deze stap over?</h5>
        <p>${escapeHTML(step.info || "-")}</p>`}
        <h5>Checkvragen</h5>
        ${list(step.help)}
        <h5>Diepere vragen</h5>
        ${list(step.deep)}
      </div>
    </div>`;
  document.body.appendChild(modal);
  wireModal(modal);
}

/** The general feedback form: free text about Beleidskompas as a whole,
 *  sent with the user's e-mail address (which the form says). The open step
 *  and the template version go along as context. */
export function openGeneralFeedback({ stepId, versionId }) {
  document.getElementById("gc-bk-doc-preview")?.remove();

  const modal = document.createElement("div");
  modal.id = "gc-bk-doc-preview";
  modal.className = "gc-bk-doc-modal";
  modal.innerHTML = `
    <div class="gc-bk-doc-dialog" role="dialog" aria-modal="true" aria-label="Feedback geven">
      <div class="gc-bk-doc-head">
        <div>
          <div class="gc-bk-doc-title">Feedback over Beleidskompas</div>
          <div class="gc-bk-doc-meta">Een fout gevonden of een idee om Beleidskompas te verbeteren? Laat het weten.</div>
        </div>
        <button type="button" class="gc-bk-doc-close" aria-label="Sluiten">✕</button>
      </div>
      <form class="gc-bk-doc-body gc-bk-general-feedback">
        <textarea class="gc-bk-feedback-comment" rows="6" maxlength="2000" required aria-label="Je feedback" placeholder="Je feedback"></textarea>
        <p data-note>Je e-mailadres wordt meegestuurd, zodat een beheerder per e-mail kan reageren.</p>
        <p data-status role="status" hidden></p>
        <div class="gc-bk-general-feedback-actions">
          <button type="button" class="gc-mini-nav-btn" data-cancel>Annuleren</button>
          <button type="submit" class="gc-bk-feedback-send">Versturen</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(modal);
  wireModal(modal);

  const form = modal.querySelector("form");
  const textarea = form.querySelector("textarea");
  const note = form.querySelector("[data-note]");
  const status = form.querySelector("[data-status]");
  const send = form.querySelector('[type="submit"]');
  textarea.focus();

  // If the address cannot be read, the form still works: the server decides.
  fetchOwnEmail()
    .then((email) => {
      if (email) {
        note.textContent = `Je e-mailadres (${email}) wordt meegestuurd, zodat een beheerder per e-mail kan reageren.`;
      } else {
        note.textContent = "Je account heeft geen e-mailadres; feedback geven kan niet.";
        send.disabled = true;
      }
    })
    .catch(() => {});

  form.querySelector("[data-cancel]").addEventListener("click", () => modal.querySelector(".gc-bk-doc-close").click());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    send.disabled = true;
    status.hidden = true;
    try {
      await sendBeleidskompasGeneralFeedback({ text, stepId, versionId });
      form.innerHTML = "<p>Bedankt, je feedback is verstuurd.</p>";
    } catch (err) {
      status.textContent = String(err?.message || err);
      status.hidden = false;
      send.disabled = false;
    }
  });
}

/** A modal closes with Escape, takes the focus when it opens and gives it
 *  back to the element that opened it. */
function wireModal(modal) {
  const previousFocus = document.activeElement;
  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    modal.remove();
    if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
  };
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKeyDown);
  modal.querySelector(".gc-bk-doc-close")?.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelector(".gc-bk-doc-close")?.focus();
}

export function citationButtonHTML(c) {
  return `<button type="button" class="gc-bk-citation-btn" data-doc-id="${escapeAttr(c.id)}" data-doc-filename="${escapeAttr(
    c.filename,
  )}" data-doc-score="${escapeAttr(String(c.score || 0))}" data-doc-tags="${escapeAttr(
    (c.tags || []).join(", "),
  )}" data-doc-preview="${escapeAttr(c.preview || "")}" title="${escapeAttr(
    c.filename,
  )}"><span class="gc-bk-citation-file">${escapeHTML(c.filename)}</span><span class="gc-bk-citation-meta">${escapeHTML(
    citationLabel(c),
  )}</span></button>`;
}

/** Click listener for a list that contains source chips. */
export function openCitationFromClick(e) {
  const btn = e.target.closest(".gc-bk-citation-btn");
  if (!btn) return;
  openCitationPreview({
    id: btn.getAttribute("data-doc-id") || "",
    filename: btn.getAttribute("data-doc-filename") || "Document",
    score: Number(btn.getAttribute("data-doc-score") || 0),
    tags: String(btn.getAttribute("data-doc-tags") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    preview: btn.getAttribute("data-doc-preview") || "",
  });
}
