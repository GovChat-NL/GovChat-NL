#!/usr/bin/env node
'use strict';

/**
 * Writes the Beleidskompas workflows for n8n from the source in this folder.
 *
 * It writes one workflow for the orchestrator, one workflow per step for
 * the agent of that step, the list of steps for the Beleidskompas page and
 * the template the admin starts with.
 *
 * n8n cannot read the source files. It only reads workflow files, in which
 * the code of a Code node is plain text. So this script copies the source of
 * every function a Code node needs into that text. The code that runs in n8n
 * is then the same code as in the source files, which the tests cover.
 *
 * The workflows hold no prompts. They read the template the admin published
 * when a message comes in. The files in prompts/ and steps/ are what the
 * admin starts with.
 *
 * Run this script after you change the source, then reload the workflows in
 * n8n with `make reload-workflows`.
 *
 * Usage: node generate-workflow.js
 */

const fs = require('node:fs');
const path = require('node:path');
const shared = require('./shared');
const orchestrator = require('./orchestrator');
const stepAgent = require('./step-agent');
const template = require('./template');

const STEPS = [require('./steps/step1').STEP, require('./steps/step2').STEP, require('./steps/step3').STEP, require('./steps/step4').STEP];

const WORKFLOWS_DIR = path.join(__dirname, '..', 'n8n', 'workflows', 'beleidskompas');
const PAGE_STEPS_FILE = path.join(__dirname, '..', '..', 'overlay', 'src', 'apps', 'beleidskompas', 'steps.json');
// The template the admin starts with. The admin image carries it under lib/.
const ADMIN_DEFAULTS_FILE = path.join(__dirname, '..', '..', 'services', 'admin-overlay', 'admin', 'lib', 'beleidskompas', 'default-template.json');

// =====================================================================
// Part 1: the building blocks of a workflow
//
// A workflow file holds a list of nodes and the connections between them.
// Each function below makes one kind of node. Every node has a name (what
// you see in n8n), a place on the canvas and its settings.
// =====================================================================

/** The place of a node on the canvas of n8n. Columns run from left to
 *  right in the order a request passes the nodes, rows from top to bottom. */
function at(column, row) {
  return [column * 220, row * 180];
}

function makeNode(name, type, typeVersion, position, parameters) {
  const id = name.replace(/[^A-Za-z0-9]/g, '');
  return { parameters, id, name, type, typeVersion, position };
}

/** n8n treats a setting that starts with "=" as an expression, and
 *  evaluates what is between {{ and }} when the workflow runs. */
function expression(code) {
  return `={{ ${code} }}`;
}

/** The expression for what an earlier node returned. */
function outputOf(nodeName) {
  return `$('${nodeName}').first().json`;
}

// --- Code node ---

/** The source text of a function from shared.js, orchestrator.js,
 *  step-agent.js or template.js. */
function sourceOf(functionName) {
  for (const sourceFile of [shared, orchestrator, stepAgent, template]) {
    if (typeof sourceFile[functionName] === 'function') {
      return sourceFile[functionName].toString();
    }
  }
  throw new Error(`No source file exports a function named "${functionName}"`);
}

/** A Code node. Its code is put together from three parts:
 *  - `constants`: values the functions use, written as `const NAME = ...;`
 *  - `functions`: the names of the functions to copy in from the source
 *  - `run`: the lines that call those functions with what n8n hands the node */
function codeNode(name, position, { constants, functions, run }) {
  const parts = [];

  const constantLines = [];
  for (const [constantName, value] of Object.entries(constants || {})) {
    constantLines.push(`const ${constantName} = ${JSON.stringify(value)};`);
  }
  if (constantLines.length > 0) {
    parts.push(constantLines.join('\n'));
  }

  for (const functionName of functions) {
    parts.push(sourceOf(functionName));
  }

  parts.push(run);

  return makeNode(name, 'n8n-nodes-base.code', 2, position, { jsCode: parts.join('\n\n') });
}

// --- Nodes that start and end a workflow ---

/** The node that receives a request from outside n8n. */
function webhookNode(name, position, { urlPath, workflowId }) {
  const node = makeNode(name, 'n8n-nodes-base.webhook', 2, position, {
    httpMethod: 'POST',
    path: urlPath,
    responseMode: 'responseNode',
    options: {},
  });
  node.webhookId = workflowId;
  return node;
}

