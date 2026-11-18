'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { REQUEST_META_LABEL, TITLE_REQUEST_MARKER } = require('../shared');
const {
  UNKNOWN_STEP_TEXT,
  STORE_MISSING_TEXT,
  STORE_FAILED_TEXT,
  STORE_WARNING_TEXT,
  NO_ANSWER_TEXT,
  buildOrchestratorPrompt,
  prepareRequest,
  buildContext,
  buildTitle,
  buildAnswer,
  finishAnswer,
} = require('../orchestrator');
const { STEPS } = require('../generate-workflow');
const { DEFAULT_TEMPLATE } = require('../template');

const env = { N8N_WEBHOOK_TOKEN: 'geheim', BELEIDSKOMPAS_STORE_URL: 'http://store', BELEIDSKOMPAS_STORE_TOKEN: 'store-token' };
const headers = { authorization: 'Bearer geheim' };
// What the admin answers: the published template and its settings.
const live = { version_id: 'v1', flow: DEFAULT_TEMPLATE, settings: { default_model: 'een-model' } };
const stepIds = STEPS.map((step) => step.id);

function pageMessage(request, shown = 'Zichtbare tekst') {
  return `${shown}\n\n[${REQUEST_META_LABEL}]: data:application/json;base64,${Buffer.from(JSON.stringify(request), 'utf8').toString('base64')}`;
}

function prepare(body, overrides = {}) {
  return prepareRequest({ body: { sessionId: 'c1', userId: 'u1', ...body }, headers, env, now: 1000, ...overrides });
}

const report11 = '**Stap 1 · Publiek en provinciaal belang · 1.1 Probleemdefinitie**\n\n### Samenvatting casus\nKort.\n\n### Probleemdefinitie\n**Probleem:** x\n\n---\nDisclaimer';
const report12 = '**Stap 1 · Publiek en provinciaal belang · 1.2 Overheidsinterventie**\n\n### Overheidsinterventie\n**Oordeel:** beperkt\n\n---\nDisclaimer';
const state = {
  id: 'c1',
  reports: { '1.1': { version: 2, text: report11 }, '1.2': { version: 1, text: report12 } },
  turns: [
    { role: 'user', text: 'hallo' },
    { role: 'assistant', text: 'dag' },
  ],
};

// --- prepareRequest ---

test('a wrong token is refused without a text, so the caller learns nothing', () => {
  const refused = prepareRequest({ body: { sessionId: 'c1', userId: 'u1' }, headers: { authorization: 'Bearer fout' }, env, now: 1 });
  assert.deepEqual([refused.kind, refused.ok, refused.text], ['refused', false, '']);
});

test('a request for a report: the block of the page names the substep', () => {
  const request = prepare({ currentMessage: pageMessage({ substep_id: '3.2', message: '' }) });
  assert.deepEqual(request, { kind: 'report', ok: true, case_id: 'c1', user_id: 'u1', substep_id: '3.2', message: '', started_at: 1000 });
});

test('a typed message from the page keeps the substep the user is in', () => {
  const request = prepare({ chatInput: pageMessage({ substep_id: '1.2', message: 'Waarom beperkt?' }) });
  assert.deepEqual([request.kind, request.substep_id, request.message], ['message', '1.2', 'Waarom beperkt?']);
});

test('a message typed in the chat of LibreChat has no substep', () => {
  const request = prepare({ currentMessage: 'Wat is de rol van de provincie?' });
  assert.deepEqual([request.kind, request.substep_id, request.message], ['message', '', 'Wat is de rol van de provincie?']);
});

test('without a store, or without the conversation and the user from the bridge, the request is refused', () => {
  const noStore = prepare({ currentMessage: 'Vraag' }, { env: { N8N_WEBHOOK_TOKEN: 'geheim' } });
  assert.deepEqual([noStore.kind, noStore.text], ['refused', STORE_MISSING_TEXT]);
  const noUser = prepareRequest({ body: { sessionId: 'c1', currentMessage: 'Vraag' }, headers, env, now: 1 });
  assert.deepEqual([noUser.kind, noUser.text], ['refused', STORE_MISSING_TEXT]);
});

test('a title request is recognised in the message and in the system prompt, and works without a store', () => {
  const convo = `${TITLE_REQUEST_MARKER} Geef een titel.\n\nUser: ${pageMessage({ substep_id: '1.1', message: 'Een gemeente wil een zwembad subsidiëren.' })}\nAI: Dat hangt af van ...`;
  const inMessage = prepare({ currentMessage: convo });
  assert.deepEqual([inMessage.kind, inMessage.title_source, inMessage.case_id], ['title', 'Een gemeente wil een zwembad subsidiëren.', 'c1']);

  const inSystem = prepareRequest({ body: { systemPrompt: `x ${TITLE_REQUEST_MARKER}`, currentMessage: 'User: Een casus.\nAI: antwoord' }, headers, env: { N8N_WEBHOOK_TOKEN: 'geheim' }, now: 1 });
  assert.deepEqual([inSystem.kind, inSystem.title_source], ['title', 'Een casus.']);
});

