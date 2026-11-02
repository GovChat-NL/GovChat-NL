'use strict';

/**
 * The Beleidskompas main agent (the "hoofdagent" workflow in n8n).
 *
 * Every chat message for the Beleidskompas endpoint arrives here first,
 * through the n8n-openai-bridge. The main agent does not answer anything
 * about a case itself: it checks the caller's token, reads which step the
 * message is for and forwards the message to that step's workflow, whose
 * answer it returns unchanged. A message that names no known step is refused
 * with a message for the chat, never sent to a default step. The one request
 * it does answer itself is LibreChat's request for a conversation title,
 * which belongs to no step.
 *
 * generate-workflow.js copies these functions, plus the two borrowed from
 * logic.js, into the Code node of beleidskompas-hoofdagent.json, so the
 * code that runs in n8n is this code.
 */

// Borrowed from step 1: reading the token from the request headers, sending
// an HTTP request, and recognising and answering LibreChat's title request.
const { extractSuppliedToken, requestRaw, isTitleRequest, buildTitleResponse } = require('./logic');

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

/** Reads the step id from the first line of a message.
 *
 *  The Beleidskompas page starts every message with a line like
 *  "Stap: stap2 (Rolbepaling provincie)". Only that first line counts: the
 *  earlier findings quoted further down in the message mention steps too.
 *  Returns '' when the first line is not such a line. */
function parseStepFromMessage(text) {
  const firstLine =
    String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || '';
  const match = /^Stap:\s*([A-Za-z0-9_-]+)/i.exec(firstLine);
  return match ? match[1].toLowerCase() : '';
}

/** Returns the id of the step a request is for, or '' when the message
 *  names no step that is in `routes`. The bridge delivers the message in
 *  `currentMessage` and `chatInput`; `question` is what direct webhook
 *  calls use. */
function determineStep(body, routes) {
  const b = body && typeof body === 'object' ? body : {};
  const stepId = parseStepFromMessage(b.currentMessage || b.chatInput || b.question || '');
  return Object.prototype.hasOwnProperty.call(routes, stepId) ? stepId : '';
}

/** Sends the request on to a step workflow and returns that step's answer.
 *
 *  Takes everything it needs as named arguments: the n8n address
 *  (`baseUrl`) and the step's webhook path, the request `body` to pass on
 *  unchanged, the caller's own token (so the step still checks it itself),
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
 *  the token, answer a title request, read the step from the message,
 *  forward to that step. The returned object is what the workflow responds
 *  with. */
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
  const message = String(body.currentMessage || body.chatInput || body.question || '');
  if (isTitleRequest(message) || isTitleRequest(String(body.systemPrompt || ''))) {
    const title = await buildTitleResponse({ titleSource: message, env, fetchImpl, httpModule, httpsModule, urlModule });
    return Object.assign({}, title, { step_id: null });
  }

  const stepId = determineStep(body, STEP_ROUTES);
  if (!stepId) {
    return { ok: false, step_id: null, error: 'No step recognised in the request', text: UNKNOWN_STEP_TEXT, answer: UNKNOWN_STEP_TEXT };
  }

  return forwardToStep({
    baseUrl: env && env.BELEIDSKOMPAS_N8N_BASE_URL,
    path: STEP_ROUTES[stepId],
    stepId,
    body,
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
  parseStepFromMessage,
  determineStep,
  forwardToStep,
  runMainAgent,
};
