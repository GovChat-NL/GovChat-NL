// The chat panel: the conversation with Beleidskompas, the feedback under an
// answer and the composer. Every request to Beleidskompas goes through here.
// That is the case and the messages the user types, and the reports the step
// card asks for (requestReport). Redraws itself when the messages change.

import { escapeHTML } from "../../../shared/html.js";
import { requireElement } from "../../../shared/dom.js";
import { composePrompt, sendBeleidskompasChatMessage, sendBeleidskompasFeedback } from "../beleidskompas-api.js";
import { formatRichText, formatTime, normalizeCitations, parseAdvice, verdictClass } from "../format.js";
import { citationButtonHTML, openCitationFromClick } from "../popups.js";

/** A rating per answer, sent anonymously (no user or case id) to the
 *  admin overlay, where administrators can see it. A comment is optional
 *  and appears after a thumb is chosen. */
function feedbackHTML(message, index) {
  if (message.feedbackSent) {
    return '<div class="gc-bk-feedback is-sent">Bedankt, je anonieme feedback is opgeslagen.</div>';
  }
  return `
    <div class="gc-bk-feedback" data-feedback-for="${index}">
      ${message.feedbackError ? `<span class="gc-bk-feedback-label">Versturen mislukt (${escapeHTML(message.feedbackError)}), probeer opnieuw.</span>` : ""}
      <span class="gc-bk-feedback-label">Was dit bruikbaar?</span>
      <button type="button" class="gc-bk-feedback-btn ${message.feedbackRating === "up" ? "is-chosen" : ""}" data-feedback-rating="up" aria-label="Wel bruikbaar">👍</button>
      <button type="button" class="gc-bk-feedback-btn ${message.feedbackRating === "down" ? "is-chosen" : ""}" data-feedback-rating="down" aria-label="Niet bruikbaar">👎</button>
      ${message.feedbackRating
        ? `<input type="text" class="gc-bk-feedback-comment" placeholder="Toelichting (optioneel, anoniem)" aria-label="Toelichting bij je feedback" maxlength="2000" />
           <button type="button" class="gc-bk-feedback-send" data-feedback-send="1">Versturen</button>`
        : ""}
    </div>`;
}

/** The full report is shown in the step card on the right, so the
 *  chat keeps only the summary and puts the rest behind a disclosure.
 *  Otherwise the same block of text would appear twice side by side. */
function messageBodyHTML(message) {
  if (message.role !== "assistant") return formatRichText(message.text);
  const advice = parseAdvice(message.text);
  if (!advice) return formatRichText(message.text);
  const summary = advice.sections.find((s) => /samenvatting/i.test(s.heading)) || advice.sections[0];
  // The sources are already shown as clickable chips under the message.
  const rest = advice.sections.filter((s) => s !== summary && !/^bronnen$/i.test(s.heading) && s.text);
  if (!rest.length) return formatRichText(summary.text);
  const restHTML = rest
    .map((s) => {
      const badge = s.verdict
        ? ` <span class="gc-bk-verdict ${verdictClass(s.verdict)}">${escapeHTML(s.verdict)}</span>`
        : "";
      return `<p class="gc-bk-msg-more-head"><span class="gc-bk-rich-h">${escapeHTML(s.heading)}</span>${badge}</p>${formatRichText(s.text)}`;
    })
    .join("");
  return `${formatRichText(summary.text)}<details class="gc-bk-msg-more"><summary>Volledige uitwerking</summary><div>${restHTML}</div></details>`;
}

const CHART_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>';

/** `stepLabel(agent)` names the step that answered a message in the
 *  conversation ("Stap 3 · Instrumentkeuze"), shown next to the author so
 *  the user sees which step answered, also when it is another step than
 *  the one they are in. */
function messageHTML(m, idx, stepLabel) {
  const isUser = m.role === "user";
  const label = !isUser && m.conversation && m.agent ? stepLabel(m.agent) : "";
  return `
    <div class="gc-bk-msg-row ${isUser ? "is-user" : "is-assistant"}">
      <div class="gc-bk-msg-col">
        <div class="gc-bk-msg">
          ${isUser
            ? ""
            : `<div class="gc-bk-msg-author"><span class="gc-bk-msg-avatar">${CHART_ICON}</span><span class="gc-bk-msg-name">Beleidskompas</span>${
                label ? `<span class="gc-bk-msg-step">${escapeHTML(label)}</span>` : ""
              }</div>`}
          <div class="gc-bk-msg-text">${
            m.pending && !m.text
              ? '<span class="gc-bk-typing-dots"><span></span><span></span><span></span></span>'
              : messageBodyHTML(m)
          }</div>
          ${Array.isArray(m.citations) && m.citations.length
            ? `<div class="gc-bk-citations">${m.citations.map(citationButtonHTML).join("")}</div>`
            : ""}
          ${!isUser && !m.pending && m.text ? feedbackHTML(m, idx) : ""}
        </div>
        <div class="gc-bk-msg-time">${escapeHTML(formatTime(m.ts))}</div>
      </div>
    </div>`;
}

/** `refreshState(conversationId)` (from cases.js) puts the case text and
 *  the reports as the store has them on the screen; the chat calls it
 *  after every answer. */
