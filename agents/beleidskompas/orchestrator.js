'use strict';

/**
 * The Beleidskompas orchestrator (the "orchestrator" workflow in n8n).
 *
 * Every chat message for the Beleidskompas endpoint arrives here first,
 * through the n8n-openai-bridge. The orchestrator is an AI Agent node. It
 * does not work out a step itself: every step has its own agent (see
 * step-agent.js), which the orchestrator calls as a tool. It decides which
 * step a request or a question is about, and writes the message the user
 * reads in the chat.
 *
 * Around the agent, Code nodes do what must always happen in a fixed order.
 * Before it: check the caller's token, take the message of the page apart,
 * and put together what the agent gets to read from the state of the case
 * in the Beleidskompas store. After it: put the answer together. The
 * functions for those Code nodes are in this file. Reading from and writing
 * to the store is done by HTTP Request nodes in the workflow.
 *
 * The one request the agent never sees is LibreChat's request for a
 * conversation title, which is about no step.
 *
 * generate-workflow.js copies these functions, with the ones they use from
 * shared.js, into the Code nodes of beleidskompas-orchestrator.json, so the
 * code that runs in n8n is this code.
 */

const {
  ORCHESTRATOR_PROMPT_TEMPLATE,
  TITLE_REQUEST_MARKER,
  TITLE_PREFIX,
  extractSuppliedToken,
  parsePageMessage,
  isTitleRequest,
  buildFallbackTitle,
  extractConvoUserText,
  toolCalls,
  nodeError,
} = require('./shared');

// Shown in the chat when the page asks for a report without naming a
// substep that exists.
const UNKNOWN_STEP_TEXT =
  'Beleidskompas kon niet bepalen voor welke stap dit bericht is en heeft het daarom niet beantwoord. ' +
  'Stel je vraag opnieuw vanaf de Beleidskompas-pagina, met een stap gekozen.';

// Shown in the chat when the store cannot be used. The store is where the
// agents get the case, the earlier reports and the conversation from, and
// where a report is kept. Without it an agent would answer as if the case
// were new and the answer would be lost, while the user sees a normal
// answer. So the user is told instead.
const STORE_MISSING_TEXT =
  'Beleidskompas kan zijn opslag niet gebruiken en heeft dit bericht daarom niet beantwoord. Meld dit bij de beheerder.';
const STORE_FAILED_TEXT = 'De opslag van Beleidskompas gaf een fout. Dit bericht is daarom niet beantwoord; probeer het later opnieuw.';
const STORE_WARNING_TEXT = 'Let op: de opslag van Beleidskompas gaf een fout. Dit antwoord is mogelijk niet bewaard.';

const NO_ANSWER_TEXT = 'Beleidskompas kon dit bericht niet beantwoorden. Probeer het later opnieuw.';

const TITLE_SYSTEM_PROMPT =
  'Je genereert uitsluitend een korte titel (maximaal 6 woorden) voor een gesprek, in het Nederlands. ' +
  'Geen opmaak, geen aanhalingstekens, geen toelichting: alleen de titel zelf.';

// How many turns of the conversation the agents get to read.
const MAX_TURNS = 100;

/** The text of the incoming message: the bridge delivers it in
 *  `currentMessage` and `chatInput`, direct webhook calls in `question`. */
function incomingMessage(body) {
  const b = body && typeof body === 'object' ? body : {};
  return String(b.currentMessage || b.chatInput || b.question || '');
}

/** The name of the tool that calls a step's agent, and the step id that
 *  name stands for. */
function stepToolName(step) {
  return `stap${step.nr}_agent`;
}

/** The system prompt of the orchestrator agent: the template with the list
 *  of step agents filled in. `steps` are the step definitions from steps/. */
function buildOrchestratorPrompt(steps, template) {
  const list = steps
    .map((step) => `- ${stepToolName(step)}: stap ${step.nr}, ${step.title} (${step.substeps.map((s) => `${s.id} ${s.title}`).join(', ')})`)
    .join('\n');
  return String(template || ORCHESTRATOR_PROMPT_TEMPLATE).replaceAll('{{steps}}', list);
}

