'use strict';

/**
 * The Beleidskompas orchestrator (the "orchestrator" workflow in n8n).
 *
 * Every chat message for the Beleidskompas endpoint arrives here first,
 * through the n8n-openai-bridge. The orchestrator does not answer anything
 * about a case itself: it checks the caller's token, takes the message apart
 * into the parts the page composed it from (step or substep, case, findings
 * so far, conversation, message) and sends those as fields to a step's
 * workflow, whose answer it returns unchanged. A request for a report goes
 * to the step of the substep the page named. A typed message goes to the
 * step the message is about: the orchestrator asks the model to pick one
 * (see chooseStep), and keeps the page's step when the model does not pick
 * another. A message typed in LibreChat's own chat has no labels at all;
 * that is a question too, with step 1 as the step to keep. A message with
 * labels that names no known step is refused with a message for the chat.
 * The one request it does answer itself is LibreChat's request for a
 * conversation title, which belongs to no step.
 *
 * The orchestrator is also the one that writes to the Beleidskompas store
 * (see store-client.js): the case text, the turns of the conversation, a
 * report and the title. It sees everything that is needed for that: the
 * conversation and the user from the bridge, what the page sent and what
 * the step answered. The steps know nothing of the store. A write that
 * fails never breaks the conversation; it is reported in the `store` field
 * of the answer, which n8n keeps with the execution.
 *
 * generate-workflow.js copies these functions, with the ones they use from
 * shared.js, into the Code node of beleidskompas-orchestrator.json, so the
 * code that runs in n8n is this code.
 */

const { ORCHESTRATOR_PROMPT_TEMPLATE, extractSuppliedToken, parsePageMessage, requestRaw, callLiteLLM, isTitleRequest, extractConvoCaseText, buildTitleResponse } = require('./shared');
const { createStoreClient } = require('./store-client');

// Which step id belongs to which webhook path in n8n. The paths are the
// addresses of the four step workflows.
const STEP_ROUTES = {
  stap1: 'beleidskompas-step-stap1',
  stap2: 'beleidskompas-step-stap2',
  stap3: 'beleidskompas-step-stap3',
  stap4: 'beleidskompas-step-stap4',
};

// The step a question from LibreChat's own chat is about when the model
// picks no other: there is no page to say where the user is.
const DEFAULT_STEP_ID = 'stap1';

// Shown in the chat when a message names no known step.
const UNKNOWN_STEP_TEXT =
  'Beleidskompas kon niet bepalen voor welke stap dit bericht is en heeft het daarom niet beantwoord. ' +
  'Stel je vraag opnieuw vanaf de Beleidskompas-pagina, met een stap gekozen.';

// Shown in the chat when the store cannot be used. The store is where a
// step gets the case, the earlier reports and the conversation from, and
// where the answer is kept. Without it a step would answer as if the case
// were new and the answer would be lost, while the user sees a normal
// answer. So the user is told instead.
const STORE_MISSING_TEXT =
  'Beleidskompas kan zijn opslag niet gebruiken en heeft dit bericht daarom niet beantwoord. Meld dit bij de beheerder.';
const STORE_FAILED_TEXT = 'De opslag van Beleidskompas gaf een fout. Dit bericht is daarom niet beantwoord; probeer het later opnieuw.';
const STORE_WARNING_TEXT = 'Let op: de opslag van Beleidskompas gaf een fout. Dit antwoord is mogelijk niet bewaard.';

/** The text of the incoming message: the bridge delivers it in
 *  `currentMessage` and `chatInput`, direct webhook calls in `question`. */
function incomingMessage(body) {
  const b = body && typeof body === 'object' ? body : {};
  return String(b.currentMessage || b.chatInput || b.question || '');
}

/** Returns the id of the step a message is for, or '' when it names no step
 *  that is in `routes`. */
function determineStep(parts, routes) {
  const stepId = String((parts && parts.stepId) || '');
  return Object.prototype.hasOwnProperty.call(routes, stepId) ? stepId : '';
}

/** Asks the model which step a typed message is about, and returns that
 *  step's id. `summaries` describes the steps the model can choose from
 *  (see stepSummary in generate-workflow.js): id, number, title, role and
 *  substep titles. The model answers with a number only. When it names no
 *  step in `routes`, cannot be reached, or is not configured, the answer is
 *  `activeStepId`, the step the user is in: a wrong guess would send the
 *  message to a step it is not about. */
