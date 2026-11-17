'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { REQUEST_META_LABEL, TITLE_REQUEST_MARKER } = require('../shared');
const { STEPS, STEP_AGENT_INPUTS, buildOrchestratorWorkflow, buildStepAgentWorkflow, buildAll } = require('../generate-workflow');

const orchestrator = buildOrchestratorWorkflow(STEPS)[0];
const agents = STEPS.map((step) => buildStepAgentWorkflow(step)[0]);
const workflows = [orchestrator, ...agents];

/** Runs the code of a Code node the way n8n does: with `$json` (the item
 *  that comes in), `$env`, and `$('name')` for the output of an earlier
 *  node. Nothing else is in scope, so a function or constant the generator
 *  forgot to copy in fails here. */
function runCode(workflow, name, $json, earlier = {}, env = {}) {
  const node = workflow.nodes.find((n) => n.name === name);
  assert.ok(node && node.type === 'n8n-nodes-base.code', `${workflow.name} has a Code node "${name}"`);
  const $ = (other) => {
    assert.ok(other in earlier, `"${name}" reads "${other}", which did not run`);
    return { first: () => ({ json: earlier[other] }) };
  };
  const items = new Function('$json', '$env', '$', node.parameters.jsCode)($json, env, $);
  assert.ok(Array.isArray(items) && items.length === 1 && items[0].json, `"${name}" returns one item`);
  return items[0].json;
}

test('the generated files are up to date with the source', () => {
  for (const file of buildAll()) {
    assert.equal(fs.readFileSync(file.path, 'utf-8'), JSON.stringify(file.data, null, 2) + '\n', `${file.path}: run "node generate-workflow.js"`);
  }
});

test('every workflow has a stable id, and every node is connected to nodes that exist', () => {
  assert.equal(new Set(workflows.map((w) => w.id)).size, workflows.length);
  for (const w of workflows) {
    const names = new Set(w.nodes.map((n) => n.name));
    assert.equal(names.size, w.nodes.length, `${w.name}: node names are unique`);
    assert.equal(new Set(w.nodes.map((n) => n.id)).size, w.nodes.length, `${w.name}: node ids are unique`);
    const linked = new Set();
    for (const [from, kinds] of Object.entries(w.connections)) {
      assert.ok(names.has(from), `${w.name}: connection from unknown node "${from}"`);
      linked.add(from);
      for (const outputs of Object.values(kinds)) {
        for (const targets of outputs) {
          for (const target of targets) {
            assert.ok(names.has(target.node), `${w.name}: connection to unknown node "${target.node}"`);
            linked.add(target.node);
          }
        }
      }
    }
    for (const name of names) assert.ok(linked.has(name), `${w.name}: node "${name}" is not connected`);
  }
});

test('the orchestrator keeps the address the bridge calls, and has one tool per step', () => {
  const webhook = orchestrator.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.path, 'beleidskompas-orchestrator');
  assert.equal(orchestrator.id, 'govchat-beleidskompas-orchestrator');
  const tools = orchestrator.nodes.filter((n) => n.type.endsWith('toolWorkflow'));
  assert.deepEqual(tools.map((t) => t.name), STEPS.map((step) => `stap${step.nr}_agent`));
  assert.deepEqual(tools.map((t) => t.parameters.workflowId.value), agents.map((a) => a.id));
});

test('a tool passes exactly the inputs the called workflow declares, and the model fills only what it may', () => {
  const declared = (w) => w.nodes.find((n) => n.type.endsWith('executeWorkflowTrigger')).parameters.workflowInputs.values.map((v) => v.name);
  for (const agent of agents) assert.deepEqual(declared(agent), STEP_AGENT_INPUTS);

  for (const tool of orchestrator.nodes.filter((n) => n.type.endsWith('toolWorkflow'))) {
    const inputs = tool.parameters.workflowInputs;
    assert.deepEqual(Object.keys(inputs.value), STEP_AGENT_INPUTS);
    assert.deepEqual(inputs.schema.map((s) => s.id), STEP_AGENT_INPUTS);
    const filledByModel = Object.entries(inputs.value).filter(([, value]) => value.includes('$fromAI')).map(([name]) => name);
    assert.deepEqual(filledByModel, ['substep_id', 'assignment']);
  }
});

test('every agent has a model, and a failing agent or store call does not stop its workflow', () => {
  for (const w of workflows) {
    for (const agent of w.nodes.filter((n) => n.type.endsWith('.agent'))) {
      const models = Object.entries(w.connections).filter(([, kinds]) => kinds.ai_languageModel && kinds.ai_languageModel[0][0].node === agent.name);
      assert.equal(models.length, 1, `${w.name}: ${agent.name} has one model`);
      assert.equal(agent.onError, 'continueRegularOutput');
    }
    for (const call of w.nodes.filter((n) => n.type.endsWith('.httpRequest'))) assert.equal(call.onError, 'continueRegularOutput');
  }
});

// --- The Code nodes, run in the order a request passes them ---

