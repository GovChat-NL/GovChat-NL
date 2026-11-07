'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { STEP_ROUTES, chooseStep, buildStepRequest, runOrchestrator } = require('../orchestrator');
const { parsePageMessage } = require('../shared');

// The same shape generate-workflow.js builds for the orchestrator workflow.
const SUMMARIES = ['step1', 'step2', 'step3', 'step4'].map((name) => {
  const { STEP } = require(`../steps/${name}`);
  return { id: STEP.id, nr: STEP.nr, title: STEP.title, role: STEP.role, substeps: STEP.substeps.map((s) => s.title) };
});

/** Runs `fn(baseUrl, requests)` against one server that stands in for both
 *  LiteLLM (answers every chat completion with `modelReply`) and n8n (answers
 *  every step webhook with a JSON that names the path). `requests` collects
 *  what was sent, in order. */
function withServer(modelReply, fn) {
  const requests = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url.endsWith('/v1/chat/completions')) {
          res.end(JSON.stringify({ choices: [{ message: { content: modelReply } }] }));
        } else {
          res.end(JSON.stringify({ ok: true, text: `antwoord van ${req.url}`, answer: `antwoord van ${req.url}` }));
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

test('buildStepRequest only passes the substep to its own step, and always says where the user asked from', () => {
  const parts = parsePageMessage('Deelstap: 1.3 (Stakeholderanalyse)\nCasus: Laadpalen.\nBericht: Welke instrumenten?');
  const own = buildStepRequest('stap1', parts, {});
  assert.equal(own.substep_id, '1.3');
  assert.equal(own.asked_from, '1.3');
  const other = buildStepRequest('stap3', parts, {});
  assert.equal(other.substep_id, null);
  assert.equal(other.asked_from, '1.3');
  assert.equal(other.message, 'Welke instrumenten?');
});

function orchestratorInput(message) {
  return { body: { currentMessage: message }, headers: {} };
}

test('runOrchestrator sends a report request to the step of the substep, without asking the model', async () => {
  await withServer('3', async (baseUrl, requests) => {
    const result = await runOrchestrator({
      input: orchestratorInput('Deelstap: 1.3 (Stakeholderanalyse)\nCasus: Laadpalen.'),
      env: { BELEIDSKOMPAS_N8N_BASE_URL: baseUrl, LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
      summaries: SUMMARIES,
      fetchImpl: global.fetch,
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/webhook/beleidskompas-step-stap1');
    assert.equal(requests[0].body.substep_id, '1.3');
    assert.equal(result.text, 'antwoord van /webhook/beleidskompas-step-stap1');
  });
});

test('runOrchestrator sends a typed message to the step the model picks, and returns that step\'s answer unchanged', async () => {
  await withServer('3', async (baseUrl, requests) => {
    const result = await runOrchestrator({
      input: orchestratorInput('Deelstap: 1.3 (Stakeholderanalyse)\nCasus: Laadpalen.\nBericht: Welke instrumenten passen hierbij?'),
      env: { BELEIDSKOMPAS_N8N_BASE_URL: baseUrl, LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
      summaries: SUMMARIES,
      fetchImpl: global.fetch,
    });
    assert.deepEqual(requests.map((r) => r.url), ['/v1/chat/completions', '/webhook/beleidskompas-step-stap3']);
    const sent = requests[1].body;
    assert.equal(sent.step_id, 'stap3');
    assert.equal(sent.substep_id, null);
    assert.equal(sent.asked_from, '1.3');
    assert.equal(sent.message, 'Welke instrumenten passen hierbij?');
    assert.equal(result.text, 'antwoord van /webhook/beleidskompas-step-stap3');
  });
});

test('runOrchestrator treats a message without labels as a question from the chat, with step 1 to fall back on', async () => {
  await withServer('Geen idee.', async (baseUrl, requests) => {
    const result = await runOrchestrator({
      input: orchestratorInput('Wat doet Beleidskompas precies?'),
      env: { BELEIDSKOMPAS_N8N_BASE_URL: baseUrl, LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
      summaries: SUMMARIES,
      fetchImpl: global.fetch,
    });
    assert.deepEqual(requests.map((r) => r.url), ['/v1/chat/completions', '/webhook/beleidskompas-step-stap1']);
    const sent = requests[1].body;
    assert.equal(sent.message, 'Wat doet Beleidskompas precies?');
    assert.equal(sent.case_text, '');
    assert.equal(sent.substep_id, null);
    assert.equal(result.text, 'antwoord van /webhook/beleidskompas-step-stap1');
  });
  await withServer('3', async (baseUrl, requests) => {
    await runOrchestrator({
      input: orchestratorInput('Welke instrumenten heeft de provincie?'),
      env: { BELEIDSKOMPAS_N8N_BASE_URL: baseUrl, LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
      summaries: SUMMARIES,
      fetchImpl: global.fetch,
    });
    assert.equal(requests[1].url, '/webhook/beleidskompas-step-stap3');
  });
});

test('runOrchestrator refuses a labeled message that names no known step', async () => {
  const result = await runOrchestrator({ input: orchestratorInput('Stap: stap9\nBericht: Hallo?'), env: {}, summaries: SUMMARIES, fetchImpl: global.fetch });
  assert.equal(result.ok, false);
  assert.equal(result.step_id, null);
});