async function chooseStep({ message, activeStepId, summaries, routes, env, fetchImpl, httpModule, httpsModule, urlModule }) {
  const steps = Array.isArray(summaries) ? summaries : [];
  const litellmUrl = String((env && env.LITELLM_URL) || '').trim();
  const litellmApiKey = String((env && (env.LITELLM_API_KEY || env.OPENAI_API_KEY)) || '').trim();
  const active = steps.find((s) => s.id === activeStepId);
  if (!litellmUrl || !litellmApiKey || !active || !String(message || '').trim()) return activeStepId;

  const list = steps
    .map((s) => `${s.nr}. ${s.title}. ${String(s.role || '').trim()} Deelstappen: ${(s.substeps || []).join(', ')}.`)
    .join('\n');
  const systemPrompt = ORCHESTRATOR_PROMPT_TEMPLATE.replaceAll('{{steps}}', list).replaceAll('{{active_nr}}', String(active.nr));

  let raw;
  try {
    raw = await callLiteLLM({
      baseUrl: litellmUrl,
      apiKey: litellmApiKey,
      model: (env && env.BELEIDSKOMPAS_MODEL) || 'govchat-default',
      systemPrompt,
      userPrompt: String(message).slice(0, 4000),
      timeoutMs: 20000,
      fetchImpl,
      httpModule,
      httpsModule,
      urlModule,
    });
  } catch (_) {
    return activeStepId;
  }
  const number = /\d+/.exec(String(raw || ''));
  const chosen = number && steps.find((s) => String(s.nr) === number[0]);
  return chosen && Object.prototype.hasOwnProperty.call(routes || {}, chosen.id) ? chosen.id : activeStepId;
}

/** What a step gets to work with, from the state of the case in the store:
 *  the newest case text, the newest report per substep as one text, and
 *  the conversation. For a typed message every report goes along, so a step
 *  answering from a later step knows what was worked out there. For a
 *  report only the reports up to and including the substep go along, the
 *  way the page did it: a report builds on what came before. The
 *  conversation is the last turns of the whole case, in the form the steps
 *  know ("Gebruiker: ..." and "Beleidskompas: ..."). `summaries` gives the
 *  order of the substeps. */
function contextFromState(state, { substepId, forReport, summaries }) {
  const order = (Array.isArray(summaries) ? summaries : []).flatMap((s) => s.substep_ids || []);
  const reports = (state && state.reports) || {};
  let ids = Object.keys(reports).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (forReport && substepId) {
    const upTo = order.indexOf(substepId);
    ids = ids.filter((id) => upTo === -1 || order.indexOf(id) <= upTo);
  }
  const findings = ids
    .map((id) => String(reports[id].text || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const conversation = ((state && state.turns) || [])
    .map((t) => `${t.role === 'user' ? 'Gebruiker' : 'Beleidskompas'}: ${String(t.text || '').trim()}`)
    .join('\n');
  return {
    caseText: String((state && state.case_text && state.case_text.text) || '').trim(),
    findings,
    conversation,
  };
}

/** What a step workflow receives: the parts of the message as fields, the
 *  reports and the conversation from the store (`findings` and
 *  `conversation`, see contextFromState), plus who is asking. The substep
 *  only goes along when it belongs to `stepId`; a message sent to another
 *  step is about that whole step. `asked_from` always says which substep
 *  the user was in. */
function buildStepRequest(stepId, parts, body) {
  const b = body && typeof body === 'object' ? body : {};
  const ownSubstep = stepId === parts.stepId ? parts.substepId || null : null;
  return {
    step_id: stepId,
    substep_id: ownSubstep,
    asked_from: parts.substepId || null,
    case_text: parts.caseText,
    findings: parts.findings || '',
    conversation: parts.conversation || '',
    message: parts.message,
    sessionId: b.sessionId || null,
    userId: b.userId || null,
  };
}

/** Sends a request to a step workflow and returns that step's answer.
 *
 *  Takes everything it needs as named arguments: the n8n address
 *  (`baseUrl`) and the step's webhook path, the request `body` to send (see
 *  buildStepRequest), the caller's own token (so the step still checks it itself),
 *  and the means to send HTTP (`fetchImpl`, or the http/https/url modules
 *  when fetch is not available). The answer always has `text` (what the
 *  chat pipeline reads) and `answer` (what direct callers read); when a step
 *  fills only one of them, the other is copied from it. When the step cannot
 *  be reached or answers with an error or something that is not JSON, the
 *  result is `ok: false` with a message for the chat in `text`. */
async function forwardToStep({ baseUrl, path, stepId, body, callerToken, timeoutMs, fetchImpl, httpModule, httpsModule, urlModule }) {
  const url = String(baseUrl || 'http://n8n:5678').replace(/\/$/, '') + '/webhook/' + path;
  const hasFetch = typeof fetchImpl === 'function';
  const controller = hasFetch && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await requestRaw(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-govchat-token': String(callerToken || '') },
        body: JSON.stringify(body || {}),
        signal: controller ? controller.signal : undefined,
      },
      hasFetch,
      fetchImpl,
      httpModule,
      httpsModule,
      urlModule,
    );
  } catch (err) {
    const text = `Beleidskompas kon de workflow van ${stepId} niet bereiken (${String((err && err.message) || err)}).`;
    return { ok: false, step_id: stepId, error: 'Step workflow unreachable', text, answer: text };
  } finally {
    if (timer) clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = JSON.parse(res.text || '');
  } catch (_) {
    payload = null;
  }
  if (!res.ok || !payload || typeof payload !== 'object') {
    const text = `Beleidskompas kreeg geen geldig antwoord van de workflow van ${stepId} (HTTP ${res.status}).`;
    return { ok: false, step_id: stepId, error: 'Step workflow HTTP ' + res.status, text, answer: text };
  }

  return Object.assign({}, payload, {
    text: String(payload.text || payload.answer || ''),
    answer: String(payload.answer || payload.text || ''),
  });
}