// --- buildContext ---

test('the context holds every report in full, the conversation and the request', () => {
  const request = prepare({ currentMessage: pageMessage({ substep_id: '1.3', message: '' }) });
  const context = buildContext({ request, state, live, stepIds });

  assert.equal(context.ok, true);
  assert.equal(context.conversation, 'Gebruiker: hallo\nBeleidskompas: dag');
  assert.equal(context.findings, `${report11}\n\n${report12}`);
  assert.equal(
    context.prompt,
    `Bevindingen tot nu toe:\n${report11}\n\n${report12}\n\nLaatste beurten van het gesprek:\nGebruiker: hallo\nBeleidskompas: dag\n\nVerzoek: werk deelstap 1.3 uit.`,
  );
});

test('the agent of a step gets the reports up to and including the substep of a report, and all of them for a question', () => {
  const later = { ...state, reports: { '2.1': { version: 1, text: 'Rapport 2.1' }, ...state.reports } };

  const report = buildContext({ request: prepare({ currentMessage: pageMessage({ substep_id: '1.2', message: '' }) }), state: later, live, stepIds });
  assert.equal(report.findings, `${report11}\n\n${report12}`);
  assert.ok(report.prompt.includes('Rapport 2.1'), 'the orchestrator reads every report');

  const question = buildContext({ request: prepare({ currentMessage: pageMessage({ substep_id: '1.2', message: 'Waarom?' }) }), state: later, live, stepIds });
  assert.equal(question.findings, `${report11}\n\n${report12}\n\nRapport 2.1`);
});

test('a typed message says where the user is', () => {
  const request = prepare({ currentMessage: 'Waarom beperkt?' });
  const context = buildContext({ request, state, live, stepIds });
  assert.ok(context.prompt.endsWith('Bericht van de gebruiker (de gebruiker zit in deelstap onbekend):\nWaarom beperkt?'));
});

test('a new case has no reports and no conversation yet', () => {
  const request = prepare({ currentMessage: pageMessage({ substep_id: '1.1', message: '' }) });
  const context = buildContext({ request, state: { id: 'c1', reports: {}, turns: [] }, live, stepIds });
  assert.equal(context.prompt, 'Bevindingen tot nu toe: (nog geen deelstap uitgewerkt)\n\nVerzoek: werk deelstap 1.1 uit.');
  assert.equal(context.findings, '');
});

test('when the store or the template cannot be read, there is no answer but a message for the chat', () => {
  const request = prepare({ currentMessage: 'Vraag' });
  const unreadable = buildContext({ request, state: { error: { message: 'ECONNREFUSED' } }, live, stepIds });
  assert.deepEqual([unreadable.ok, unreadable.text, unreadable.error], [false, STORE_FAILED_TEXT, 'state: ECONNREFUSED']);
  const noTemplate = buildContext({ request, state, live: { error: { message: 'HTTP 503' } }, stepIds });
  assert.deepEqual([noTemplate.ok, noTemplate.text, noTemplate.error], [false, STORE_FAILED_TEXT, 'template: HTTP 503']);
});

test('a request for a report of a substep that does not exist is refused with a message for the chat', () => {
  const request = prepare({ currentMessage: pageMessage({ substep_id: '9.9', message: '' }) });
  const refused = buildContext({ request, state, live, stepIds });
  assert.deepEqual([refused.ok, refused.text, refused.answer], [false, UNKNOWN_STEP_TEXT, UNKNOWN_STEP_TEXT]);
});

test('the context holds what the agents need from the template', () => {
  const edited = { ...live, flow: { ...DEFAULT_TEMPLATE, rules: 'Een eigen regel.', orchestrator_prompt: 'Eigen instructie.\n{{steps}}' } };
  const context = buildContext({ request: prepare({ currentMessage: 'Vraag' }), state, live: edited, stepIds: ['stap1', 'stap2'] });

  assert.equal(context.model, 'een-model');
  assert.ok(context.system_prompt.startsWith('Eigen instructie.\n- stap1_agent: stap 1, Publiek en provinciaal belang (1.1 Probleemdefinitie, '));
  // A step of the template without an agent cannot be asked.
  assert.deepEqual(Object.keys(context.step_templates), ['stap1', 'stap2']);
  assert.ok(!context.system_prompt.includes('stap3_agent'));
  const forStep2 = JSON.parse(context.step_templates.stap2);
  assert.deepEqual([forStep2.model, forStep2.rules, forStep2.step], ['een-model', 'Een eigen regel.', STEPS[1]]);
});

