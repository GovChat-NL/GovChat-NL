// Earlier cases: resuming one, the list in the side bar and the title above
// the chat. The list and the title redraw themselves when the open
// conversation changes.

import { escapeAttr, escapeHTML } from "../../../shared/html.js";
import { requireElement } from "../../../shared/dom.js";
import { fetchCaseState, fetchLastMessageId, listBeleidskompasCases, readCaseState } from "../beleidskompas-api.js";
import { formatRelativeCaseDate } from "../format.js";

export function setupCases(store) {
  const { state } = store;
  const recentCasesListEl = requireElement("gc-bk-recent-cases-list");
  const convoTitleEl = requireElement("gc-bk-convo-title");

  /** Puts the case text and the reports as the store has them on the
   *  screen. Called after every answer, so the cards show what is stored
   *  and not what the page thinks happened. The chat is left alone: it
   *  already shows the conversation. */
  async function refreshState(conversationId) {
    const { caseText, results } = readCaseState(await fetchCaseState(conversationId));
    // The user may have opened another case while the answer was under way.
    if (state.conversationId !== conversationId) return;
    store.setCaseText(caseText);
    store.replaceResults(results);
  }

  /** Opens a case from the store - shared by the "resume on reopen" path
   *  and clicking an entry in "Eerdere casussen". The chat shows the
   *  conversation, the reports go to their substeps, and the substep with
   *  the newest report becomes the active one, so the case continues where
   *  it was left. */
  async function resumeConversation(conversationId) {
    const [caseState, lastMessageId] = await Promise.all([fetchCaseState(conversationId), fetchLastMessageId(conversationId)]);
    const { caseText, results, messages, lastReportSubstepId } = readCaseState(caseState);
    store.setConversationId(conversationId);
    store.setLastMessageId(lastMessageId);
    store.replaceMessages([{ role: "assistant", text: "Casus geopend. Stel een vraag of werk een deelstap uit." }, ...messages]);
    store.setCaseText(caseText);
    if (lastReportSubstepId) store.setActiveSubstep(store.substeps.findIndex((s) => s.id === lastReportSubstepId));
    store.replaceResults(results);
  }

  /** The heading of the chat card: the case title Beleidskompas gives
   *  the case, once there is one, otherwise "Nieuw gesprek". */
  function setConversationTitle(title) {
    const clean = String(title || "").trim();
    convoTitleEl.textContent = clean || "Nieuw gesprek";
    convoTitleEl.title = clean;
  }

  async function renderRecentCases() {
    try {
      const cases = await listBeleidskompasCases(8);
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

  return { resumeConversation, refreshState };
}
