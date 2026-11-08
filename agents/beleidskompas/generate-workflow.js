#!/usr/bin/env node
'use strict';

/**
 * Writes the Beleidskompas workflows in n8n/workflows/beleidskompas/ from
 * the source files in this folder:
 *
 * - beleidskompas-orchestrator.json from orchestrator.js and store-client.js
 * - beleidskompas-step-stapN.json from steps/stepN.js and the fixtures
 *
 * All of them also get the functions they use from shared.js.
 *
 * n8n cannot read these source files; it only reads workflow JSON, in which
 * the code of a Code node is plain text. So this script copies the source of
 * every function needed (Function.prototype.toString) into that text, which
 * makes the code that runs in n8n the same code as in the source files.
 * Re-run after editing the source, then reload the workflows in n8n
 * (`make reload-workflows`).
 *
 * Usage: node generate-workflow.js
 */

const fs = require('node:fs');
const path = require('node:path');
const shared = require('./shared');
const orchestrator = require('./orchestrator');
const storeClient = require('./store-client');
const step1 = require('./steps/step1');
const step2 = require('./steps/step2');
const step3 = require('./steps/step3');
const step4 = require('./steps/step4');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'n8n', 'workflows', 'beleidskompas');

const passages = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'source-passages.json'), 'utf-8'),
).passages;

/** The source text of the named functions, one after another, each taken
 *  from the first of `modules` that exports it. */
function inlineFunctions(modules, names) {
  return names
    .map((name) => {
      const moduleObj = modules.find((m) => typeof m[name] === 'function');
      if (!moduleObj) throw new Error(`No module exports a function named "${name}"`);
      return moduleObj[name].toString();
    })
    .join('\n\n');
}

/** The settings a Code node reads from n8n's `$env`, as the text of an
 *  object literal. */
function envLiteral(names) {
  return ['{', ...names.map((name) => `    ${name}: $env.${name},`), '  }'].join('\n');
}

const TITLE_CONSTANTS = [
  `const TITLE_REQUEST_MARKER = ${JSON.stringify(shared.TITLE_REQUEST_MARKER)};`,
  `const TITLE_PREFIX = ${JSON.stringify(shared.TITLE_PREFIX)};`,
];

// What every Code node needs to send HTTP: n8n's `fetch` when it exists,
// otherwise Node's own modules.
const HTTP_MODULES = ["const httpModule = require('http');", "const httpsModule = require('https');", "const urlModule = require('url');"];
const HTTP_ARGS = ["  fetchImpl: typeof fetch === 'function' ? fetch : null,", '  httpModule,', '  httpsModule,', '  urlModule,'];

/** Every Beleidskompas workflow has the same three nodes: a Webhook node
 *  that receives the request, a Code node that does the work and a Respond
 *  to Webhook node that returns the result as JSON. */
function buildWorkflow({ id, name, webhookPath, nodeNames, jsCode }) {
  const { webhook: webhookName, code: codeName, respond: respondName } = nodeNames;
  return [
    {
      id,
      name,
      active: true,
      isArchived: false,
      nodes: [
        {
          parameters: { httpMethod: 'POST', path: webhookPath, responseMode: 'responseNode', options: {} },
          id: webhookName.replace(/\s+/g, ''),
          name: webhookName,
          type: 'n8n-nodes-base.webhook',
          typeVersion: 2,
          webhookId: id,
          position: [-620, 220],
        },
        {
          parameters: { jsCode },
          id: codeName.replace(/\s+/g, ''),
          name: codeName,
          type: 'n8n-nodes-base.code',
          typeVersion: 2,
          position: [-340, 220],
        },
        {
          parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} },
          id: respondName.replace(/\s+/g, ''),
          name: respondName,
          type: 'n8n-nodes-base.respondToWebhook',
          typeVersion: 1,
          position: [-80, 220],
        },
      ],
      connections: {
        [webhookName]: { main: [[{ node: codeName, type: 'main', index: 0 }]] },
        [codeName]: { main: [[{ node: respondName, type: 'main', index: 0 }]] },
      },
      settings: { executionOrder: 'v1' },
    },
  ];
}