/** What the Code node of the orchestrator workflow runs, from start to end.
 *
 *  `input` is the incoming request as n8n hands it over (`$json`: the
 *  request's `body` and `headers`), `env` holds the settings read from
 *  n8n's `$env`, `summaries` describes the steps for chooseStep, and the
 *  rest are the means to send HTTP. In order: check the token, answer a
 *  title request, take the message apart and read the step from it, let
 *  the model pick the step a typed message is about, read the state of the
 *  case from the store, send the parts and the state to that step, keep
 *  the answer in the store. The returned object is what the workflow
 *  responds with. */
async function runOrchestrator(ctx) {
  const { input, env, summaries, fetchImpl, httpModule, httpsModule, urlModule } = ctx;
  const raw = input || {};
  const body = raw.body || {};
  const headers = raw.headers || {};

  // What this request writes to the store, and what went wrong doing so.
  // Nothing is written without the conversation and the user from the
  // bridge: without them there is no case to write to.
  const store = createStoreClient({ env, fetchImpl, httpModule, httpsModule, urlModule });
  const caseId = String(body.sessionId || '').trim();
  const userId = String(body.userId || '').trim();
  const stored = { enabled: store.enabled && Boolean(caseId && userId), written: [], errors: [] };
  async function write(name, call) {
    if (!stored.enabled) return;
    const result = await call();
    if (result.ok) stored.written.push(name);
    else stored.errors.push(`${name}: ${result.error}`);
  }

  // The same token check as in the step workflows. A wrong token gives a
  // normal answer with ok: false, not a thrown error: n8n can turn a thrown
  // error into an empty response, and then the caller sees nothing at all.
  const callerToken = extractSuppliedToken(headers);
  const expectedToken = String((env && (env.BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN || env.N8N_WEBHOOK_TOKEN)) || '').trim();
  if (expectedToken && callerToken !== expectedToken) {
    return { ok: false, step_id: null, error: 'Unauthorized webhook token', text: '', answer: '' };
  }

  // LibreChat asks for a conversation title through this same endpoint. That
  // request carries TITLE_REQUEST_MARKER (set in librechat.yaml), sometimes
  // in systemPrompt and sometimes in the message itself. It names no step,
  // so it is answered here with a title instead of being forwarded.
  const message = incomingMessage(body);
  if (isTitleRequest(message) || isTitleRequest(String(body.systemPrompt || ''))) {
    // The title is made from the case itself, not from the block the page
    // put behind it.
    const caseText = parsePageMessage(extractConvoCaseText(message)).caseText;
    const titled = await buildTitleResponse({ titleSource: caseText || message, env, fetchImpl, httpModule, httpsModule, urlModule });
    await write('title', () => store.setTitle({ caseId, userId, title: titled.answer }));
    return Object.assign({}, titled, { store: stored });
  }

  const parts = parsePageMessage(message);
  let activeStepId = determineStep(parts, STEP_ROUTES);
  // A message without the block of the page was typed in LibreChat's own
  // chat: it is a question, and there is no page to say where the user is.
  if (!activeStepId && !parts.fromPage) activeStepId = DEFAULT_STEP_ID;
  if (!activeStepId) {
    return { ok: false, step_id: null, error: 'No step recognised in the request', text: UNKNOWN_STEP_TEXT, answer: UNKNOWN_STEP_TEXT };
  }
  if (!stored.enabled) {
    const error = store.enabled ? 'No conversation or user from the bridge' : 'Store not configured';
    return { ok: false, step_id: null, error, text: STORE_MISSING_TEXT, answer: STORE_MISSING_TEXT, store: stored };
  }

  // A report is always written by the step of the substep the page named.
  // A typed message is answered by the step it is about.
  const stepId = parts.message
    ? await chooseStep({ message: parts.message, activeStepId, summaries, routes: STEP_ROUTES, env, fetchImpl, httpModule, httpsModule, urlModule })
    : activeStepId;

  // The case text goes to the store first, so the state read next has it.
  // The state gives the step the case text, the reports and the
  // conversation. Before the first answer the store does not know the case
  // yet (404); then the step gets only the case text the page sent.
  // The user's message is written after the state is read, so the
  // conversation the step gets does not already contain it. Writing before
  // the step answers keeps the message even when the step fails.
  if (parts.caseText) await write('case_text', () => store.setCaseText({ caseId, userId, text: parts.caseText }));
  let context = parts;
  stored.read = false;
  const state = await store.getState({ caseId, userId, maxTurns: 20 });
  if (state.ok && state.payload) {
    context = Object.assign({}, parts, contextFromState(state.payload, { substepId: parts.substepId, forReport: !parts.message, summaries }));
    stored.read = true;
  } else if (state.status !== 404) {
    stored.errors.push(`state: ${state.error}`);
  }
  if (parts.message) await write('user_turn', () => store.addTurn({ caseId, userId, role: 'user', askedFrom: parts.substepId || null, text: parts.message }));
  // An error so far means the step would answer without the state of the
  // case, or the user's message would not be kept. Then better no answer.
  if (stored.errors.length) {
    return { ok: false, step_id: null, error: stored.errors.join('; '), text: STORE_FAILED_TEXT, answer: STORE_FAILED_TEXT, store: stored };
  }

  const result = await forwardToStep({
    baseUrl: env && env.BELEIDSKOMPAS_N8N_BASE_URL,
    path: STEP_ROUTES[stepId],
    stepId,
    body: buildStepRequest(stepId, context, body),
    callerToken,
    timeoutMs: 120000,
    fetchImpl,
    httpModule,
    httpsModule,
    urlModule,
  });

  if (result.ok && result.mode === 'report') {
    const substepId = String(result.substep_id || parts.substepId || '').trim();
    if (substepId) {
      await write('report', () =>
        store.addReport({
          caseId,
          userId,
          substepId,
          text: result.answer,
          citations: result.citations,
          retrievalTrace: result.retrieval_trace,
        }),
      );
    } else {
      stored.errors.push('report: no substep to file the report under');
    }
  }
  if (result.ok && parts.message) {
    await write('assistant_turn', () => store.addTurn({ caseId, userId, role: 'assistant', stepId: result.step_id || stepId, askedFrom: parts.substepId || null, text: result.answer }));
  }

  // `text` carries the meta block behind the answer, so the warning goes
  // in front, in both.
  const warned = result.ok && stored.errors.length
    ? Object.assign({}, result, { answer: `${STORE_WARNING_TEXT}\n\n${result.answer}`, text: `${STORE_WARNING_TEXT}\n\n${result.text}` })
    : result;
  return Object.assign({}, warned, { store: stored });
}

module.exports = {
  STEP_ROUTES,
  DEFAULT_STEP_ID,
  UNKNOWN_STEP_TEXT,
  STORE_MISSING_TEXT,
  STORE_FAILED_TEXT,
  STORE_WARNING_TEXT,
  incomingMessage,
  determineStep,
  chooseStep,
  contextFromState,
  buildStepRequest,
  forwardToStep,
  runOrchestrator,
};