/** The node that sends the answer back to whoever called the webhook.
 *  `answer` is an expression for what to send. */
function respondNode(name, position, answer) {
  return makeNode(name, 'n8n-nodes-base.respondToWebhook', 1, position, {
    respondWith: 'json',
    responseBody: expression(`JSON.stringify(${answer})`),
    options: {},
  });
}

/** The node that starts a workflow when another workflow calls it.
 *  `inputNames` are the values the caller has to pass. */
const TRIGGER_NAME = 'When Executed by Another Workflow';

function triggerNode(position, inputNames) {
  const inputs = [];
  for (const inputName of inputNames) {
    inputs.push({ name: inputName, type: 'string' });
  }
  return makeNode(TRIGGER_NAME, 'n8n-nodes-base.executeWorkflowTrigger', 1.1, position, {
    inputSource: 'workflowInputs',
    workflowInputs: { values: inputs },
  });
}

// --- If node ---

/** A node with two outputs. The request goes on through the first output
 *  when `condition` is true, and through the second when it is not. */
function ifNode(name, position, condition) {
  return makeNode(name, 'n8n-nodes-base.if', 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ leftValue: expression(condition), rightValue: true, operator: { type: 'boolean', operation: 'equals' } }],
      combinator: 'and',
    },
  });
}

// --- HTTP Request node for the admin: the store and the template ---

// In a setting that starts with "=", n8n fills in what is between {{ and }}
// and leaves the rest as it is. BELEIDSKOMPAS_STORE_URL has no slash at the end.
const ADMIN_ADDRESS = '={{ $env.BELEIDSKOMPAS_STORE_URL }}/api/beleidskompas';
const STORE_TOKEN_HEADER = { name: 'Authorization', value: '=Bearer {{ $env.BELEIDSKOMPAS_STORE_TOKEN }}' };

/** An HTTP Request node that calls the admin.
 *
 *  - `address`: where the call goes
 *  - `query`: values for the query string, for reading
 *  - `body`: the fields to send, each with an expression for its value,
 *    for writing
 *
 *  A failed call does not stop the workflow. The node then returns the error
 *  as its output, and the Code node after it decides what to do. */
function adminNode(name, position, { method, address, query, body }) {
  const parameters = {
    method,
    url: address,
    sendHeaders: true,
    headerParameters: { parameters: [STORE_TOKEN_HEADER] },
    options: { timeout: 10000 },
  };

  if (query) {
    const queryParameters = [];
    for (const [queryName, value] of Object.entries(query)) {
      queryParameters.push({ name: queryName, value });
    }
    parameters.sendQuery = true;
    parameters.queryParameters = { parameters: queryParameters };
  }

  if (body) {
    parameters.headerParameters.parameters.unshift({ name: 'Content-Type', value: 'application/json' });
    parameters.sendBody = true;
    parameters.specifyBody = 'json';
    const fields = [];
    for (const [fieldName, value] of Object.entries(body)) {
      fields.push(`  ${fieldName}: ${value},`);
    }
    parameters.jsonBody = expression(`JSON.stringify({\n${fields.join('\n')}\n})`);
  }

  const node = makeNode(name, 'n8n-nodes-base.httpRequest', 4.2, position, parameters);
  node.onError = 'continueRegularOutput';
  return node;
}

/** The call that reads the template the admin published. */
function templateNode(name, position) {
  return adminNode(name, position, { method: 'GET', address: `${ADMIN_ADDRESS}/live` });
}

/** A call of the Beleidskompas store for one case.
 *
 *  - `caseId`: an expression for the id of the case
 *  - `casePath`: what comes after /cases/<case id> in the address, if anything */
function storeNode(name, position, { method, caseId, casePath, query, body }) {
  // encodeURIComponent keeps a case id with a "/" or "?" in it from
  // pointing at another address.
  const address = `${ADMIN_ADDRESS}/cases/{{ encodeURIComponent(${caseId}) }}${casePath || ''}`;
  return adminNode(name, position, { method, address, query, body });
}

/** The store call that reads the state of a case. `source` is an
 *  expression for an object with `case_id` and `user_id`. */
function readStateNode(name, position, source) {
  return storeNode(name, position, {
    method: 'GET',
    caseId: `${source}.case_id`,
    query: {
      user_id: expression(`${source}.user_id`),
      max_turns: String(orchestrator.MAX_TURNS),
    },
  });
}