const env = { N8N_WEBHOOK_TOKEN: 'geheim', BELEIDSKOMPAS_STORE_URL: 'http://store', BELEIDSKOMPAS_STORE_TOKEN: 'store-token' };
const pageMessage = (request) => `Zichtbaar\n\n[${REQUEST_META_LABEL}]: data:application/json;base64,${Buffer.from(JSON.stringify(request), 'utf8').toString('base64')}`;
const webhook = (body) => ({ headers: { authorization: 'Bearer geheim' }, body: { sessionId: 'c1', userId: 'u1', ...body } });
const state = { id: 'c1', case_text: { text: 'Een casus.' }, reports: { '1.1': { version: 1, text: '### Probleemdefinitie\n**Probleem:** x\n\n---\nDisclaimer' } }, turns: [] };

test('a request for a report passes through the Code nodes of the orchestrator and a step agent', () => {
  const request = runCode(orchestrator, 'Verzoek voorbereiden', webhook({ currentMessage: pageMessage({ substep_id: '2.1', case_text: 'Een casus.', message: '' }) }), {}, env);
  assert.deepEqual([request.kind, request.substep_id], ['report', '2.1']);

  const context = runCode(orchestrator, 'Context samenstellen', state, { 'Verzoek voorbereiden': request, 'Casustekst opslaan': { version: 1, unchanged: true } });
  assert.equal(context.ok, true);
  assert.ok(context.prompt.endsWith('Verzoek: werk deelstap 2.1 uit.'));
  assert.equal(context.findings, state.reports['1.1'].text);

  // What the orchestrator's tool call hands the agent of step 2.
  const toolInput = { substep_id: '2.1', assignment: 'uitwerken', case_id: context.case_id, user_id: context.user_id, case_text: context.case_text, findings: context.findings, conversation: context.conversation };
  const assignment = runCode(agents[1], 'Opdracht opbouwen', toolInput);
  assert.deepEqual([assignment.mode, assignment.step_id], ['report', 'stap2']);
  assert.ok(assignment.user_prompt.includes(`Bevindingen tot nu toe:\n${state.reports['1.1'].text}`));

  const agentReply = { output: '### Rolbepaling\n**Oordeel:** regisserend\n\n### Aannames en ontbrekende informatie\n- budget onbekend' };
  const reply = runCode(agents[1], 'Antwoord verwerken', agentReply, { 'Opdracht opbouwen': assignment });
  assert.equal(reply.save, true);
  const result = runCode(agents[1], 'Resultaat voor de orchestrator', { version: 1 }, { 'Opdracht opbouwen': assignment, 'Antwoord verwerken': reply });
  assert.deepEqual([result.kind, result.saved, result.report], ['report', true, reply.report_text]);

  const after = { ...state, reports: { ...state.reports, '2.1': { version: 1, text: reply.report_text } } };
  const orchestratorReply = { output: 'Deelstap 2.1 is uitgewerkt. Het budget ontbreekt nog.', intermediateSteps: [{ action: { tool: 'stap2_agent', toolInput: { substep_id: '2.1', assignment: 'uitwerken' } } }] };
  const answer = runCode(orchestrator, 'Antwoord opbouwen', after, { 'Context samenstellen': context, 'AI Agent Orchestrator': orchestratorReply });
  assert.deepEqual([answer.ok, answer.mode, answer.step_id, answer.reports], [true, 'report', 'stap2', [{ substep_id: '2.1', version: 1 }]]);

  const finished = runCode(orchestrator, 'Antwoord afronden', { seq: 1 }, { 'Antwoord opbouwen': answer });
  assert.deepEqual(finished, answer);
});

test('an invalid assignment skips the agent and still gives the orchestrator a result', () => {
  const assignment = runCode(agents[0], 'Opdracht opbouwen', { substep_id: '3.1', assignment: 'uitwerken', case_id: 'c1', user_id: 'u1', case_text: '', findings: '', conversation: '' });
  assert.equal(assignment.valid, false);
  assert.equal(runCode(agents[0], 'Resultaat voor de orchestrator', assignment, { 'Opdracht opbouwen': assignment }).kind, 'error');
});

test('a message without a case text does not read the node that stores the case text', () => {
  const request = runCode(orchestrator, 'Verzoek voorbereiden', webhook({ currentMessage: 'Wat is de rol van de provincie?' }), {}, env);
  const context = runCode(orchestrator, 'Context samenstellen', state, { 'Verzoek voorbereiden': request });
  assert.deepEqual([context.ok, context.kind, context.case_text], [true, 'message', 'Een casus.']);
});

test('a title request, and the message when the turn of the user cannot be stored', () => {
  const request = runCode(orchestrator, 'Verzoek voorbereiden', webhook({ currentMessage: `${TITLE_REQUEST_MARKER} Geef een titel.\n\nUser: Een casus over dorpshuizen.\nAI: ...` }), {}, env);
  assert.equal(request.kind, 'title');
  assert.equal(runCode(orchestrator, 'Titel opbouwen', { output: 'Dorpshuizen verduurzamen' }, { 'Verzoek voorbereiden': request }).text, 'Beleidskompas - Dorpshuizen verduurzamen');
  assert.equal(runCode(orchestrator, 'Titel opbouwen', { error: { message: 'x' } }, { 'Verzoek voorbereiden': request }).text, 'Beleidskompas - Een casus over dorpshuizen.');

  const failed = runCode(orchestrator, 'Opslagfout melden', { error: { message: 'HTTP 500' } });
  assert.deepEqual([failed.ok, failed.error], [false, 'user_turn: HTTP 500']);
  assert.ok(failed.text.length > 0);
});
