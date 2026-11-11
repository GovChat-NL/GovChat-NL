// Talking to Beleidskompas from the browser. Messages go through LibreChat:
// Beleidskompas is a LibreChat custom endpoint ("govchat-beleidskompas" in
// librechat.yaml), so a case is a LibreChat conversation and the case id is
// its conversationId. The state of a case (the case text, the reports and
// the conversation) is kept by the Beleidskompas store, which the page
// reads through /govchat-api/beleidskompas/.
//
// Sending a message takes two calls: POST /api/agents/chat/:endpoint returns
// a {streamId} at once, and the reply arrives via SSE on
// GET /api/agents/chat/stream/:streamId (streamId === conversationId).

import { getLibreChatAuthToken, librechatFetch, newClientMessageId } from "../../shared/librechat-api.js";

const BELEIDSKOMPAS_ENDPOINT = "govchat-beleidskompas";
// nginx forwards this to the store's "my cases" API, which answers with
// the cases of the logged-in user only (it reads who that is from the
// LibreChat cookie).
const STORE_URL = "/govchat-api/beleidskompas";
const NO_PARENT_MESSAGE_ID = "00000000-0000-0000-0000-000000000000";

/** Extracts the assistant's text from a LibreChat message object. LibreChat
 *  puts the text in the content parts and leaves `.text` empty once it uses
 *  those. */
function extractMessageText(message) {
  if (!message) return "";
  if (Array.isArray(message.content)) {
    const textPart = message.content.find((p) => p && p.type === "text" && typeof p.text === "string");
    if (textPart && textPart.text.trim()) return textPart.text.trim();
  }
  return String(message.text || "").trim();
}

const CITATIONS_META_MARKER = "BELEIDSKOMPAS-META";

const CITATIONS_META_LABEL = "beleidskompas-meta";

/** n8n-openai-bridge only forwards plain text to LibreChat, so the citations
 *  and the retrieval trace travel along as a trailing markdown link
 *  definition (appendCitationsMetaBlock in agents/beleidskompas/shared.js),
 *  which no markdown view shows. This splits it back out; safe to call on
 *  text that never had one. */
export function parseCitationsMetaBlock(text) {
  const raw = String(text || "");
  const empty = { displayText: raw.trim(), citations: [], retrieval_trace: null, agent: null, asked_from: null };

  // `agent` is the id of the step that answered, `asked_from` the substep
  // the user was in when asking; both are null for older messages.
  const shape = (parsed, displayText) => ({
    displayText,
    citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    retrieval_trace: parsed.retrieval_trace || null,
    agent: parsed.agent ? String(parsed.agent) : null,
    asked_from: parsed.asked_from ? String(parsed.asked_from) : null,
  });

  const defMarker = `[${CITATIONS_META_LABEL}]: data:application/json;base64,`;
  const defIdx = raw.lastIndexOf(defMarker);
  if (defIdx !== -1) {
    const encoded = raw.slice(defIdx + defMarker.length).split("\n")[0].trim();
    try {
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      return shape(JSON.parse(new TextDecoder().decode(bytes)), raw.slice(0, defIdx).trim());
    } catch (_) {
      return empty;
    }
  }

  // Older messages carry the block as an HTML comment instead.
  const marker = `<!--${CITATIONS_META_MARKER}:`;
  const startIdx = raw.lastIndexOf(marker);
  if (startIdx === -1) return empty;

  const endIdx = raw.indexOf("-->", startIdx);
  if (endIdx === -1) return empty;

  try {
    const parsed = JSON.parse(raw.slice(startIdx + marker.length, endIdx));
    return shape(parsed, (raw.slice(0, startIdx) + raw.slice(endIdx + 3)).trim());
  } catch (_) {
    return empty;
  }
}

/** Sends a rating for an answer to the admin, which stores it anonymously:
 *  no user or conversation id, only the rating, an optional comment and
 *  the step it is about. */
