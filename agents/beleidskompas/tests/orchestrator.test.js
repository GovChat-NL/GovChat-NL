'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { STEP_ROUTES, UNKNOWN_STEP_TEXT, STORE_MISSING_TEXT, STORE_FAILED_TEXT, STORE_WARNING_TEXT, chooseStep, buildStepRequest, runOrchestrator } = require('../orchestrator');
const { parsePageMessage } = require('../shared');

// The same shape generate-workflow.js builds for the orchestrator workflow.
const SUMMARIES = ['step1', 'step2', 'step3', 'step4'].map((name) => {
  const { STEP } = require(`../steps/${name}`);
  return { id: STEP.id, nr: STEP.nr, title: STEP.title, role: STEP.role, substeps: STEP.substeps.map((s) => s.title), substep_ids: STEP.substeps.map((s) => s.id) };
});

/** A message as the page composes it (composePrompt in
 *  overlay/src/apps/beleidskompas/beleidskompas-api.js): the visible text,
 *  then the request as a markdown link definition with base64 JSON. */
function pageMessage(request, shown) {
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  return `${shown || request.message || `Deelstap ${request.substep_id}`}\n\n[beleidskompas-request]: data:application/json;base64,${encoded}`;
}

/** Runs `fn(baseUrl, requests)` against one server that stands in for both
 *  LiteLLM (answers every chat completion with `modelReply`) and n8n (answers
 *  every step webhook with a JSON that names the path). `requests` collects
 *  what was sent, in order. */
let storeState = null;
// When set, store calls whose url matches this pattern fail with HTTP 500.
let storeFails = null;