// --- AI Agent node, with its model and its tools ---

/** An AI Agent node. `prompt` is what the agent is asked, `systemPrompt`
 *  its instruction.
 *
 *  A failing model does not stop the workflow. The node then returns the
 *  error as its output. */
function agentNode(name, position, { prompt, systemPrompt, maxIterations }) {
  const node = makeNode(name, '@n8n/n8n-nodes-langchain.agent', 3.1, position, {
    promptType: 'define',
    text: prompt,
    hasOutputParser: false,
    options: {
      systemMessage: systemPrompt,
      enableStreaming: false,
      maxIterations,
      returnIntermediateSteps: true,
    },
  });
  node.onError = 'continueRegularOutput';
  return node;
}

/** A Basic LLM Chain node: one call of the model, without tools. `prompt`
 *  is what the model is asked, `systemPrompt` its instruction.
 *
 *  A failing model does not stop the workflow. The node then returns the
 *  error as its output. */
function llmChainNode(name, position, { prompt, systemPrompt }) {
  const node = makeNode(name, '@n8n/n8n-nodes-langchain.chainLlm', 1.9, position, {
    promptType: 'define',
    text: prompt,
    messages: { messageValues: [{ type: 'SystemMessagePromptTemplate', message: systemPrompt }] },
  });
  node.onError = 'continueRegularOutput';
  return node;
}

/** The language model of an agent or a chain. Every model call goes
 *  through LiteLLM. `model` is an expression for the name of the model. */
function chatModelNode(name, position, model) {
  const node = makeNode(name, '@n8n/n8n-nodes-langchain.lmChatOpenAi', 1.3, position, {
    model: { __rl: true, mode: 'id', value: model },
    options: { baseURL: expression("(String($env.LITELLM_URL || 'http://litellm:4000').replace(/\\/$/, '')) + '/v1'") },
  });
  node.credentials = { openAiApi: { id: '00000000-0000-4000-8000-000000000111', name: 'LiteLLM API' } };
  return node;
}

/** A tool of an agent that calls another workflow.
 *
 *  The called workflow gets a number of inputs. Some are filled in by the
 *  model, which reads the description to know what to put there. The others
 *  are filled in by this workflow, so the model cannot choose them. That is
 *  how the case and the user stay out of the model's hands.
 *
 *  - `filledByModel`: a list of { name, description, optional }
 *  - `filledByWorkflow`: a list of { name, value, optional }, where `value`
 *    is an expression */
function workflowToolNode(name, position, { description, workflowId, workflowName, filledByModel, filledByWorkflow }) {
  const values = {};
  const schema = [];

  function describeInput(input) {
    schema.push({
      id: input.name,
      displayName: input.name,
      required: !input.optional,
      defaultMatch: false,
      display: true,
      canBeUsedToMatch: true,
      type: 'string',
    });
  }

  for (const input of filledByModel) {
    // The last argument is what the input becomes when the model leaves it out.
    const fallback = input.optional ? ", ''" : '';
    values[input.name] = expression(`$fromAI('${input.name}', '${input.description}', 'string'${fallback})`);
    describeInput(input);
  }

  for (const input of filledByWorkflow) {
    values[input.name] = expression(input.value);
    describeInput(input);
  }

  return makeNode(name, '@n8n/n8n-nodes-langchain.toolWorkflow', 2.2, position, {
    description,
    source: 'database',
    workflowId: { __rl: true, mode: 'list', value: workflowId, cachedResultName: workflowName },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value: values,
      matchingColumns: [],
      schema,
      attemptToConvertTypes: false,
      convertFieldsToString: false,
    },
  });
}

// --- Connections ---

/** Draws a line from one node to the next. A node with two outputs (an If
 *  node) has output 0 and output 1. */
function connect(connections, fromNode, toNode, output = 0) {
  if (!connections[fromNode]) {
    connections[fromNode] = { main: [] };
  }
  const outputs = connections[fromNode].main;
  while (outputs.length <= output) {
    outputs.push([]);
  }
  outputs[output].push({ node: toNode, type: 'main', index: 0 });
}

