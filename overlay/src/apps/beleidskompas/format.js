// Helpers for the Beleidskompas screen that do not touch the page: reading
// the structured advice and formatting text, dates and sources.

import { escapeHTML } from "../../shared/html.js";

export function normalizeCitations(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((c, idx) => ({
      rank: Number(c?.rank || idx + 1),
      id: String(c?.id || "").trim(),
      filename: String(c?.filename || `Document ${idx + 1}`).trim() || `Document ${idx + 1}`,
      score: Number(c?.score || 0),
      tags: Array.isArray(c?.tags) ? c.tags.map((t) => String(t || "").trim()).filter(Boolean) : [],
      preview: String(c?.preview || "").trim(),
    }))
    .filter((c) => c.id || c.filename);
}

export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
}

export function citationLabel(citation) {
  const nr = Number(citation?.rank || 0) || 1;
  const score = Number(citation?.score || 0);
  return Number.isFinite(score) && score > 0 ? `#${nr} · score ${score.toFixed(3)}` : `#${nr}`;
}

/** Beleidskompas returns plain text with "## heading" lines and **bold**.
 *  That light markup is converted, so the elaboration reads as text instead
 *  of raw markdown.
 *
 *  The model's line breaks must be kept, but the whitespace of the
 *  surrounding HTML templates must not, so pre-wrap is set only on this
 *  .gc-bk-pre and not on the containers around it. */
export function formatRichText(text) {
  const formatted = escapeHTML(String(text || ""))
    .replace(/^#{1,6}\s*(.+)$/gm, '<span class="gc-bk-rich-h">$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return `<span class="gc-bk-pre">${formatted}</span>`;
}

/** The elaboration has a fixed structure (composeAnswerText in
 *  agents/beleidskompas/steps/step1.js): an optional demo warning, then "## "
 *  sections, of which public and provincial interest start with
 *  "Oordeel: ...", and after a "---" line the disclaimer. It is taken apart
 *  here so the step card can show the verdicts as badges instead of one
 *  block of text. Returns null when the text does not have that structure
 *  (an error message, for example). */
export function parseAdvice(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  let body = raw;
  let disclaimer = "";
  const sepIdx = body.lastIndexOf("\n---\n");
  if (sepIdx > -1) {
    disclaimer = body.slice(sepIdx + 5).trim();
    body = body.slice(0, sepIdx);
  }

  const intro = [];
  const sections = [];
  let current = null;
  body.split("\n").forEach((line) => {
    const heading = /^#{2,6}\s*(.+)$/.exec(line);
    if (heading) {
      current = { heading: heading[1].trim(), lines: [] };
      sections.push(current);
      return;
    }
    (current ? current.lines : intro).push(line);
  });
  if (!sections.length) return null;

  const introText = intro.join("\n").trim();
  return {
    isDemo: introText.startsWith("⚠️"),
    disclaimer,
    sections: sections.map((s) => {
      let sectionText = s.lines.join("\n").trim();
      const verdictMatch = /^\**Oordeel:?\**\s*(.+)$/im.exec(sectionText);
      if (verdictMatch) sectionText = sectionText.replace(verdictMatch[0], "").trim();
      return {
        heading: s.heading,
        text: sectionText,
        verdict: verdictMatch ? verdictMatch[1].replaceAll("*", "").trim() : "",
      };
    }),
  };
}

export function verdictClass(verdict) {
  const v = String(verdict || "").toLowerCase();
  if (v.startsWith("ja")) return "is-yes";
  if (v.startsWith("nee")) return "is-no";
  return "is-unclear";
}

/** Refer to the specialist team when the case cannot be assessed clearly.
 *  This is a signal from the interface, based on the verdicts and the number
 *  of open assumptions, not a statement by the model, and the callout's text
 *  says so. */
export function needsSpecialistTeam(advice) {
  if (!advice) return false;
  const verdicts = advice.sections.map((s) => String(s.verdict || "").toLowerCase()).filter(Boolean);
  if (verdicts.some((v) => !v.startsWith("ja"))) return true;
  const assumptions = advice.sections.find((s) => /aannames/i.test(s.heading));
  const openItems = assumptions
    ? assumptions.text.split("\n").filter((l) => l.trim().startsWith("-") && !/geen\s*$/i.test(l.trim())).length
    : 0;
  return openItems >= 3;
}

export function formatRelativeCaseDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (_) {
    return "";
  }
}