/** What kind of request came in, and its parts. `kind` is:
 *  - "refused": nothing is done; `text` is what the chat shows (empty for a
 *    wrong token, so the caller learns nothing);
 *  - "title": LibreChat asks for a conversation title, made from `title_source`;
 *  - "report": the page asks for the report of `substep_id`;
 *  - "message": the user typed `message`, from `substep_id` when the page
 *    said where the user is.
 *  The case is the conversation (`sessionId`) and belongs to the user
 *  (`userId`), both passed on by the bridge. `substepIds` are the substeps
 *  that exist. `now` is the time in milliseconds, for the duration. */
function prepareRequest({ body, headers, env, substepIds, now }) {
  const b = body && typeof body === 'object' ? body : {};
  const started_at = now;
  const refuse = (error, text) => ({ kind: 'refused', ok: false, step_id: null, error, text, answer: text, started_at });

  // A wrong token gives a normal answer with ok: false, not a thrown error:
  // n8n can turn a thrown error into an empty response, and then the caller
  // sees nothing at all.
  const expectedToken = String((env && (env.BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN || env.N8N_WEBHOOK_TOKEN)) || '').trim();
  if (expectedToken && extractSuppliedToken(headers) !== expectedToken) return refuse('Unauthorized webhook token', '');

  const case_id = String(b.sessionId || '').trim();
  const user_id = String(b.userId || '').trim();

  // LibreChat asks for a conversation title through this same endpoint. That
  // request carries TITLE_REQUEST_MARKER (set in librechat.yaml), sometimes
  // in systemPrompt and sometimes in the message itself.
  const text = incomingMessage(b);
  if (isTitleRequest(text) || isTitleRequest(String(b.systemPrompt || ''))) {
    // The title is made from what the user wrote, not from the block the
    // page put behind it.
    const conversation = parsePageMessage(extractConvoUserText(text.replaceAll(TITLE_REQUEST_MARKER, '')));
    const title_source = conversation.message || conversation.shown;
    return { kind: 'title', ok: true, case_id, user_id, title_source: title_source.slice(0, 2000), started_at };
  }

  const storeConfigured = Boolean(String((env && env.BELEIDSKOMPAS_STORE_URL) || '').trim() && String((env && env.BELEIDSKOMPAS_STORE_TOKEN) || '').trim());
  if (!storeConfigured) return refuse('Store not configured', STORE_MISSING_TEXT);
  if (!case_id || !user_id) return refuse('No conversation or user from the bridge', STORE_MISSING_TEXT);

  const parts = parsePageMessage(text);
  const known = Array.isArray(substepIds) ? substepIds : [];
  const substep_id = known.includes(parts.substepId) ? parts.substepId : '';
  if (!parts.message && !substep_id) return refuse('No substep recognised in the request', UNKNOWN_STEP_TEXT);

  return {
    kind: parts.message ? 'message' : 'report',
    ok: true,
    case_id,
    user_id,
    substep_id,
    message: parts.message,
    started_at,
  };
}

/** What the agents get to read, from the state of the case in the store:
 *  the reports so far, the last turns of the conversation and the request.
 *
 *  The orchestrator reads `prompt`, with every report in it. The agent of a
 *  step gets the reports as `findings`. For a typed message that is every
 *  report too. For a request for a report it is every report up to and
 *  including the substep asked for, because a report builds on what came
 *  before. `substepIds` gives the order of the substeps.
 *
 *  `request` is what prepareRequest returned and `state` what the store
 *  answered. Without the store there is no answer: the result is then
 *  `ok: false` with a message for the chat. */