/** Draws the two lines out of an If node. */
function connectIf(connections, ifNodeName, { whenTrue, whenFalse }) {
  connect(connections, ifNodeName, whenTrue, 0);
  connect(connections, ifNodeName, whenFalse, 1);
}

/** Hangs a language model or a tool under an agent, or a language model
 *  under a chain. */
function attachToAgent(connections, kind, nodeName, agentName) {
  connections[nodeName] = { [kind]: [[{ node: agentName, type: kind, index: 0 }]] };
}

/** The workflow as n8n imports it. `active` says whether n8n should listen
 *  for requests itself, which only a workflow with a webhook needs. */
function makeWorkflow({ id, name, active, nodes, connections }) {
  return [{ id, name, active, isArchived: false, nodes, connections, settings: { executionOrder: 'v1' } }];
}

// =====================================================================
// Part 2: the workflow of the agent of a step
// =====================================================================

// What the orchestrator passes to the agent of a step. The first two are
// filled in by the orchestrator's model, the rest by its workflow.
const STEP_AGENT_INPUTS = ['substep_label', 'assignment', 'case_id', 'user_id', 'findings', 'conversation', 'documents', 'template'];

function stepAgentWorkflowId(step) {
  return `govchat-beleidskompas-agent-${step.id}`;
}

function stepAgentWorkflowName(step) {
  return `Beleidskompas - Agent stap ${step.nr}`;
}

function buildStepAgentWorkflow(step) {
  const agentName = `AI Agent Stap ${step.nr}`;
  const modelName = `OpenAI Chat Model (Stap ${step.nr})`;

  const nodes = [
    triggerNode(at(0, 1), STEP_AGENT_INPUTS),

    codeNode('Opdracht opbouwen', at(1, 1), {
      functions: ['asksForReport', 'buildSystemPrompt', 'buildUserPrompt', 'readStepTemplate', 'buildAssignment'],
      run: 'return [{ json: buildAssignment({ input: $json }) }];',
    }),

    ifNode('Opdracht opgebouwd?', at(2, 1), '$json.valid === true'),

    agentNode(agentName, at(3, 0), {
      prompt: expression('$json.user_prompt'),
      systemPrompt: expression('$json.system_prompt'),
      maxIterations: 8,
    }),
    chatModelNode(modelName, at(3, 1), expression(`${outputOf('Opdracht opbouwen')}.model`)),

    codeNode('Antwoord verwerken', at(5, 0), {
      functions: ['toolCalls', 'nodeError', 'unwrapCodeBlock', 'processReply'],
      run: `return [{ json: processReply({ assignment: ${outputOf('Opdracht opbouwen')}, agent: $json }) }];`,
    }),

    ifNode('Rapport gemaakt?', at(6, 0), '$json.save === true'),

    storeNode('Rapport opslaan', at(7, 0), {
      method: 'POST',
      caseId: '$json.case_id',
      casePath: '/reports',
      body: { user_id: '$json.user_id', substep_id: '$json.substep_id', text: '$json.report_text', citations: '[]' },
    }),

    codeNode('Resultaat voor de orchestrator', at(8, 1), {
      functions: ['buildResult'],
      run: [
        `const assignment = ${outputOf('Opdracht opbouwen')};`,
        '',
        '// The agent did not run for an invalid assignment, so there is no reply then.',
        `const reply = assignment.valid ? ${outputOf('Antwoord verwerken')} : null;`,
        '',
        '// Only after a report was stored does this node get the answer of the store.',
        'const saved = reply && reply.save ? $json : null;',
        '',
        'return [{ json: buildResult({ assignment, reply, saved }) }];',
      ].join('\n'),
    }),
  ];

  const connections = {};
  connect(connections, TRIGGER_NAME, 'Opdracht opbouwen');
  connect(connections, 'Opdracht opbouwen', 'Opdracht opgebouwd?');
  connectIf(connections, 'Opdracht opgebouwd?', { whenTrue: agentName, whenFalse: 'Resultaat voor de orchestrator' });
  attachToAgent(connections, 'ai_languageModel', modelName, agentName);
  connect(connections, agentName, 'Antwoord verwerken');
  connect(connections, 'Antwoord verwerken', 'Rapport gemaakt?');
  connectIf(connections, 'Rapport gemaakt?', { whenTrue: 'Rapport opslaan', whenFalse: 'Resultaat voor de orchestrator' });
  connect(connections, 'Rapport opslaan', 'Resultaat voor de orchestrator');

  return makeWorkflow({ id: stepAgentWorkflowId(step), name: stepAgentWorkflowName(step), active: false, nodes, connections });
}