// --- Orchestrator ---

// The step workflows: one per step definition in steps/.
const steps = [step1.STEP, step2.STEP, step3.STEP, step4.STEP];

/** What the orchestrator knows about a step: number, title, role and the
 *  substeps (titles for the model that picks a step, ids for the order of
 *  the reports). The instructions of the substeps stay out; they are for
 *  the step itself. */
function stepSummary(step) {
  return {
    id: step.id,
    nr: step.nr,
    title: step.title,
    role: step.role,
    substeps: step.substeps.map((substep) => substep.title),
    substep_ids: step.substeps.map((substep) => substep.id),
  };
}

// The functions orchestrator.js uses from shared.js, and the ones those use.
const ORCHESTRATOR_SHARED_FUNCTIONS = [
  'extractSuppliedToken',
  'parsePageMessage',
  'requestRaw',
  'callLiteLLM',
  'isTitleRequest',
  'buildFallbackTitle',
  'extractConvoCaseText',
  'buildTitleResponse',
];

const ORCHESTRATOR_FUNCTIONS = ['incomingMessage', 'determineStep', 'isPlainChatMessage', 'chooseStep', 'contextFromState', 'buildStepRequest', 'forwardToStep', 'runOrchestrator'];

function buildOrchestratorJsCode() {
  return [
    ...TITLE_CONSTANTS,
    `const PAGE_MESSAGE_LABELS = ${JSON.stringify(shared.PAGE_MESSAGE_LABELS)};`,
    `const STEP_ROUTES = ${JSON.stringify(orchestrator.STEP_ROUTES)};`,
    `const DEFAULT_STEP_ID = ${JSON.stringify(orchestrator.DEFAULT_STEP_ID)};`,
    `const UNKNOWN_STEP_TEXT = ${JSON.stringify(orchestrator.UNKNOWN_STEP_TEXT)};`,
    `const STEP_SUMMARIES = ${JSON.stringify(steps.map(stepSummary), null, 2)};`,
    `const ORCHESTRATOR_PROMPT_TEMPLATE = ${JSON.stringify(shared.ORCHESTRATOR_PROMPT_TEMPLATE)};`,
    '',
    inlineFunctions([shared], ORCHESTRATOR_SHARED_FUNCTIONS),
    '',
    inlineFunctions([storeClient], ['storeRequest', 'createStoreClient']),
    '',
    inlineFunctions([orchestrator], ORCHESTRATOR_FUNCTIONS),
    '',
    ...HTTP_MODULES,
    '',
    'const result = await runOrchestrator({',
    '  input: $json,',
    '  summaries: STEP_SUMMARIES,',
    `  env: ${envLiteral([
      'N8N_WEBHOOK_TOKEN',
      'BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN',
      'BELEIDSKOMPAS_N8N_BASE_URL',
      'LITELLM_URL',
      'LITELLM_API_KEY',
      'OPENAI_API_KEY',
      'BELEIDSKOMPAS_MODEL',
      'BELEIDSKOMPAS_STORE_URL',
      'BELEIDSKOMPAS_STORE_TOKEN',
    ])},`,
    ...HTTP_ARGS,
    '});',
    '',
    'return [{ json: result }];',
  ].join('\n');
}

function buildOrchestratorWorkflow() {
  return buildWorkflow({
    id: 'govchat-beleidskompas-orchestrator',
    name: 'Beleidskompas Orchestrator',
    webhookPath: 'beleidskompas-orchestrator',
    nodeNames: { webhook: 'Webhook Orchestrator', code: 'Route To Step', respond: 'Respond Orchestrator' },
    jsCode: buildOrchestratorJsCode(),
  });
}

// --- The steps ---

