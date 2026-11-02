#!/usr/bin/env node
'use strict';

/**
 * Writes the Beleidskompas workflows in n8n/workflows/beleidskompas/ from
 * the source files in this folder:
 *
 * - beleidskompas-hoofdagent.json from main-agent.js
 * - beleidskompas-step-stap1.json from logic.js and the fixtures
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
const logic = require('./logic');
const mainAgent = require('./main-agent');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'n8n', 'workflows', 'beleidskompas');

const passages = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'source-passages.json'), 'utf-8'),
).passages;

const DEFAULT_SOURCES = [
  'SiS 4.0 Strategisch kader',
  'SiS 4.0 Uitvoeringskader',
  'Provinciale Instrumentenkoffer',
  'Coalitieakkoord en beleidskaders',
  'Overzicht wettelijke taken Provincie',
];

/** The source text of the named functions of a module, one after another. */
function inlineFunctions(moduleObj, moduleName, names) {
  return names
    .map((name) => {
      const fn = moduleObj[name];
      if (typeof fn !== 'function') throw new Error(`${moduleName} does not export a function named "${name}"`);
      return fn.toString();
    })
    .join('\n\n');
}

/** The settings a Code node reads from n8n's `$env`, as the text of an
 *  object literal. */
function envLiteral(names) {
  return ['{', ...names.map((name) => `    ${name}: $env.${name},`), '  }'].join('\n');
}

const TITLE_CONSTANTS = [
  `const TITLE_REQUEST_MARKER = ${JSON.stringify(logic.TITLE_REQUEST_MARKER)};`,
  `const TITLE_PREFIX = ${JSON.stringify(logic.TITLE_PREFIX)};`,
];

// What every Code node needs to send HTTP: n8n's `fetch` when it exists,
// otherwise Node's own modules.
const HTTP_MODULES = ["const httpModule = require('http');", "const httpsModule = require('https');", "const urlModule = require('url');"];
const HTTP_ARGS = ["  fetchImpl: typeof fetch === 'function' ? fetch : null,", '  httpModule,', '  httpsModule,', '  urlModule,'];

/** Every Beleidskompas workflow has the same three nodes: a Webhook node
 *  that receives the request, a Code node that does the work and a Respond
 *  to Webhook node that returns the result as JSON. */
function buildWorkflow({ id, name, webhookPath, nodeLabel, jsCode }) {
  const webhookName = `Webhook ${nodeLabel}`;
  const codeName = `Build ${nodeLabel} Answer`;
  const respondName = `Respond ${nodeLabel}`;
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

// --- Hoofdagent ---

// The functions main-agent.js borrows from logic.js, and the ones those use.
const MAIN_AGENT_LOGIC_FUNCTIONS = [
  'extractSuppliedToken',
  'requestRaw',
  'callLiteLLM',
  'isTitleRequest',
  'buildFallbackTitle',
  'extractConvoCaseText',
  'buildTitleResponse',
];

const MAIN_AGENT_FUNCTIONS = ['parseStepFromMessage', 'determineStep', 'forwardToStep', 'runMainAgent'];

function buildMainAgentJsCode() {
  return [
    ...TITLE_CONSTANTS,
    `const STEP_ROUTES = ${JSON.stringify(mainAgent.STEP_ROUTES)};`,
    `const UNKNOWN_STEP_TEXT = ${JSON.stringify(mainAgent.UNKNOWN_STEP_TEXT)};`,
    '',
    inlineFunctions(logic, 'logic.js', MAIN_AGENT_LOGIC_FUNCTIONS),
    '',
    inlineFunctions(mainAgent, 'main-agent.js', MAIN_AGENT_FUNCTIONS),
    '',
    ...HTTP_MODULES,
    '',
    'const result = await runMainAgent({',
    '  input: $json,',
    `  env: ${envLiteral([
      'N8N_WEBHOOK_TOKEN',
      'BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN',
      'BELEIDSKOMPAS_N8N_BASE_URL',
      'LITELLM_URL',
      'LITELLM_API_KEY',
      'OPENAI_API_KEY',
      'BELEIDSKOMPAS_MODEL',
    ])},`,
    ...HTTP_ARGS,
    '});',
    '',
    'return [{ json: result }];',
  ].join('\n');
}

function buildMainAgentWorkflow() {
  return buildWorkflow({
    id: 'govchat-beleidskompas-hoofdagent',
    name: 'Beleidskompas Hoofdagent',
    webhookPath: 'beleidskompas-hoofdagent',
    nodeLabel: 'Hoofdagent',
    jsCode: buildMainAgentJsCode(),
  });
}

// --- Stap 1 ---

const STEP1_FUNCTIONS = [
  'extractSuppliedToken',
  'tokenizePolicyText',
  'selectSources',
  'detectMissingInfo',
  'buildSystemPrompt',
  'buildUserPrompt',
  'parseAgentJson',
  'buildDemoFallbackStructured',
  'composeAnswerText',
  'appendCitationsMetaBlock',
  'requestRaw',
  'callLiteLLM',
  'isTitleRequest',
  'buildFallbackTitle',
  'extractConvoCaseText',
  'buildTitleResponse',
  'runStep1',
];

function buildStep1JsCode() {
  return [
    `const DISCLAIMER = ${JSON.stringify(logic.DISCLAIMER)};`,
    `const CITATIONS_META_MARKER = ${JSON.stringify(logic.CITATIONS_META_MARKER)};`,
    `const CITATIONS_META_LABEL = ${JSON.stringify(logic.CITATIONS_META_LABEL)};`,
    ...TITLE_CONSTANTS,
    '',
    inlineFunctions(logic, 'logic.js', STEP1_FUNCTIONS),
    '',
    `const PASSAGES = ${JSON.stringify(passages)};`,
    `const SOURCES = ${JSON.stringify(DEFAULT_SOURCES)};`,
    '',
    ...HTTP_MODULES,
    '',
    'const result = await runStep1({',
    '  input: $json,',
    `  env: ${envLiteral([
      'N8N_WEBHOOK_TOKEN',
      'BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN',
      'LITELLM_URL',
      'LITELLM_API_KEY',
      'OPENAI_API_KEY',
      'BELEIDSKOMPAS_MODEL',
    ])},`,
    '  sources: SOURCES,',
    '  passages: PASSAGES,',
    ...HTTP_ARGS,
    '});',
    '',
    'return [{ json: result }];',
  ].join('\n');
}

function buildStep1Workflow() {
  return buildWorkflow({
    id: 'govchat-beleidskompas-step-stap1',
    name: 'Beleidskompas Specialist - Stap 1',
    webhookPath: 'beleidskompas-step-stap1',
    nodeLabel: 'Step 1',
    jsCode: buildStep1JsCode(),
  });
}

function writeWorkflow(fileName, workflow) {
  const outPath = path.join(WORKFLOWS_DIR, fileName);
  fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}

function main() {
  writeWorkflow('beleidskompas-hoofdagent.json', buildMainAgentWorkflow());
  writeWorkflow('beleidskompas-step-stap1.json', buildStep1Workflow());
}

main();