// =====================================================================
// Part 3: the workflow of the orchestrator
// =====================================================================

/** The tool with which the orchestrator calls the agent of one step. What
 *  the step is about, the orchestrator reads in its instruction. */
function stepAgentToolNode(step, position) {
  const description =
    `De agent van stap ${step.nr}. ` +
    'Werkt een deelstap van deze stap uit, of beantwoordt een vraag over deze stap. ' +
    'Bij een uitwerking slaat de agent het rapport zelf op en geeft hij het rapport terug.';

  const context = outputOf('Gegevens voor de agents klaarzetten');

  return workflowToolNode(orchestrator.stepToolName(step), position, {
    description,
    workflowId: stepAgentWorkflowId(step),
    workflowName: stepAgentWorkflowName(step),
    filledByModel: [
      { name: 'substep_label', description: `Het nummer van de deelstap zoals in de lijst, bijvoorbeeld ${step.nr}.1. Leeg bij een vraag over de hele stap.`, optional: true },
      { name: 'assignment', description: 'Het woord uitwerken, of de vraag van de gebruiker, letterlijk.' },
    ],
    filledByWorkflow: [
      { name: 'case_id', value: `${context}.case_id` },
      { name: 'user_id', value: `${context}.user_id` },
      { name: 'findings', value: `${context}.findings`, optional: true },
      { name: 'conversation', value: `${context}.conversation`, optional: true },
      { name: 'documents', value: `${context}.documents`, optional: true },
      { name: 'template', value: `${context}.step_templates.${step.id}` },
    ],
  });
}