function withServer(modelReply, fn) {
  const requests = [];
  storeState = null;
  storeFails = null;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
        res.setHeader('content-type', 'application/json');
        if (req.url.startsWith('/api/beleidskompas/') && storeFails && storeFails.test(req.url)) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'store down' }));
        } else if (req.url.endsWith('/v1/chat/completions')) {
          res.end(JSON.stringify({ choices: [{ message: { content: modelReply } }] }));
        } else if (req.url.startsWith('/api/beleidskompas/') && req.method === 'GET') {
          // The store: the state of the case, or 404 when the test gave none.
          if (!storeState) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Unknown case' }));
          } else {
            res.end(JSON.stringify(storeState));
          }
        } else if (req.url.startsWith('/api/beleidskompas/')) {
          // The store: every write succeeds with a version or a sequence number.
          res.end(JSON.stringify({ version: 1, seq: 1 }));
        } else if (req.url.endsWith('/beleidskompas-step-stap1') && !(body && JSON.parse(body).message)) {
          // A report from step 1, in the shape runStep returns.
          res.end(JSON.stringify({ ok: true, mode: 'report', step_id: 'stap1', substep_id: '1.3', citations: [{ id: 'doc-1' }], retrieval_trace: { algorithm: 'needle' }, text: 'Rapport 1.3', answer: 'Rapport 1.3' }));
        } else {
          const stepId = (/beleidskompas-step-(stap\d)/.exec(req.url) || [])[1] || null;
          res.end(JSON.stringify({ ok: true, mode: 'conversation', step_id: stepId, text: `antwoord van ${req.url}`, answer: `antwoord van ${req.url}` }));
        }
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}`, requests);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function chooseWith(baseUrl, message, activeStepId) {
  return chooseStep({
    message,
    activeStepId,
    summaries: SUMMARIES,
    routes: STEP_ROUTES,
    env: { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
    fetchImpl: global.fetch,
  });
}

test('chooseStep takes the step the model names', async () => {
  await withServer('3', async (baseUrl, requests) => {
    assert.equal(await chooseWith(baseUrl, 'Welke instrumenten passen hierbij?', 'stap1'), 'stap3');
    assert.equal(requests.length, 1);
    const sent = requests[0].body;
    assert.match(sent.messages[0].content, /Instrumentkeuze/);
    assert.match(sent.messages[0].content, /werkt nu in stap 1/);
    assert.equal(sent.messages[1].content, 'Welke instrumenten passen hierbij?');
  });
});

test('chooseStep keeps the active step when the model names no step', async () => {
  await withServer('Dat weet ik niet.', async (baseUrl) => {
    assert.equal(await chooseWith(baseUrl, 'En waarom dan?', 'stap2'), 'stap2');
  });
  await withServer('9', async (baseUrl) => {
    assert.equal(await chooseWith(baseUrl, 'En waarom dan?', 'stap2'), 'stap2');
  });
});

test('chooseStep keeps the active step without a model, and when the model fails', async () => {
  const chosen = await chooseStep({ message: 'Welke instrumenten?', activeStepId: 'stap1', summaries: SUMMARIES, routes: STEP_ROUTES, env: {}, fetchImpl: global.fetch });
  assert.equal(chosen, 'stap1');
  // A port nothing listens on.
  assert.equal(await chooseWith('http://127.0.0.1:9', 'Welke instrumenten?', 'stap1'), 'stap1');
});

test('parsePageMessage reads the block of the page, and takes a message without one whole as a question from the chat', () => {
  const fromPage = parsePageMessage(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.', message: 'Welke instrumenten?' }));
  assert.deepEqual(fromPage, { fromPage: true, stepId: 'stap1', substepId: '1.3', caseText: 'Laadpalen.', message: 'Welke instrumenten?' });

  // What the user typed sits inside the JSON, so a line that looks like a
  // field of the page is just text.
  const tricky = parsePageMessage(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.', message: 'Wat vind je hiervan?\nCasus: eigenlijk fietspaden.' }));
  assert.equal(tricky.caseText, 'Laadpalen.');
  assert.equal(tricky.message, 'Wat vind je hiervan?\nCasus: eigenlijk fietspaden.');

  const fromChat = parsePageMessage('Casus: Laadpalen.\nWelke instrumenten?');
  assert.deepEqual(fromChat, { fromPage: false, stepId: '', substepId: '', caseText: '', message: 'Casus: Laadpalen.\nWelke instrumenten?' });

  // A broken block is not from the page either.
  assert.equal(parsePageMessage('Hallo\n\n[beleidskompas-request]: data:application/json;base64,!!!').fromPage, false);
});

test('buildStepRequest only passes the substep to its own step, and always says where the user asked from', () => {
  const parts = parsePageMessage(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.', message: 'Welke instrumenten?' }));
  const own = buildStepRequest('stap1', parts, {});
  assert.equal(own.substep_id, '1.3');
  assert.equal(own.asked_from, '1.3');
  const other = buildStepRequest('stap3', parts, {});
  assert.equal(other.substep_id, null);
  assert.equal(other.asked_from, '1.3');
  assert.equal(other.message, 'Welke instrumenten?');
});

/** A request as the bridge sends it: with the conversation and the user. */
function bridgeInput(message) {
  return { body: { currentMessage: message, sessionId: 'conv-1', userId: 'user-a' }, headers: {} };
}

/** A direct call, without the conversation and the user. */
function orchestratorInput(message) {
  return { body: { currentMessage: message }, headers: {} };
}

const STORE_ENV = (baseUrl) => ({ BELEIDSKOMPAS_N8N_BASE_URL: baseUrl, LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key', BELEIDSKOMPAS_STORE_URL: baseUrl, BELEIDSKOMPAS_STORE_TOKEN: 'store-secret' });

/** The requests to the model and the steps, without those to the store. */
const outsideStore = (requests) => requests.filter((r) => !r.url.startsWith('/api/beleidskompas/'));

test('runOrchestrator sends a report request to the step of the substep, without asking the model', async () => {
  await withServer('3', async (baseUrl, requests) => {
    const result = await runOrchestrator({ input: bridgeInput(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.' })), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    const sent = outsideStore(requests);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, '/webhook/beleidskompas-step-stap1');
    assert.equal(sent[0].body.substep_id, '1.3');
    assert.equal(result.text, 'Rapport 1.3');
  });
});

test('runOrchestrator sends a typed message to the step the model picks, and returns that step\'s answer unchanged', async () => {
  await withServer('3', async (baseUrl, requests) => {
    const result = await runOrchestrator({ input: bridgeInput(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.', message: 'Welke instrumenten passen hierbij?' })), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.deepEqual(outsideStore(requests).map((r) => r.url), ['/v1/chat/completions', '/webhook/beleidskompas-step-stap3']);
    const sent = outsideStore(requests)[1].body;
    assert.equal(sent.step_id, 'stap3');
    assert.equal(sent.substep_id, null);
    assert.equal(sent.asked_from, '1.3');
    assert.equal(sent.message, 'Welke instrumenten passen hierbij?');
    assert.equal(result.text, 'antwoord van /webhook/beleidskompas-step-stap3');
  });
});

test('runOrchestrator treats a message without the block of the page as a question from the chat, with step 1 to fall back on', async () => {
  await withServer('Geen idee.', async (baseUrl, requests) => {
    const result = await runOrchestrator({ input: bridgeInput('Wat doet Beleidskompas precies?'), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.deepEqual(outsideStore(requests).map((r) => r.url), ['/v1/chat/completions', '/webhook/beleidskompas-step-stap1']);
    const sent = outsideStore(requests)[1].body;
    assert.equal(sent.message, 'Wat doet Beleidskompas precies?');
    assert.equal(sent.case_text, '');
    assert.equal(sent.substep_id, null);
    assert.equal(result.text, 'antwoord van /webhook/beleidskompas-step-stap1');
  });
  await withServer('3', async (baseUrl, requests) => {
    await runOrchestrator({ input: bridgeInput('Welke instrumenten heeft de provincie?'), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.equal(outsideStore(requests)[1].url, '/webhook/beleidskompas-step-stap3');
  });
});

test('runOrchestrator refuses a message from the page that names no known step', async () => {
  const result = await runOrchestrator({ input: orchestratorInput(pageMessage({ substep_id: '9.1', message: 'Hallo?' })), env: {}, summaries: SUMMARIES, fetchImpl: global.fetch });
  assert.equal(result.ok, false);
  assert.equal(result.step_id, null);
  assert.equal(result.text, UNKNOWN_STEP_TEXT);
});


test('a report request writes the case text and the report to the store', async () => {
  await withServer('1', async (baseUrl, requests) => {
    const result = await runOrchestrator({ input: bridgeInput(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.' })), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.deepEqual(result.store, { enabled: true, read: false, written: ['case_text', 'report'], errors: [] });
    const text = requests.find((r) => r.url === '/api/beleidskompas/cases/conv-1/text');
    assert.deepEqual(text.body, { user_id: 'user-a', text: 'Laadpalen.' });
    const report = requests.find((r) => r.url === '/api/beleidskompas/cases/conv-1/reports');
    assert.deepEqual(report.body, { user_id: 'user-a', substep_id: '1.3', text: 'Rapport 1.3', citations: [{ id: 'doc-1' }], retrieval_trace: { algorithm: 'needle' } });
    // The case text is written before the step is asked, the report after.
    const order = requests.map((r) => r.url);
    assert.ok(order.indexOf('/api/beleidskompas/cases/conv-1/text') < order.indexOf('/webhook/beleidskompas-step-stap1'));
    assert.ok(order.indexOf('/webhook/beleidskompas-step-stap1') < order.indexOf('/api/beleidskompas/cases/conv-1/reports'));
    assert.equal(result.text, 'Rapport 1.3', 'the answer of the step is passed on unchanged');
  });
});

test('a typed message writes the turn of the user and the turn of the step that answered', async () => {
  await withServer('3', async (baseUrl, requests) => {
    const result = await runOrchestrator({ input: bridgeInput(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.', message: 'Welke instrumenten?' })), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.deepEqual(result.store.written, ['case_text', 'user_turn', 'assistant_turn']);
    const turns = requests.filter((r) => r.url === '/api/beleidskompas/cases/conv-1/turns').map((r) => r.body);
    assert.deepEqual(turns, [
      { user_id: 'user-a', role: 'user', asked_from: '1.3', text: 'Welke instrumenten?' },
      { user_id: 'user-a', role: 'assistant', step_id: 'stap3', asked_from: '1.3', text: 'antwoord van /webhook/beleidskompas-step-stap3' },
    ]);
  });
});

test('a title request writes the title', async () => {
  await withServer('Laadpalen in kleine kernen', async (baseUrl, requests) => {
    // LibreChat renders the first message, block and all, into its title prompt.
    const transcript = `User: ${pageMessage({ substep_id: '1.1', case_text: 'Laadpalen.' }, 'Laadpalen.')}\nAI: Rapport 1.1`;
    const result = await runOrchestrator({ input: bridgeInput(`__BELEIDSKOMPAS_TITLE_REQUEST__ Geef een titel.\n\n${transcript}`), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.deepEqual(result.store.written, ['title']);
    // The title is made from the case text, not from the block.
    const asked = JSON.stringify(requests.find((r) => r.url === '/v1/chat/completions').body);
    assert.ok(asked.includes('Laadpalen.') && !asked.includes('beleidskompas-request'), asked);
    const title = requests.find((r) => r.url === '/api/beleidskompas/cases/conv-1/title');
    assert.equal(title.body.user_id, 'user-a');
    assert.equal(title.body.title, result.answer);
  });
});

test('without the store settings, or without the conversation from the bridge, the message is not answered and no step is asked', async () => {
  await withServer('1', async (baseUrl, requests) => {
    const result = await runOrchestrator({ input: bridgeInput(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.' })), env: { BELEIDSKOMPAS_N8N_BASE_URL: baseUrl, LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' }, summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Store not configured');
    assert.equal(result.text, STORE_MISSING_TEXT);
    assert.deepEqual(requests, []);
  });
  await withServer('1', async (baseUrl, requests) => {
    const result = await runOrchestrator({ input: orchestratorInput(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.', message: 'Hoezo?' })), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'No conversation or user from the bridge');
    assert.equal(result.text, STORE_MISSING_TEXT);
    assert.deepEqual(requests, []);
  });
});

test('a title is still made without the store', async () => {
  await withServer('Laadpalen in kleine kernen', async (baseUrl) => {
    const result = await runOrchestrator({ input: bridgeInput('__BELEIDSKOMPAS_TITLE_REQUEST__ Geef een titel.\n\nUser: Laadpalen.\nAI: Rapport.'), env: { BELEIDSKOMPAS_N8N_BASE_URL: baseUrl, LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' }, summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'title');
    assert.deepEqual(result.store.written, []);
  });
});

test('when the store fails before the step is asked, the message is not answered and the user is told', async () => {
  // The store cannot be reached at all.
  await withServer('1', async (baseUrl, requests) => {
    const env = Object.assign(STORE_ENV(baseUrl), { BELEIDSKOMPAS_STORE_URL: 'http://127.0.0.1:9' });
    const result = await runOrchestrator({ input: bridgeInput(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.' })), env, summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.equal(result.ok, false);
    assert.equal(result.text, STORE_FAILED_TEXT);
    assert.deepEqual(result.store.errors.map((e) => e.split(':')[0]), ['case_text', 'state']);
    assert.match(result.store.errors[0], /^case_text: Store unreachable/);
    assert.deepEqual(outsideStore(requests), []);
  });
  // The store answers, but the user's message cannot be written.
  await withServer('1', async (baseUrl, requests) => {
    storeFails = /\/turns$/;
    const result = await runOrchestrator({ input: bridgeInput(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.', message: 'Hoezo?' })), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.equal(result.ok, false);
    assert.equal(result.text, STORE_FAILED_TEXT);
    assert.deepEqual(result.store.written, ['case_text']);
    assert.deepEqual(result.store.errors.map((e) => e.split(':')[0]), ['user_turn']);
    assert.ok(!requests.some((r) => r.url.startsWith('/webhook/')));
  });
});

test('when the store fails after the step answered, the answer is returned with a warning in front', async () => {
  await withServer('1', async (baseUrl) => {
    storeFails = /\/reports$/;
    const result = await runOrchestrator({ input: bridgeInput(pageMessage({ substep_id: '1.3', case_text: 'Laadpalen.' })), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.equal(result.ok, true);
    assert.equal(result.text, `${STORE_WARNING_TEXT}\n\nRapport 1.3`);
    assert.equal(result.answer, `${STORE_WARNING_TEXT}\n\nRapport 1.3`);
    assert.deepEqual(result.store.written, ['case_text']);
    assert.deepEqual(result.store.errors.map((e) => e.split(':')[0]), ['report']);
  });
});

const { contextFromState } = require('../orchestrator');

const STATE = {
  id: 'conv-1',
  case_text: { version: 2, text: 'De casus uit de opslag.' },
  reports: {
    '2.1': { version: 1, text: 'Rapport 2.1' },
    '1.1': { version: 3, text: 'Rapport 1.1 v3' },
    '1.3': { version: 1, text: 'Rapport 1.3' },
  },
  turns: [
    { seq: 1, role: 'user', text: 'Eerste vraag' },
    { seq: 2, role: 'assistant', step_id: 'stap1', text: 'Eerste antwoord' },
  ],
};

test('contextFromState gives a report the reports up to its substep, and a question every report, in order', () => {
  const forReport = contextFromState(STATE, { substepId: '1.3', forReport: true, summaries: SUMMARIES });
  assert.equal(forReport.caseText, 'De casus uit de opslag.');
  assert.equal(forReport.findings, 'Rapport 1.1 v3\n\nRapport 1.3');
  assert.equal(forReport.conversation, 'Gebruiker: Eerste vraag\nBeleidskompas: Eerste antwoord');
  const forQuestion = contextFromState(STATE, { substepId: '1.3', forReport: false, summaries: SUMMARIES });
  assert.equal(forQuestion.findings, 'Rapport 1.1 v3\n\nRapport 1.3\n\nRapport 2.1');
  assert.deepEqual(contextFromState(null, { substepId: '1.1', forReport: true, summaries: SUMMARIES }), { caseText: '', findings: '', conversation: '' });
});

test('with a state in the store, the step gets the case, the reports and the conversation from the store, not from the page', async () => {
  await withServer('1', async (baseUrl, requests) => {
    storeState = STATE;
    const result = await runOrchestrator({
      input: bridgeInput(pageMessage({ substep_id: '1.3', case_text: 'De casus van de pagina.', message: 'Welke stakeholders?' })),
      env: STORE_ENV(baseUrl),
      summaries: SUMMARIES,
      fetchImpl: global.fetch,
    });
    assert.equal(result.store.read, true);
    const sent = requests.find((r) => r.url === '/webhook/beleidskompas-step-stap1').body;
    assert.equal(sent.case_text, 'De casus uit de opslag.');
    assert.equal(sent.findings, 'Rapport 1.1 v3\n\nRapport 1.3\n\nRapport 2.1');
    assert.equal(sent.conversation, 'Gebruiker: Eerste vraag\nBeleidskompas: Eerste antwoord');
    assert.equal(sent.message, 'Welke stakeholders?');
    // The state is read before the user's turn is written, so the turn is not in the conversation twice.
    const order = requests.map((r) => `${r.method || ''} ${r.url}`.trim());
    const read = requests.findIndex((r) => r.url.startsWith('/api/beleidskompas/cases/conv-1?'));
    const turn = requests.findIndex((r) => r.url === '/api/beleidskompas/cases/conv-1/turns');
    assert.ok(read !== -1 && turn !== -1 && read < turn, order.join(' | '));
  });
});

test('a question from LibreChat\'s own chat gets the case and the conversation from the store', async () => {
  await withServer('1', async (baseUrl, requests) => {
    storeState = STATE;
    await runOrchestrator({ input: bridgeInput('En wie zijn de stakeholders dan?'), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    const sent = requests.find((r) => r.url === '/webhook/beleidskompas-step-stap1').body;
    assert.equal(sent.case_text, 'De casus uit de opslag.');
    assert.equal(sent.conversation, 'Gebruiker: Eerste vraag\nBeleidskompas: Eerste antwoord');
    assert.equal(sent.message, 'En wie zijn de stakeholders dan?');
  });
});

test('without a case in the store yet, the step gets the case text from the page and no reports, and that is not an error', async () => {
  await withServer('1', async (baseUrl, requests) => {
    const result = await runOrchestrator({ input: bridgeInput(pageMessage({ substep_id: '1.3', case_text: 'De casus van de pagina.' })), env: STORE_ENV(baseUrl), summaries: SUMMARIES, fetchImpl: global.fetch });
    assert.equal(result.store.read, false);
    assert.deepEqual(result.store.errors, []);
    const sent = requests.find((r) => r.url === '/webhook/beleidskompas-step-stap1').body;
    assert.equal(sent.case_text, 'De casus van de pagina.');
    assert.equal(sent.findings, '');
    assert.equal(sent.conversation, '');
  });
});
