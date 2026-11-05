// Talking to the Beleidskompas endpoint of LibreChat. Beleidskompas is a
// LibreChat custom endpoint ("govchat-beleidskompas" in librechat.yaml), so
// a case is an ordinary LibreChat conversation: stored in MongoDB and listed
// like any other chat.
//
// Sending a message takes two calls: POST /api/agents/chat/:endpoint returns
// a {streamId} at once, and the reply arrives via SSE on
// GET /api/agents/chat/stream/:streamId (streamId === conversationId).

import { getLibreChatAuthToken, librechatFetch, newClientMessageId } from "../../shared/librechat-api.js";

const BELEIDSKOMPAS_ENDPOINT = "govchat-beleidskompas";
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
  const empty = { displayText: raw.trim(), citations: [], retrieval_trace: null };

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

/** The only channel to the backend is the chat message's plain text, so
 *  everything a request needs is composed into one labeled text: the
 *  substep, the case, the reports so far, the conversation about the
 *  substep and the message the user typed (each only when there is one).
 *  The main agent takes it apart on these labels. A typed message means a
 *  conversation turn. Without one, Beleidskompas writes the report of the
 *  substep. */
export function composePrompt({ substep, caseText, findings, conversation, message }) {
  const lines = [`Deelstap: ${substep.id} (${substep.title})`];
  const part = (label, value) => {
    const text = String(value || "").trim();
    if (text) lines.push(`${label} ${text}`);
  };
  part("Casus:", caseText);
  part("Eerdere bevindingen:", findings);
  part("Gesprek:", conversation);
  part("Bericht:", message);
  return lines.join("\n");
}

/** The counterpart of composePrompt, for a message read back from the
 *  history: takes the composed text apart again. The reports and the
 *  conversation are not needed back (they are rebuilt from the messages),
 *  so only the substep, the case and the typed message are returned. */
export function parseComposedPrompt(text) {
  const lines = String(text || "").split("\n");
  // The first line is what composePrompt wrote, "Deelstap: 1.3 (Stakeholderanalyse)".
  // The pattern, piece by piece, with the part of that line each one matches:
  //   ^Deelstap:         "Deelstap:"            the label, at the start of the line
  //   \s*                " "                    spaces, as many as there are (also none)
  //   (\d+\.\d+)          "1.3"                  the substep id: digits, a dot, digits -> head[1]
  //   \s*                " "                    spaces again
  //   (?:\((.*)\))?      "(Stakeholderanalyse)" the title inside the round brackets,
  //                                             kept without the brackets -> head[2];
  //                                             this piece may be missing altogether
  //   \s*$               ""                     spaces, then the end of the line
  // A first line of any other form gives null: then there is no substep.
  const head = /^Deelstap:\s*(\d+\.\d+)\s*(?:\((.*)\))?\s*$/.exec(lines[0] || "");
  // Every other part starts with its label at the start of a line and runs
  // until the next label.
  const labels = ["Casus:", "Eerdere bevindingen:", "Gesprek:", "Bericht:"];
  const parts = {};
  let current = "";
  for (const line of lines.slice(1)) {
    const label = labels.find((l) => line.startsWith(l));
    if (label) {
      current = label;
      parts[label] = line.slice(label.length);
    } else if (current) {
      parts[current] += "\n" + line;
    }
  }
  return {
    substepId: head ? head[1] : "",
    substepTitle: head ? String(head[2] || "").trim() : "",
    caseText: String(parts["Casus:"] || "").trim(),
    message: String(parts["Bericht:"] || "").trim(),
  };
}

/** Sends one message to the Beleidskompas custom endpoint and waits for
 *  the full reply via SSE. Returns { conversationId, messageId, text,
 *  citations, retrieval_trace }. */
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
        // The message holds what the page composed (see composePrompt); the
        // chat shows what the user typed, or the substep that was asked for.
        const { substepId, substepTitle, caseText, message } = parseComposedPrompt(m.text);
        const text = message || (substepId ? `Deelstap ${substepId}: ${substepTitle}` : String(m.text || "").trim());
        return { messageId: m.messageId, role: "user", text, substepId, caseText, conversation: Boolean(message), citations: [], retrieval_trace: null, ts: m.createdAt || new Date().toISOString() };
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