function buildOrchestratorWorkflow(steps) {
  const workflowId = 'govchat-beleidskompas-orchestrator';
  const agentName = 'AI Agent Orchestrator';

  // What earlier nodes returned, for nodes further on.
  const request = outputOf('Verzoek voorbereiden');
  const context = outputOf('Gegevens voor de agents klaarzetten');
  const answer = outputOf('Antwoord opbouwen');

  const live = outputOf('Template ophalen');

  // The steps that have an agent. A step of the template without one cannot
  // be asked.
  const stepIds = [];
  for (const step of steps) {
    stepIds.push(step.id);
  }

  const nodes = [];
  const connections = {};

  // --- The request comes in ---

  nodes.push(webhookNode('Webhook Orchestrator', at(0, 3), { urlPath: 'beleidskompas-orchestrator', workflowId }));

  nodes.push(
    codeNode('Verzoek voorbereiden', at(1, 3), {
      constants: {
        REQUEST_META_LABEL: shared.REQUEST_META_LABEL,
        TITLE_REQUEST_MARKER: shared.TITLE_REQUEST_MARKER,
        MESSAGES: orchestrator.MESSAGES,
      },
      functions: ['extractSuppliedToken', 'parsePageMessage', 'isTitleRequest', 'extractConvoUserText', 'incomingMessage', 'failure', 'prepareRequest'],
      run: [
        'return [{ json: prepareRequest({',
        '  body: $json.body,',
        '  headers: $json.headers,',
        '  env: {',
        '    N8N_WEBHOOK_TOKEN: $env.N8N_WEBHOOK_TOKEN,',
        '    BELEIDSKOMPAS_STORE_URL: $env.BELEIDSKOMPAS_STORE_URL,',
        '    BELEIDSKOMPAS_STORE_TOKEN: $env.BELEIDSKOMPAS_STORE_TOKEN,',
        '  },',
        '  now: Date.now(),',
        '}) }];',
      ].join('\n'),
    }),
  );

  nodes.push(ifNode('Verzoek geldig?', at(2, 3), '$json.ok === true'));
  nodes.push(templateNode('Template ophalen', at(3, 3)));
  nodes.push(ifNode('Titelverzoek?', at(4, 3), `${request}.kind === 'title'`));

  connect(connections, 'Webhook Orchestrator', 'Verzoek voorbereiden');
  connect(connections, 'Verzoek voorbereiden', 'Verzoek geldig?');
  connectIf(connections, 'Verzoek geldig?', { whenTrue: 'Template ophalen', whenFalse: 'Respond Orchestrator' });
  connect(connections, 'Template ophalen', 'Titelverzoek?');
  connectIf(connections, 'Titelverzoek?', { whenTrue: 'Titel maken', whenFalse: 'Stand van de casus ophalen' });

  // --- LibreChat asks for a title for the conversation ---

  nodes.push(
    llmChainNode('Titel maken', at(5, 0), {
      prompt: expression(`${request}.title_source`),
      systemPrompt: orchestrator.TITLE_SYSTEM_PROMPT,
    }),
  );
  // A title is also made when the template could not be read.
  nodes.push(chatModelNode('OpenAI Chat Model (Titel)', at(5, 1), expression(`(${live}.settings || {}).default_model || 'govchat-default'`)));

  nodes.push(
    codeNode('Titel opbouwen', at(7, 0), {
      constants: { TITLE_REQUEST_MARKER: shared.TITLE_REQUEST_MARKER },
      functions: ['nodeError', 'buildFallbackTitle', 'buildTitle'],
      run: `return [{ json: buildTitle({ request: ${request}, reply: $json }) }];`,
    }),
  );

  nodes.push(
    storeNode('Titel opslaan', at(8, 0), {
      method: 'PUT',
      caseId: '$json.case_id',
      casePath: '/title',
      body: { user_id: '$json.user_id', title: '$json.answer' },
    }),
  );

  nodes.push(respondNode('Respond titel', at(9, 0), outputOf('Titel opbouwen')));

  attachToAgent(connections, 'ai_languageModel', 'OpenAI Chat Model (Titel)', 'Titel maken');
  connect(connections, 'Titel maken', 'Titel opbouwen');
  connect(connections, 'Titel opbouwen', 'Titel opslaan');
  connect(connections, 'Titel opslaan', 'Respond titel');

  // --- Before the orchestrator: read and write the store ---

  nodes.push(readStateNode('Stand van de casus ophalen', at(5, 3), request));

  nodes.push(
    codeNode('Gegevens voor de agents klaarzetten', at(6, 3), {
      constants: {
        MESSAGES: orchestrator.MESSAGES,
        STEP_IDS: stepIds,
      },
      functions: ['nodeError', 'failure', 'stepFromTemplate', 'stepToolName', 'buildOrchestratorPrompt', 'buildContext'],
      run: `return [{ json: buildContext({ request: ${request}, state: $json, live: ${live}, stepIds: STEP_IDS }) }];`,
    }),
  );

  nodes.push(ifNode('Gegevens klaargezet?', at(7, 3), '$json.ok === true'));
  nodes.push(ifNode('Getypt bericht?', at(8, 3), "$json.kind === 'message'"));

  nodes.push(
    storeNode('Bericht van de gebruiker opslaan', at(9, 2), {
      method: 'POST',
      caseId: '$json.case_id',
      casePath: '/turns',
      body: { user_id: '$json.user_id', role: "'user'", asked_from: '$json.substep_id || null', text: '$json.message' },
    }),
  );

  nodes.push(ifNode('Bericht opgeslagen?', at(10, 2), '!$json.error'));

  nodes.push(
    codeNode('Opslagfout melden', at(11, 1), {
      constants: { MESSAGES: orchestrator.MESSAGES },
      functions: ['nodeError', 'failure', 'userTurnFailure'],
      run: 'return [{ json: userTurnFailure({ saved: $json }) }];',
    }),
  );

  connect(connections, 'Stand van de casus ophalen', 'Gegevens voor de agents klaarzetten');
  connect(connections, 'Gegevens voor de agents klaarzetten', 'Gegevens klaargezet?');
  connectIf(connections, 'Gegevens klaargezet?', { whenTrue: 'Getypt bericht?', whenFalse: 'Respond Orchestrator' });
  connectIf(connections, 'Getypt bericht?', { whenTrue: 'Bericht van de gebruiker opslaan', whenFalse: agentName });
  connect(connections, 'Bericht van de gebruiker opslaan', 'Bericht opgeslagen?');
  connectIf(connections, 'Bericht opgeslagen?', { whenTrue: agentName, whenFalse: 'Opslagfout melden' });
  connect(connections, 'Opslagfout melden', 'Respond Orchestrator');

  // --- The orchestrator, with one tool per step ---

  nodes.push(
    agentNode(agentName, at(11, 3), {
      prompt: expression(`${context}.prompt`),
      systemPrompt: expression(`${context}.system_prompt`),
      maxIterations: 8,
    }),
  );
  nodes.push(chatModelNode('OpenAI Chat Model (Orchestrator)', at(11, 4), expression(`${context}.model`)));
  attachToAgent(connections, 'ai_languageModel', 'OpenAI Chat Model (Orchestrator)', agentName);

  let toolColumn = 12;
  for (const step of steps) {
    const tool = stepAgentToolNode(step, at(toolColumn, 4));
    nodes.push(tool);
    attachToAgent(connections, 'ai_tool', tool.name, agentName);
    toolColumn += 1;
  }

  // --- After the orchestrator: the answer ---

  nodes.push(
    codeNode('Antwoord opbouwen', at(toolColumn, 3), {
      constants: { MESSAGES: orchestrator.MESSAGES },
      functions: ['toolCalls', 'nodeError', 'failure', 'buildAnswer'],
      run: `return [{ json: buildAnswer({ context: ${context}, agent: $json, now: Date.now() }) }];`,
    }),
  );

  nodes.push(ifNode('Antwoord gelukt?', at(toolColumn + 1, 3), '$json.ok === true'));

  nodes.push(
    storeNode('Antwoord opslaan', at(toolColumn + 2, 2), {
      method: 'POST',
      caseId: '$json.case_id',
      casePath: '/turns',
      body: { user_id: '$json.user_id', role: "'assistant'", step_id: '$json.step_id', asked_from: '$json.asked_from', text: '$json.text' },
    }),
  );

  nodes.push(
    codeNode('Antwoord afronden', at(toolColumn + 3, 2), {
      constants: { MESSAGES: orchestrator.MESSAGES },
      functions: ['nodeError', 'finishAnswer'],
      run: `return [{ json: finishAnswer({ answer: ${answer}, saveError: nodeError($json) }) }];`,
    }),
  );

  nodes.push(respondNode('Respond Orchestrator', at(toolColumn + 4, 3), '$json'));

  connect(connections, agentName, 'Antwoord opbouwen');
  connect(connections, 'Antwoord opbouwen', 'Antwoord gelukt?');
  connectIf(connections, 'Antwoord gelukt?', { whenTrue: 'Antwoord opslaan', whenFalse: 'Respond Orchestrator' });
  connect(connections, 'Antwoord opslaan', 'Antwoord afronden');
  connect(connections, 'Antwoord afronden', 'Respond Orchestrator');

  return makeWorkflow({ id: workflowId, name: 'Beleidskompas - Orchestrator', active: true, nodes, connections });
}