export async function sendBeleidskompasFeedback({ rating, comment, stepId }) {
  const resp = await fetch("/govchat-api/beleidskompas-feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating, comment: String(comment || ""), step_id: stepId }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
}

const REQUEST_META_LABEL = "beleidskompas-request";

/** The only channel to the orchestrator is the chat message, so what the
 *  orchestrator needs to know about a request travels behind the visible
 *  text of the message, in a markdown link definition with base64 JSON
 *  (the way the citations travel behind an answer, see
 *  parseCitationsMetaBlock): the substep, the case text and the message
 *  the user typed. A markdown view does not show the definition, and what
 *  the user typed sits inside the JSON, so it can never be mistaken for
 *  one of those fields. `shown` is the visible text, what the chat of
 *  LibreChat shows for this message. The reports and the conversation so
 *  far are not sent along: the orchestrator reads those from the store. A
 *  typed message means a conversation turn. Without one, Beleidskompas
 *  writes the report of the substep. */
export function composePrompt({ substep, caseText, message, shown }) {
  const request = { substep_id: substep.id, case_text: String(caseText || "").trim(), message: String(message || "").trim() };
  const visible = String(shown || "").trim() || request.message || `Deelstap ${substep.id}: ${substep.title}`;
  return `${visible}\n\n[${REQUEST_META_LABEL}]: data:application/json;base64,${base64Utf8(JSON.stringify(request))}`;
}

/** btoa only takes bytes, so the text goes through UTF-8 first. */
function base64Utf8(text) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Sends one message to the Beleidskompas custom endpoint and waits for
 *  the full reply via SSE. Returns { conversationId, messageId, text,
 *  citations, retrieval_trace, agent }. */
export async function sendBeleidskompasChatMessage({ text, conversationId, parentMessageId }) {
  const messageId = newClientMessageId();
  const startResp = await librechatFetch("/api/agents/chat/" + BELEIDSKOMPAS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      sender: "User",
      isCreatedByUser: true,
      messageId,
      parentMessageId: parentMessageId || NO_PARENT_MESSAGE_ID,
      conversationId: conversationId || null,
      endpoint: BELEIDSKOMPAS_ENDPOINT,
      endpointType: "custom",
      model: BELEIDSKOMPAS_ENDPOINT,
      isContinued: false,
      isRegenerate: false,
      isTemporary: false,
      editedContent: null,
      addedConvo: null,
    }),
  });
  const startData = await startResp.json().catch(() => ({}));
  if (!startResp.ok || !startData?.streamId) {
    throw new Error(String(startData?.message || startData?.error || `Kon geen antwoord starten (HTTP ${startResp.status}).`));
  }

  const streamId = startData.streamId;
  const token = await getLibreChatAuthToken(false);
  const streamResp = await fetch(`/api/agents/chat/stream/${encodeURIComponent(streamId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
  });
  if (!streamResp.ok || !streamResp.body) {
    throw new Error(`Kon geen antwoordstroom openen (HTTP ${streamResp.status}).`);
  }

  const reader = streamResp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finalPayload = null;
  let sawError = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      let eventName = "message";
      const dataLines = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;

      let payload;
      try {
        payload = JSON.parse(dataLines.join("\n"));
      } catch (_) {
        continue;
      }

      if (eventName === "error" || payload?.error) {
        sawError = String(payload?.error || payload?.message || "Onbekende foutmelding van de server.");
        continue;
      }
      if (payload?.final) {
        finalPayload = payload;
      }
    }
    if (finalPayload) break;
  }
  try {
    reader.cancel();
  } catch (_) {
    // The reply is complete; a failed cancel of the stream changes nothing.
  }

  if (!finalPayload) {
    throw new Error(sawError || "Geen eindantwoord ontvangen van Beleidskompas.");
  }

  const responseMessage = finalPayload.responseMessage || {};
  const { displayText, citations, retrieval_trace, agent } = parseCitationsMetaBlock(extractMessageText(responseMessage));
  return {
    conversationId: finalPayload?.conversation?.conversationId || streamId,
    messageId: responseMessage.messageId || null,
    text: displayText,
    citations,
    retrieval_trace,
    agent,
  };
}

/** The id of the last message of a LibreChat conversation. LibreChat links
 *  every message to the one before it. The page sends that id along with
 *  the next message; without it, the next message would start a new
 *  branch in the conversation as LibreChat shows it. */
export async function fetchLastMessageId(conversationId) {
  const resp = await librechatFetch(`/api/messages/${encodeURIComponent(conversationId)}`, { method: "GET" });
  if (!resp.ok) throw new Error(`Kon het gesprek niet ophalen (HTTP ${resp.status}).`);
  const messages = await resp.json().catch(() => []);
  const last = (Array.isArray(messages) ? messages : [])
    .slice()
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
    .pop();
  return (last && last.messageId) || null;
}

/** The state of a case as the store keeps it: the newest case text, the
 *  newest report per substep and the turns of the conversation. Throws
 *  when the case is not in the store or belongs to another user. */
export async function fetchCaseState(caseId) {
  const resp = await fetch(`${STORE_URL}/cases/${encodeURIComponent(caseId)}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Kon de stand van de casus niet ophalen (HTTP ${resp.status}).`);
  return resp.json();
}

/** Turns the state from the store into what the screen works with: the
 *  case text, the report per substep (`results`, in the shape of the step
 *  cards), the chat messages and the substep with the newest report
 *  (`lastReportSubstepId`), so a reopened case continues there. The chat
 *  is the case followed by the conversation, as it was before the case was
 *  closed. */
export function readCaseState(state) {
  const results = {};
  let lastReportSubstepId = "";
  let newest = "";
  for (const [substepId, report] of Object.entries(state?.reports || {})) {
    const updatedAt = String(report.created_at || "");
    results[substepId] = { report_text: String(report.text || ""), citations: report.citations || [], retrieval_trace: report.retrieval_trace || null, updated_at: updatedAt };
    if (updatedAt >= newest) {
      newest = updatedAt;
      lastReportSubstepId = substepId;
    }
  }
  const caseText = String(state?.case_text?.text || "");
  const caseMessage = caseText ? [{ role: "user", text: caseText, agent: null, substepId: "", ts: state.case_text.created_at }] : [];
  const turns = (state?.turns || []).map((t) => ({
    role: t.role,
    text: String(t.text || ""),
    agent: t.role === "assistant" ? t.step_id || null : null,
    substepId: t.asked_from || "",
    ts: t.created_at,
  }));
  return { caseText, results, messages: [...caseMessage, ...turns], lastReportSubstepId };
}

/** The user's own cases from the store, newest first, so a case can be
 *  reopened without its id already being in sessionStorage. */
export async function listBeleidskompasCases(limit) {
  const resp = await fetch(`${STORE_URL}/cases?limit=${encodeURIComponent(limit || 20)}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Kon casuslijst niet ophalen (HTTP ${resp.status}).`);
  const cases = await resp.json().catch(() => []);
  return (Array.isArray(cases) ? cases : []).map((c) => ({
    conversationId: c.id,
    title: String(c.title || "").trim() || "Naamloze casus",
    updatedAt: c.updated_at || c.created_at || null,
  }));
}
