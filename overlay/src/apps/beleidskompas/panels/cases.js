// Earlier cases: resuming one, the list in the side bar and the title above
// the chat. The list and the title redraw themselves when the open
// conversation changes.

import { escapeAttr, escapeHTML } from "../../../shared/html.js";
import { requireElement } from "../../../shared/dom.js";
import { fetchBeleidskompasHistory, listRecentBeleidskompasConversations } from "../beleidskompas-api.js";
import { formatRelativeCaseDate } from "../format.js";

export function setupCases(store) {
  const { state } = store;
  const recentCasesListEl = requireElement("gc-bk-recent-cases-list");
  const convoTitleEl = requireElement("gc-bk-convo-title");

  /** Loads a case's full history into the current view - shared by the
   *  "resume on reopen" path and clicking an entry in "Eerdere casussen". */
  async function resumeConversation(conversationId) {
    const history = await fetchBeleidskompasHistory(conversationId);
    store.setConversationId(conversationId);
    store.replaceMessages(history);
    const lastUser = history.filter((m) => m.role === "user").slice(-1)[0];
    const lastAssistant = history.filter((m) => m.role === "assistant").slice(-1)[0];
    store.setLastMessageId((lastAssistant || lastUser || {}).messageId || null);
    if (lastAssistant) {
      store.setStepResult(store.activeStep().id, {
        report_text: lastAssistant.text,
        citations: lastAssistant.citations,
        retrieval_trace: lastAssistant.retrieval_trace,
        updated_at: lastAssistant.ts,
      });
    }
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