export function setupChat(store, { refreshState }) {
  const { state } = store;
  const chatLogEl = requireElement("gc-bk-chat-log");
  const chatInputEl = requireElement("gc-bk-chat-input");
  const sendBtn = requireElement("gc-bk-send");
  const newChatBtn = requireElement("gc-bk-new-chat");

  function stepLabel(stepId) {
    const step = store.steps.find((s) => s.id === stepId);
    return step ? `Stap ${step.nr} · ${step.title}` : "";
  }

  function renderChat() {
    chatLogEl.innerHTML = state.messages.map((m, idx) => messageHTML(m, idx, stepLabel)).join("");
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
  }

  async function submitFeedback(message, comment) {
    try {
      await sendBeleidskompasFeedback({ rating: message.feedbackRating, comment, stepId: store.activeStep().id });
      store.updateMessage(message, { feedbackSent: true });
    } catch (err) {
      store.updateMessage(message, { feedbackError: String(err?.message || err) });
    }
  }

  /** Sends one composed message to the orchestrator and waits for the
   *  answer. */
  async function requestOrchestrator(text) {
    const result = await sendBeleidskompasChatMessage({
      text,
      conversationId: state.conversationId,
      parentMessageId: state.lastMessageId,
    });

    if (!result.text) throw new Error("Beleidskompas gaf geen antwoord terug");
    if (result.conversationId) store.setConversationId(result.conversationId);
    if (result.messageId) store.setLastMessageId(result.messageId);

    return { answer: result.text, citations: result.citations, retrieval_trace: result.retrieval_trace, agent: result.agent };
  }

  function setComposerDisabled(disabled) {
    sendBtn.disabled = disabled;
    chatInputEl.disabled = disabled;
  }

  /** The text field is for the case at the start, and for the conversation
   *  about the substep shown after that. */
  function renderComposer() {
    chatInputEl.placeholder = store.caseStarted()
      ? `Stel een vraag of reageer op deelstap ${store.activeSubstep().id}`
      : "Beschrijf je casus";
  }

  /** Sends a request about `substep` to Beleidskompas.
   *
   *  If the user typed a `message`, Beleidskompas answers it in the chat.
   *  If there is no message, Beleidskompas writes the report of the
   *  substep. The answer appears in the chat. After that the cards are
   *  filled from the store: a report lands on the card of its substep,
   *  even if the user has gone to another substep in the meantime. An
   *  error message is not a report, so the store does not have it and the
   *  card stays as it was; the user can try again.
   *
   *  `caseDescription` is only passed with the first message, which is the
   *  case. The user's bubble then shows the case. Otherwise the bubble
   *  shows the message, or the name of the substep when the user clicked a
   *  button. While a request is under way, a new one is not sent. */
  async function ask(substep, message, caseDescription) {
    if (state.asking) return;
    const conversing = Boolean(message);
    const shown = caseDescription || message || `Deelstap ${substep.id}: ${substep.title}`;
    const text = composePrompt({ substep, caseText: state.caseText, message, shown });
    store.addMessage("user", shown, { substepId: substep.id, conversation: conversing });
    setComposerDisabled(true);
    store.setAsking(substep.id);

    // An empty answer bubble. Without text, the bubble shows typing dots
    // until the answer arrives.
    const pendingMessage = store.addMessage("assistant", "", { pending: true, substepId: substep.id, conversation: conversing });

    const conversationIdBeforeRequest = state.conversationId;
    try {
      const result = await requestOrchestrator(text);
      store.updateMessage(pendingMessage, {
        pending: false,
        text: String(result.answer || "").trim(),
        citations: normalizeCitations(result.citations),
        retrieval_trace: result.retrieval_trace || null,
        agent: result.agent || null,
      });
      if (state.conversationId === conversationIdBeforeRequest) store.changed("conversation");
      // The answer is in the chat by now. When the store cannot be read,
      // only the cards are behind, so that is a message of its own and not
      // an error in place of the answer.
      try {
        await refreshState(state.conversationId);
      } catch (err) {
        store.addMessage("assistant", `Kon de stand van de casus niet ophalen (${String(err?.message || err)}). Open de casus opnieuw om de kaarten bij te werken.`);
      }
    } catch (err) {
      store.updateMessage(pendingMessage, {
        pending: false,
        text: `Beleidskompas niet bereikbaar of fout: ${String(err?.message || err)}. Probeer het opnieuw of open een nieuwe chat.`,
      });
    } finally {
      store.setAsking("");
      setComposerDisabled(false);
      chatInputEl.focus();
    }
  }

  /** What the user types first is the case. The case is stored, and
   *  Beleidskompas writes the report of the active substep. Everything typed
   *  after that is a message about the active substep. */
  function sendUserMessage() {
    const text = chatInputEl.value.trim();
    if (!text || state.asking) return;
    chatInputEl.value = "";
    if (store.caseStarted()) {
      // A message about the active substep.
      ask(store.activeSubstep(), text);
    } else {
      // The first text is the case. Sending it asks for the report of the
      // active substep. The user's bubble shows the case.
      store.setCaseText(text);
      ask(store.activeSubstep(), "", text);
    }
  }

  newChatBtn.addEventListener("click", () => store.startNewSession());
  sendBtn.addEventListener("click", sendUserMessage);
  chatInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendUserMessage();
    }
  });
  chatLogEl.addEventListener("click", (e) => {
    const feedbackRow = e.target.closest("[data-feedback-for]");
    if (!feedbackRow) {
      openCitationFromClick(e);
      return;
    }
    const message = state.messages[Number(feedbackRow.getAttribute("data-feedback-for"))];
    const ratingBtn = e.target.closest("[data-feedback-rating]");
    if (message && ratingBtn) {
      store.updateMessage(message, { feedbackRating: ratingBtn.getAttribute("data-feedback-rating"), feedbackError: "" });
    } else if (message && e.target.closest("[data-feedback-send]")) {
      submitFeedback(message, feedbackRow.querySelector(".gc-bk-feedback-comment")?.value || "");
    }
  });

  store.subscribe("chat", renderChat);
  store.subscribe("steps", renderComposer);

  /** The buttons in step-card.js call this to ask for the report of a
   *  substep. */
  return { requestReport: (substep) => ask(substep, "") };
}
