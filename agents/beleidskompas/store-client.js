'use strict';

/**
 * The orchestrator's client of the Beleidskompas store: the HTTP endpoints
 * of the admin service that keep the state of a case (see
 * services/admin-overlay/admin/lib/beleidskompas/routes.js).
 *
 * Every call carries the store token and names the user the case belongs
 * to. A call never throws: the store must not break the conversation, so a
 * failure comes back as `{ ok: false, error }` and the orchestrator reports
 * it in its own answer. Without BELEIDSKOMPAS_STORE_URL or the token the
 * client is disabled and every call answers `{ ok: false, error:
 * 'Store disabled' }` without sending anything.
 *
 * generate-workflow.js copies these functions into the Code node of the
 * orchestrator workflow, so the code that runs in n8n is this code.
 */

const { requestRaw } = require('./shared');

/** One request to the store. `query` becomes the query string, `body` is
 *  sent as JSON. Resolves to { ok, status, payload } or { ok: false, error }. */
async function storeRequest({ baseUrl, token, method, path, query, body, timeoutMs, fetchImpl, httpModule, httpsModule, urlModule }) {
  const params = Object.entries(query || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  const url = String(baseUrl || '').replace(/\/$/, '') + path + (params ? `?${params}` : '');
  const hasFetch = typeof fetchImpl === 'function';
  const controller = hasFetch && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await requestRaw(
      url,
      {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller ? controller.signal : undefined,
      },
      hasFetch,
      fetchImpl,
      httpModule,
      httpsModule,
      urlModule,
    );
  } catch (err) {
    return { ok: false, status: 0, error: `Store unreachable (${String((err && err.message) || err)})` };
  } finally {
    if (timer) clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = JSON.parse(res.text || '');
  } catch (_) {
    payload = null;
  }
  if (!res.ok) {
    const message = payload && payload.error ? payload.error : `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: `Store ${method} ${path}: ${message}` };
  }
  return { ok: true, status: res.status, payload };
}

/** The store as functions. `env` gives BELEIDSKOMPAS_STORE_URL and
 *  BELEIDSKOMPAS_STORE_TOKEN; the rest are the means to send HTTP. */
function createStoreClient({ env, fetchImpl, httpModule, httpsModule, urlModule }) {
  const baseUrl = String((env && env.BELEIDSKOMPAS_STORE_URL) || '').trim();
  const token = String((env && env.BELEIDSKOMPAS_STORE_TOKEN) || '').trim();
  const enabled = Boolean(baseUrl && token);
  const disabled = () => Promise.resolve({ ok: false, status: 0, error: 'Store disabled' });

  const send = (method, path, { query, body } = {}) =>
    enabled
      ? storeRequest({ baseUrl, token, method, path, query, body, timeoutMs: 10000, fetchImpl, httpModule, httpsModule, urlModule })
      : disabled();

  const casePath = (caseId) => `/api/beleidskompas/cases/${encodeURIComponent(String(caseId))}`;

  return {
    enabled,
    setCaseText: ({ caseId, userId, text }) => send('PUT', `${casePath(caseId)}/text`, { body: { user_id: userId, text } }),
    setTitle: ({ caseId, userId, title }) => send('PUT', `${casePath(caseId)}/title`, { body: { user_id: userId, title } }),
    addReport: ({ caseId, userId, substepId, text, citations, retrievalTrace }) =>
      send('POST', `${casePath(caseId)}/reports`, {
        body: { user_id: userId, substep_id: substepId, text, citations, retrieval_trace: retrievalTrace },
      }),
    addTurn: ({ caseId, userId, role, stepId, askedFrom, text }) =>
      send('POST', `${casePath(caseId)}/turns`, { body: { user_id: userId, role, step_id: stepId, asked_from: askedFrom, text } }),
    getState: ({ caseId, userId, maxTurns }) => send('GET', casePath(caseId), { query: { user_id: userId, max_turns: maxTurns } }),
  };
}

module.exports = { storeRequest, createStoreClient };
