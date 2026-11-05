// Earlier cases: resuming one, the list in the side bar and the title above
// the chat. The list and the title redraw themselves when the open
// conversation changes.

import { escapeAttr, escapeHTML } from "../../../shared/html.js";
import { requireElement } from "../../../shared/dom.js";
import { fetchBeleidskompasHistory, listRecentBeleidskompasConversations } from "../beleidskompas-api.js";
import { formatRelativeCaseDate, parseAdvice } from "../format.js";

/** Puts a reopened case back together from its history.
 *
 *  The history alternates: a user message, then the answer to it. The
 *  user message says which substep it was about and whether the user
 *  typed a message (conversation) or asked for the report of the substep.
 *  The answer after it gets the same substep and the same kind.
 *
 *  Only the answer to a request for a report is a report, and goes to the
 *  card of its substep. When a report was asked for more than once, the
 *  last answer is kept. */
export function readHistory(history) {
  const messages = [];
  const results = {};
  let askedFor = "";
  let conversing = false;
  let last = "";
  let caseText = "";
  for (const m of history) {
    if (m.role === "user") {
      askedFor = String(m.substepId || "");
      conversing = Boolean(m.conversation);
      if (m.caseText) caseText = m.caseText;
      messages.push({ ...m, substepId: askedFor, conversation: conversing });
      continue;
    }
    messages.push({ ...m, substepId: askedFor, conversation: conversing });
    if (!askedFor || conversing || !parseAdvice(m.text)) continue;
    results[askedFor] = { report_text: m.text, citations: m.citations, retrieval_trace: m.retrieval_trace, updated_at: m.ts };
    last = askedFor;
  }
  return { messages, results, last, caseText };
}

export function setupCases(store) {
  const { state } = store;
  const recentCasesListEl = requireElement("gc-bk-recent-cases-list");
  const convoTitleEl = requireElement("gc-bk-convo-title");

  /** Loads a case's full history into the current view - shared by the
   *  "resume on reopen" path and clicking an entry in "Eerdere casussen".
   *  The reports go back to their substeps, and the last substep with a
   *  report becomes the active one, so the case continues where it was left. */
  async function resumeConversation(conversationId) {
    const history = await fetchBeleidskompasHistory(conversationId);
    const { messages, results, last, caseText } = readHistory(history);
    store.setConversationId(conversationId);
    store.replaceMessages(messages);
    const lastUser = history.filter((m) => m.role === "user").slice(-1)[0];
    const lastAssistant = history.filter((m) => m.role === "assistant").slice(-1)[0];
    store.setLastMessageId((lastAssistant || lastUser || {}).messageId || null);
    store.setCaseText(caseText);
    if (last) store.setActiveSubstep(store.substeps.findIndex((s) => s.id === last));
    store.replaceResults(results);
  }

  /** The heading of the chat card: the case title LibreChat generates, once
   *  there is one, otherwise "Nieuw gesprek". */
  function setConversationTitle(title) {
    const clean = String(title || "").trim();
    convoTitleEl.textContent = clean || "Nieuw gesprek";
    convoTitleEl.title = clean;
  }

  async function renderRecentCases() {
    try {
      const cases = await listRecentBeleidskompasConversations(8);
      if (!cases.length) {
        recentCasesListEl.innerHTML = '<div class="gc-bk-recent-cases-empty">Nog geen eerdere casussen.</div>';
        return;
      }
      const current = cases.find((c) => c.conversationId === state.conversationId);
      if (current) setConversationTitle(current.title);
      recentCasesListEl.innerHTML = cases
        .map((c) => {
          const isActive = c.conversationId === state.conversationId;
          return `<button type="button" class="gc-bk-recent-case-link ${isActive ? "is-active" : ""}" data-conversation-id="${escapeAttr(c.conversationId)}" title="${escapeAttr(c.title)}">${escapeHTML(formatRelativeCaseDate(c.updatedAt))} · ${escapeHTML(c.title.slice(0, 60))}</button>`;
        })
        .join("");
    } catch (err) {
      recentCasesListEl.innerHTML = '<div class="gc-bk-recent-cases-empty">Kon casuslijst niet laden.</div>';
    }
  }

  // The list is redrawn as a whole, so one click listener on the list itself.
  recentCasesListEl.addEventListener("click", async (e) => {
    const link = e.target.closest("[data-conversation-id]");
    const conversationId = link?.getAttribute("data-conversation-id");
    if (!conversationId || conversationId === state.conversationId) return;
    try {
      await resumeConversation(conversationId);
    } catch (err) {
      store.addMessage("assistant", `Kon deze casus niet laden (${String(err?.message || err)}).`);
    }
  });

  store.subscribe("conversation", () => {
    if (!state.conversationId) setConversationTitle("");
    renderRecentCases();
  });

  return { resumeConversation };
}
