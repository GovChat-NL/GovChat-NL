'use strict';

/**
 * The Beleidskompas main agent (the "hoofdagent" workflow in n8n).
 *
 * Every chat message for the Beleidskompas endpoint arrives here first,
 * through the n8n-openai-bridge. The main agent does not answer anything
 * about a case itself: it checks the caller's token, takes the message apart
 * into the parts the page composed it from (step or substep, case, findings
 * so far, conversation, message)
 * and sends those as fields to that step's workflow, whose answer
 * it returns unchanged. A message that names no known step is refused with a
 * message for the chat, never sent to a default step. The one request it does
 * answer itself is LibreChat's request for a conversation title, which
 * belongs to no step.
 *
 * generate-workflow.js copies these functions, with the ones they use from
 * shared.js, into the Code node of beleidskompas-hoofdagent.json, so the
 * code that runs in n8n is this code.
 */

const { extractSuppliedToken, parsePageMessage, requestRaw, isTitleRequest, extractConvoCaseText, buildTitleResponse } = require('./shared');

// Which step id belongs to which webhook path in n8n. The paths are the
// addresses of the four step workflows.
const STEP_ROUTES = {
  stap1: 'beleidskompas-step-stap1',
  stap2: 'beleidskompas-step-stap2',
  stap3: 'beleidskompas-step-stap3',
  stap4: 'beleidskompas-step-stap4',
};

// Shown in the chat when a message names no known step.
const UNKNOWN_STEP_TEXT =
  'Beleidskompas kon niet bepalen voor welke stap dit bericht is en heeft het daarom niet beantwoord. ' +
  'Stel je vraag opnieuw vanaf de Beleidskompas-pagina, met een stap gekozen.';

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

/** What a step workflow receives: the parts of the message as fields, plus
 *  who is asking. */
function buildStepRequest(stepId, parts, body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    step_id: stepId,
    substep_id: parts.substepId || null,
    case_text: parts.caseText,
    findings: parts.findings,
    conversation: parts.conversation,
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

/** What the Code node of the hoofdagent workflow runs, from start to end.
 *
 *  `input` is the incoming request as n8n hands it over (`$json`: the
 *  request's `body` and `headers`), `env` holds the settings read from
 *  n8n's `$env`, and the rest are the means to send HTTP. In order: check
 *  the token, answer a title request, take the message apart and read the
 *  step from it, send the parts to that step. The returned object is what
 *  the workflow responds with. */
async function runMainAgent(ctx) {
  const { input, env, fetchImpl, httpModule, httpsModule, urlModule } = ctx;
  const raw = input || {};
  const body = raw.body || {};
  const headers = raw.headers || {};

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
    // The title is made from the case itself, not from the labels around it.
    const caseText = parsePageMessage(extractConvoCaseText(message)).caseText;
    return buildTitleResponse({ titleSource: caseText || message, env, fetchImpl, httpModule, httpsModule, urlModule });
  }

  const parts = parsePageMessage(message);
  const stepId = determineStep(parts, STEP_ROUTES);
  if (!stepId) {
    return { ok: false, step_id: null, error: 'No step recognised in the request', text: UNKNOWN_STEP_TEXT, answer: UNKNOWN_STEP_TEXT };
  }

  return forwardToStep({
    baseUrl: env && env.BELEIDSKOMPAS_N8N_BASE_URL,
    path: STEP_ROUTES[stepId],
    stepId,
    body: buildStepRequest(stepId, parts, body),
    callerToken,
    timeoutMs: 120000,
    fetchImpl,
    httpModule,
    httpsModule,
    urlModule,
  });
}

module.exports = {
  STEP_ROUTES,
  UNKNOWN_STEP_TEXT,
  incomingMessage,
  determineStep,
  buildStepRequest,
  forwardToStep,
  runMainAgent,
};