function buildContext({ request, state, substepIds }) {
  const stateError = nodeError(state) || (state && state.reports !== null && typeof state.reports === 'object' ? null : 'No state in the answer of the store');
  if (stateError) {
    return { ...request, ok: false, step_id: null, error: `state: ${stateError}`, text: STORE_FAILED_TEXT, answer: STORE_FAILED_TEXT };
  }

  const reports = state.reports;
  const order = Array.isArray(substepIds) ? substepIds : [];
  const ids = Object.keys(reports).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const reportTexts = (reportIds) =>
    reportIds
      .map((id) => String(reports[id].text || '').trim())
      .filter(Boolean)
      .join('\n\n');

  const upTo = request.kind === 'report' ? order.indexOf(request.substep_id) : -1;
  const findings = reportTexts(ids.filter((id) => upTo === -1 || order.indexOf(id) <= upTo));
  const allReports = reportTexts(ids);
  const turns = Array.isArray(state.turns) ? state.turns : [];
  const conversation = turns.map((t) => `${t.role === 'user' ? 'Gebruiker' : 'Beleidskompas'}: ${String(t.text || '').trim()}`).join('\n');
  const asked =
    request.kind === 'message'
      ? `Bericht van de gebruiker (de gebruiker zit in deelstap ${request.substep_id || 'onbekend'}):\n${request.message}`
      : `Verzoek: werk deelstap ${request.substep_id} uit.`;

  const prompt = [
    allReports ? `Bevindingen tot nu toe:\n${allReports}` : 'Bevindingen tot nu toe: (nog geen deelstap uitgewerkt)',
    conversation && `Laatste beurten van het gesprek:\n${conversation}`,
    asked,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    ...request,
    findings,
    conversation,
    prompt,
  };
}

/** The title LibreChat asked for, from what the model replied. Never fails:
 *  without a usable reply the title is made from the first words of the
 *  case, since a broken title must never break the conversation. */
function buildTitle({ request, reply }) {
  const raw = nodeError(reply) ? '' : String((reply && reply.text) || '');
  const wrapperChars = new Set(['"', "'", '#', '*', '_']);
  let start = 0;
  let end = raw.length;
  while (start < end && (wrapperChars.has(raw[start]) || /\s/.test(raw[start]))) start += 1;
  while (end > start && (wrapperChars.has(raw[end - 1]) || /\s/.test(raw[end - 1]))) end -= 1;
  // Prefixed so Beleidskompas conversations are visually grouped in
  // LibreChat's conversation-list sidebar, alongside other endpoints/agents.
  const title = TITLE_PREFIX + (raw.slice(start, end) || buildFallbackTitle(request.title_source));
  return { ok: true, step_id: null, mode: 'title', case_id: request.case_id, user_id: request.user_id, answer: title, text: title };
}

/** The answer to a request, from what the orchestrator agent returned.
 *  `text` is its message for the chat. `step_id` is the step whose agent it
 *  called first and `tools` every tool it called. `context` is what
 *  buildContext returned. When the agent failed or said nothing, the result
 *  is `ok: false` with a message for the chat. */
function buildAnswer({ context, agent, now }) {
  const tools = toolCalls(agent);
  const error = nodeError(agent);
  const text = error ? '' : String((agent && agent.output) || '').trim();
  const called = tools.map((t) => /^stap(\d+)_agent$/.exec(String(t.tool || ''))).find(Boolean);

  const base = {
    case_id: context.case_id,
    user_id: context.user_id,
    mode: context.kind === 'report' ? 'report' : 'conversation',
    step_id: called ? `stap${called[1]}` : null,
    asked_from: context.substep_id || null,
    tools,
    duration_ms: now - context.started_at,
  };
  if (!text) return { ...base, ok: false, error: error || 'The orchestrator returned no text', text: NO_ANSWER_TEXT, answer: NO_ANSWER_TEXT };
  return { ...base, ok: true, text, answer: text };
}

/** The answer as it goes back, after the turn of the orchestrator was
 *  written to the store: with a warning in front when that failed. */
function finishAnswer({ answer, saveError }) {
  if (!saveError) return answer;
  const text = `${STORE_WARNING_TEXT}\n\n${answer.text}`;
  return { ...answer, text, answer: text, store_error: `assistant_turn: ${saveError}` };
}

module.exports = {
  UNKNOWN_STEP_TEXT,
  STORE_MISSING_TEXT,
  STORE_FAILED_TEXT,
  STORE_WARNING_TEXT,
  NO_ANSWER_TEXT,
  TITLE_SYSTEM_PROMPT,
  MAX_TURNS,
  incomingMessage,
  stepToolName,
  buildOrchestratorPrompt,
  prepareRequest,
  buildContext,
  buildTitle,
  buildAnswer,
  finishAnswer,
};
