// ---------------------------------------------------------------------
// LibreChat chat pipeline for Beleidskompas
//
// Beleidskompas is wired up as a real LibreChat custom endpoint
// ("govchat-beleidskompas" in librechat.yaml), so a case is a genuine
// LibreChat conversation (persisted in MongoDB, listed like any other
// chat) instead of an in-memory object that disappeared on reload.
//
// LibreChat's real send/receive contract (v0.8.7, verified against its
// own source): POST /api/agents/chat/:endpoint returns a {streamId}
// immediately; the actual reply arrives via SSE on
// GET /api/agents/chat/stream/:streamId (streamId === conversationId).
// ---------------------------------------------------------------------

import { getLibreChatAuthToken, librechatFetch, newClientMessageId } from "../../shared/librechat-api.js";

const BELEIDSKOMPAS_ENDPOINT = "govchat-beleidskompas";
const NO_PARENT_MESSAGE_ID = "00000000-0000-0000-0000-000000000000";

/** Extracts the assistant's final text from a LibreChat message object
 *  (content-parts array is the real field; `.text` is left blank on this
 *  LibreChat version once content-parts are used). */
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

/** Mirrors logic.js's parseCitationsMetaBlock: n8n-openai-bridge only
 *  forwards plain text to LibreChat, so citations/retrieval_trace travel
 *  along as a trailing markdown link definition (appendCitationsMetaBlock in
 *  logic.js) - onzichtbaar in elke markdown-weergave, ook in LibreChat zelf.
 *  Splits it back out here. Safe to call on text that never had one. */
export function parseCitationsMetaBlock(text) {
  const raw = String(text || "");
  const empty = { displayText: raw.trim(), citations: [], retrieval_trace: null };

  // Citations are normalized by the caller (normalizeCitations lives inside
  // openBeleidskompas; this helper is module-level).
  const shape = (parsed, displayText) => ({
    displayText,
    citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    retrieval_trace: parsed.retrieval_trace || null,
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

  // Messages stored before the switch still carry an HTML comment.
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

/** Extracts the text of an `on_message_delta` SSE event, if any. This
 *  workflow does one blocking LLM call (no true token-by-token streaming),
 *  so in practice there is exactly one such event, carrying the complete
 *  answer - but it arrives before the `final` event, which is otherwise
 *  the first sign of life the UI gets after a ~1-20s wait. */
function extractDeltaText(payload) {
  if (!payload || payload.event !== "on_message_delta") return null;
  const parts = payload.data?.delta?.content;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  return text || null;
}

/** Sends one message to the Beleidskompas custom endpoint and waits for
 *  the full reply via SSE. Returns { conversationId, messageId, text }.
 *  `onDelta(displayText)` fires as soon as the answer text is available,
 *  ahead of the final (persisted) event, for a typewriter-reveal effect. */
export async function sendBeleidskompasChatMessage({ text, conversationId, parentMessageId, onDelta }) {
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
      } else if (typeof onDelta === "function") {
        const deltaText = extractDeltaText(payload);
        if (deltaText) onDelta(parseCitationsMetaBlock(deltaText).displayText);
      }
    }
    if (finalPayload) break;
  }
  try {
    reader.cancel();
  } catch (_) {
    // ignore
  }

  if (!finalPayload) {
    throw new Error(sawError || "Geen eindantwoord ontvangen van Beleidskompas.");
  }

  const responseMessage = finalPayload.responseMessage || {};
  const { displayText, citations, retrieval_trace } = parseCitationsMetaBlock(extractMessageText(responseMessage));
  return {
    conversationId: finalPayload?.conversation?.conversationId || streamId,
    messageId: responseMessage.messageId || null,
    text: displayText,
    citations,
    retrieval_trace,
  };
}

/** Reads back a previously-persisted Beleidskompas conversation so a page
 *  reload can resume the same case instead of starting over. */
export async function fetchBeleidskompasHistory(conversationId) {
  const resp = await librechatFetch(`/api/messages/${encodeURIComponent(conversationId)}`, { method: "GET" });
  if (!resp.ok) throw new Error(`Kon casusgeschiedenis niet ophalen (HTTP ${resp.status}).`);
  const messages = await resp.json().catch(() => []);
  return (Array.isArray(messages) ? messages : [])
    .slice()
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
    .map((m) => {
      if (m.isCreatedByUser) {
        return { messageId: m.messageId, role: "user", text: String(m.text || "").trim(), citations: [], retrieval_trace: null, ts: m.createdAt || new Date().toISOString() };
      }
      const { displayText, citations, retrieval_trace } = parseCitationsMetaBlock(extractMessageText(m));
      return { messageId: m.messageId, role: "assistant", text: displayText, citations, retrieval_trace, ts: m.createdAt || new Date().toISOString() };
    });
}

/** Lists the user's own recent Beleidskompas cases (LibreChat conversations
 *  for this endpoint), newest first, so a case can be reopened without
 *  needing its conversationId to already be in sessionStorage. */
export async function listRecentBeleidskompasConversations(limit) {
  const resp = await librechatFetch(`/api/convos?limit=${encodeURIComponent(limit || 20)}`, { method: "GET" });
  if (!resp.ok) throw new Error(`Kon casuslijst niet ophalen (HTTP ${resp.status}).`);
  const data = await resp.json().catch(() => ({}));
  const conversations = Array.isArray(data?.conversations) ? data.conversations : [];
  return conversations
    .filter((c) => c && c.endpoint === BELEIDSKOMPAS_ENDPOINT)
    .map((c) => ({
      conversationId: c.conversationId,
      title: parseCitationsMetaBlock(String(c.title || "").trim()).displayText || "Naamloze casus",
      updatedAt: c.updatedAt || c.createdAt || null,
    }));
}