// =====================================================================
// Part 4: the list of steps for the page, and writing the files
// =====================================================================

/** What the Beleidskompas page needs to know about the steps: their ids,
 *  numbers and titles, and those of their substeps. */
function pageSteps(steps) {
  const list = [];
  for (const step of steps) {
    const substeps = [];
    for (const substep of step.substeps) {
      substeps.push({ id: substep.id, title: substep.title });
    }
    list.push({ id: step.id, nr: step.nr, title: step.title, substeps });
  }
  return { steps: list };
}

/** Every file this script writes, with what goes in it. */
function buildAll() {
  const files = [];

  files.push({
    path: path.join(WORKFLOWS_DIR, 'beleidskompas-orchestrator.json'),
    data: buildOrchestratorWorkflow(STEPS),
  });

  for (const step of STEPS) {
    files.push({
      path: path.join(WORKFLOWS_DIR, `beleidskompas-agent-${step.id}.json`),
      data: buildStepAgentWorkflow(step),
    });
  }

  files.push({ path: PAGE_STEPS_FILE, data: pageSteps(STEPS) });
  files.push({ path: ADMIN_DEFAULTS_FILE, data: template.DEFAULT_TEMPLATE });

  return files;
}

function main() {
  for (const file of buildAll()) {
    fs.writeFileSync(file.path, JSON.stringify(file.data, null, 2) + '\n', 'utf-8');
    console.log(`Wrote ${path.relative(process.cwd(), file.path)}`);
  }
}

module.exports = { STEPS, STEP_AGENT_INPUTS, buildOrchestratorWorkflow, buildStepAgentWorkflow, buildAll };

if (require.main === module) {
  main();
}
