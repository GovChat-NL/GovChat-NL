// The chat panel: the conversation with Beleidskompas, the feedback under an
// answer and the composer. Redraws itself when the messages change.

import { escapeHTML } from "../../../shared/html.js";
import { requireElement } from "../../../shared/dom.js";
import { composePrompt, sendBeleidskompasChatMessage, sendBeleidskompasFeedback } from "../beleidskompas-api.js";
import { formatRichText, formatTime, normalizeCitations, parseAdvice, verdictClass } from "../format.js";
import { citationButtonHTML, openCitationFromClick } from "../popups.js";

/** Reveals `fullText` progressively over ~`durationMs`, calling
 *  `onTick(partialText)` each frame - a client-side typewriter effect,
 *  since the backend delivers the whole answer in one delta (see
 *  extractDeltaText) rather than true token-by-token streaming. Returns a
 *  controller so a caller can jump straight to the full text (`finish()`)
 *  once the authoritative `final` SSE event arrives. */
function typewriterReveal(fullText, onTick, durationMs) {
  const frameMs = 30;
  const frames = Math.max(1, Math.round((durationMs || 700) / frameMs));
  const step = Math.max(1, Math.ceil(fullText.length / frames));
  let shown = 0;
  let done = false;
  let timer = null;

  function tick() {
    if (done) return;
    shown = Math.min(fullText.length, shown + step);
    onTick(fullText.slice(0, shown));
    if (shown < fullText.length) timer = setTimeout(tick, frameMs);
    else done = true;
  }
  timer = setTimeout(tick, frameMs);

  return {
    finish() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      onTick(fullText);
    },
  };
}

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

/** The full elaboration is shown in the step card on the right, so the
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

function messageHTML(m, idx) {
  const isUser = m.role === "user";
  return `
    <div class="gc-bk-msg-row ${isUser ? "is-user" : "is-assistant"}">
      <div class="gc-bk-msg-col">
        <div class="gc-bk-msg">
          ${isUser
            ? ""
            : `<div class="gc-bk-msg-author"><span class="gc-bk-msg-avatar">${CHART_ICON}</span><span class="gc-bk-msg-name">Beleidskompas</span></div>`}
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

export function setupChat(store, { sources }) {
  const { state, steps } = store;
  const chatLogEl = requireElement("gc-bk-chat-log");
  const chatInputEl = requireElement("gc-bk-chat-input");
  const sendBtn = requireElement("gc-bk-send");
  const newChatBtn = requireElement("gc-bk-new-chat");

  function renderChat() {
    chatLogEl.innerHTML = state.messages.map(messageHTML).join("");
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

  async function requestHoofdagent(userText, onDelta) {
    const step = store.activeStep();
    const text = composePrompt({
      step,
      priorReports: steps
        .slice(0, state.activeStep)
        .map((s) => String(store.stepResult(s.id).report_text || "").trim())
        .filter(Boolean)
        .join("\n\n"),
      currentReport: store.stepResult(step.id).report_text,
      sources,
      question: userText,
    });

    const result = await sendBeleidskompasChatMessage({
      text,
      conversationId: state.conversationId,
      parentMessageId: state.lastMessageId,
      onDelta,
    });

    if (!result.text) throw new Error("Beleidskompas gaf geen antwoord terug");
    if (result.conversationId) store.setConversationId(result.conversationId);
    if (result.messageId) store.setLastMessageId(result.messageId);

    return { answer: result.text, citations: result.citations, retrieval_trace: result.retrieval_trace };
  }

  function setComposerDisabled(disabled) {
    sendBtn.disabled = disabled;
    chatInputEl.disabled = disabled;
  }

  async function sendUserMessage() {
    const text = chatInputEl.value.trim();
    if (!text || sendBtn.disabled) return;
    store.addMessage("user", text);
    chatInputEl.value = "";
    setComposerDisabled(true);

    // Typing dots at once; the typewriter fills the bubble as soon as the
    // answer text arrives, ahead of the final event.
    const pendingMessage = store.addMessage("assistant", "", { pending: true });

    // An on_message_delta event carries either the full text so far or a
    // small fragment, so a delta that extends what is shown replaces it and
    // any other delta is appended.
    let reveal = null;
    let accumulatedDeltaText = "";
    const onDelta = (deltaText) => {
      accumulatedDeltaText = deltaText.startsWith(accumulatedDeltaText) ? deltaText : accumulatedDeltaText + deltaText;
      if (reveal) reveal.finish();
      reveal = typewriterReveal(accumulatedDeltaText, (shownText) => store.updateMessage(pendingMessage, { text: shownText }));
    };

    const conversationIdBeforeRequest = state.conversationId;
    try {
      const result = await requestHoofdagent(text, onDelta);
      if (reveal) reveal.finish();
      store.updateMessage(pendingMessage, {
        pending: false,
        text: String(result.answer || "").trim(),
        citations: normalizeCitations(result.citations),
        retrieval_trace: result.retrieval_trace || null,
      });
      store.setStepResult(store.activeStep().id, {
        report_text: pendingMessage.text,
        citations: pendingMessage.citations,
        retrieval_trace: pendingMessage.retrieval_trace,
        updated_at: new Date().toISOString(),
      });
      if (state.conversationId === conversationIdBeforeRequest) store.changed("conversation");
    } catch (err) {
      if (reveal) reveal.finish();
      store.updateMessage(pendingMessage, {
        pending: false,
        text: `Beleidskompas niet bereikbaar of fout: ${String(err?.message || err)}. Probeer het opnieuw of open een nieuwe chat.`,
      });
    } finally {
      setComposerDisabled(false);
      chatInputEl.focus();
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
}