// What every step workflow's Code node needs from shared.js, in order.
const STEP_SHARED_FUNCTIONS = [
  'extractSuppliedToken',
  'tokenizePolicyText',
  'selectSources',
  'isVerdict',
  'answerFormat',
  'fillTemplate',
  'buildReportPrompt',
  'buildConversationPrompt',
  'emptyValue',
  'emptyStructured',
  'missingParts',
  'asList',
  'bullets',
  'section',
  'partText',
  'substepSections',
  'sourcesText',
  'askedStep',
  'composeAnswerText',
  'buildUserPrompt',
  'parseAgentJson',
  'appendCitationsMetaBlock',
  'requestRaw',
  'callLiteLLM',
  'runStep',
];

function buildStepJsCode(step) {
  return [
    `const DISCLAIMER = ${JSON.stringify(shared.DISCLAIMER)};`,
    `const CITATIONS_META_MARKER = ${JSON.stringify(shared.CITATIONS_META_MARKER)};`,
    `const CITATIONS_META_LABEL = ${JSON.stringify(shared.CITATIONS_META_LABEL)};`,
    `const REPORT_PROMPT_TEMPLATE = ${JSON.stringify(shared.REPORT_PROMPT_TEMPLATE)};`,
    `const CONVERSATION_PROMPT_TEMPLATE = ${JSON.stringify(shared.CONVERSATION_PROMPT_TEMPLATE)};`,
    `const COMMON_RULES = ${JSON.stringify(shared.COMMON_RULES)};`,
    '',
    inlineFunctions([shared], STEP_SHARED_FUNCTIONS),
    '',
    // The step definition is data, so it goes in as JSON.
    `const STEP = ${JSON.stringify(step, null, 2)};`,
    '',
    `const PASSAGES = ${JSON.stringify(passages)};`,
    '',
    ...HTTP_MODULES,
    '',
    'const result = await runStep(STEP, {',
    '  input: $json,',
    `  env: ${envLiteral([
      'N8N_WEBHOOK_TOKEN',
      'BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN',
      'LITELLM_URL',
      'LITELLM_API_KEY',
      'OPENAI_API_KEY',
      'BELEIDSKOMPAS_MODEL',
    ])},`,
    '  passages: PASSAGES,',
    ...HTTP_ARGS,
    '});',
    '',
    'return [{ json: result }];',
  ].join('\n');
}

function buildStepWorkflow(step) {
  return buildWorkflow({
    id: `govchat-beleidskompas-step-${step.id}`,
    name: `Beleidskompas Specialist - Stap ${step.nr}`,
    webhookPath: `beleidskompas-step-${step.id}`,
    nodeNames: {
      webhook: `Webhook Step ${step.nr}`,
      code: `Build Step ${step.nr} Answer`,
      respond: `Respond Step ${step.nr}`,
    },
    jsCode: buildStepJsCode(step),
  });
}

// What the Beleidskompas page needs to know about the steps: ids, numbers,
// titles and substeps, without the prompt texts. Written next to the page,
// so the page and the workflows share one list of steps.
//
// TODO: once the admin environment holds the prompts, it should serve this
// list itself (same shape, from the same source as the prompts), and this
// file goes.
const PAGE_STEPS_FILE = path.join(__dirname, '..', '..', 'overlay', 'src', 'apps', 'beleidskompas', 'steps.json');

function pageSteps(stepDefinitions) {
  return {
    steps: stepDefinitions.map((step) => ({
      id: step.id,
      nr: step.nr,
      title: step.title,
      substeps: step.substeps.map((substep) => ({ id: substep.id, title: substep.title })),
    })),
  };
}

function writeJson(outPath, data) {
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}

function main() {
  writeJson(path.join(WORKFLOWS_DIR, 'beleidskompas-orchestrator.json'), buildOrchestratorWorkflow());
  for (const step of steps) writeJson(path.join(WORKFLOWS_DIR, `beleidskompas-step-${step.id}.json`), buildStepWorkflow(step));
  writeJson(PAGE_STEPS_FILE, pageSteps(steps));
}

main();