// --- The orchestrator's prompt ---

test('the system prompt of the orchestrator lists the agent of every step with its substeps', () => {
  const prompt = buildOrchestratorPrompt(DEFAULT_TEMPLATE.steps, DEFAULT_TEMPLATE.orchestrator_prompt);
  assert.ok(!prompt.includes('{{'));
  assert.ok(prompt.includes('- stap1_agent: stap 1, Publiek en provinciaal belang (1.1 Probleemdefinitie, '));
  for (const step of STEPS) assert.ok(prompt.includes(`- stap${step.nr}_agent: stap ${step.nr}, ${step.title} (`));
});

// --- buildTitle ---

test('the title is what the model replied, without wrapping characters, with the prefix', () => {
  const request = { kind: 'title', case_id: 'c1', user_id: 'u1', title_source: 'Een gemeente wil een zwembad subsidiëren met provinciaal geld.' };
  const title = buildTitle({ request, reply: { text: ' "**Subsidie zwembad**" \n' } });
  assert.deepEqual([title.ok, title.mode, title.text, title.answer, title.case_id], [true, 'title', 'Beleidskompas - Subsidie zwembad', 'Beleidskompas - Subsidie zwembad', 'c1']);
});

test('without a usable reply the title is made from the first words of the case', () => {
  const request = { kind: 'title', case_id: 'c1', user_id: 'u1', title_source: 'Een gemeente wil een zwembad subsidiëren met provinciaal geld en vraagt advies.' };
  assert.equal(buildTitle({ request, reply: { error: { message: 'timeout' } } }).text, 'Beleidskompas - Een gemeente wil een zwembad subsidiëren met provinciaal…');
  assert.equal(buildTitle({ request: { ...request, title_source: '' }, reply: { text: '' } }).text, 'Beleidskompas - Beleidskompas casus');
});

// --- buildAnswer ---

const context = buildContext({ request: prepare({ currentMessage: pageMessage({ substep_id: '1.2', message: '' }) }), state, live, stepIds });

test('the answer after a report: the message of the orchestrator and the step it called', () => {
  const agent = { output: ' Deelstap 1.2 is uitgewerkt. Het budget ontbreekt nog. ', intermediateSteps: [{ action: { tool: 'stap1_agent', toolInput: { substep_id: '1.2', assignment: 'uitwerken' } } }] };
  const answer = buildAnswer({ context, agent, now: 18500 });

  assert.deepEqual(answer, {
    case_id: 'c1',
    user_id: 'u1',
    mode: 'report',
    step_id: 'stap1',
    asked_from: '1.2',
    tools: [{ tool: 'stap1_agent', input: { substep_id: '1.2', assignment: 'uitwerken' } }],
    duration_ms: 17500,
    ok: true,
    text: 'Deelstap 1.2 is uitgewerkt. Het budget ontbreekt nog.',
    answer: 'Deelstap 1.2 is uitgewerkt. Het budget ontbreekt nog.',
  });
});

test('the answer to a question that involved two steps names the first one', () => {
  const messageContext = buildContext({ request: prepare({ currentMessage: 'Past de rol bij het probleem?' }), state, live, stepIds });
  const agent = { output: 'Ja.', intermediateSteps: [{ action: { tool: 'stap2_agent', toolInput: {} } }, { action: { tool: 'stap1_agent', toolInput: {} } }] };
  const answer = buildAnswer({ context: messageContext, agent, now: 2000 });
  assert.deepEqual([answer.mode, answer.step_id, answer.asked_from, answer.tools.length], ['conversation', 'stap2', null, 2]);
});

test('a failing or silent orchestrator gives a message for the chat, not an empty answer', () => {
  const failed = buildAnswer({ context, agent: { error: { message: 'LiteLLM 500' } }, now: 2000 });
  assert.deepEqual([failed.ok, failed.text, failed.answer, failed.error], [false, NO_ANSWER_TEXT, NO_ANSWER_TEXT, 'LiteLLM 500']);
  const silent = buildAnswer({ context, agent: { output: '  ' }, now: 2000 });
  assert.deepEqual([silent.ok, silent.text], [false, NO_ANSWER_TEXT]);
});

test('when storing the turn of the orchestrator failed, the answer goes back with a warning in front', () => {
  const answer = { ok: true, text: 'Antwoord.', answer: 'Antwoord.' };
  assert.equal(finishAnswer({ answer, saveError: null }), answer);
  const warned = finishAnswer({ answer, saveError: 'HTTP 500' });
  assert.deepEqual([warned.ok, warned.text, warned.answer, warned.store_error], [true, `${STORE_WARNING_TEXT}\n\nAntwoord.`, `${STORE_WARNING_TEXT}\n\nAntwoord.`, 'assistant_turn: HTTP 500']);
});
