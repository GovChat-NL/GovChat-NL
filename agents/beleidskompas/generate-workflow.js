#!/usr/bin/env node
'use strict';

/**
 * Generates n8n/workflows/beleidskompas/beleidskompas-step-stap1.json from logic.js.
 *
 * Every function in logic.js is inlined into the workflow's single Code node
 * via Function.prototype.toString(), so the JS that runs inside n8n is
 * byte-for-byte the same code exercised by logic.test.js. Re-run this script
 * after editing logic.js or the fixtures, then re-import/publish the workflow
 * in n8n (or restart n8n-bootstrap with AGENTS_BOOTSTRAP_FORCE=true).
 *
 * Usage: node generate-workflow.js
 */

const fs = require('node:fs');
const path = require('node:path');
const logic = require('./logic');

const FUNCTION_NAMES = [
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

function buildJsCode() {
  const functionSources = FUNCTION_NAMES.map((name) => {
    const fn = logic[name];
    if (typeof fn !== 'function') throw new Error(`logic.js does not export a function named "${name}"`);
    return fn.toString();
  }).join('\n\n');

  return [
    `const DISCLAIMER = ${JSON.stringify(logic.DISCLAIMER)};`,
    `const CITATIONS_META_MARKER = ${JSON.stringify(logic.CITATIONS_META_MARKER)};`,
    `const CITATIONS_META_LABEL = ${JSON.stringify(logic.CITATIONS_META_LABEL)};`,
    `const TITLE_REQUEST_MARKER = ${JSON.stringify(logic.TITLE_REQUEST_MARKER)};`,
    `const TITLE_PREFIX = ${JSON.stringify(logic.TITLE_PREFIX)};`,
    '',
    functionSources,
    '',
    `const PASSAGES = ${JSON.stringify(passages)};`,
    `const SOURCES = ${JSON.stringify(DEFAULT_SOURCES)};`,
    '',
    'const httpModule = require(\'http\');',
    'const httpsModule = require(\'https\');',
    'const urlModule = require(\'url\');',
    '',
    'const result = await runStep1({',
    '  input: $json,',
    '  env: {',
    '    N8N_WEBHOOK_TOKEN: $env.N8N_WEBHOOK_TOKEN,',
    '    BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN: $env.BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN,',
    '    LITELLM_URL: $env.LITELLM_URL,',
    '    LITELLM_API_KEY: $env.LITELLM_API_KEY,',
    '    OPENAI_API_KEY: $env.OPENAI_API_KEY,',
    '    BELEIDSKOMPAS_MODEL: $env.BELEIDSKOMPAS_MODEL,',
    '  },',
    '  sources: SOURCES,',
    '  passages: PASSAGES,',
    '  fetchImpl: typeof fetch === \'function\' ? fetch : null,',
    '  httpModule,',
    '  httpsModule,',
    '  urlModule,',
    '});',
    '',
    'return [{ json: result }];',
  ].join('\n');
}

function buildWorkflow() {
  return [
    {
      id: 'govchat-beleidskompas-step-stap1',
      name: 'Beleidskompas Specialist - Stap 1',
      active: true,
      isArchived: false,
      nodes: [
        {
          parameters: {
            httpMethod: 'POST',
            path: 'beleidskompas-step-stap1',
            responseMode: 'responseNode',
            options: {},
          },
          id: 'WebhookStep1',
          name: 'Webhook Step 1',
          type: 'n8n-nodes-base.webhook',
          typeVersion: 2,
          webhookId: 'govchat-beleidskompas-step-stap1',
          position: [-620, 220],
        },
        {
          parameters: {
            jsCode: buildJsCode(),
          },
          id: 'BuildStep1Answer',
          name: 'Build Step 1 Answer',
          type: 'n8n-nodes-base.code',
          typeVersion: 2,
          position: [-340, 220],
        },
        {
          parameters: {
            respondWith: 'json',
            responseBody: '={{ JSON.stringify($json) }}',
            options: {},
          },
          id: 'RespondStep1',
          name: 'Respond Step 1',
          type: 'n8n-nodes-base.respondToWebhook',
          typeVersion: 1,
          position: [-80, 220],
        },
      ],
      connections: {
        'Webhook Step 1': { main: [[{ node: 'Build Step 1 Answer', type: 'main', index: 0 }]] },
        'Build Step 1 Answer': { main: [[{ node: 'Respond Step 1', type: 'main', index: 0 }]] },
      },
      settings: { executionOrder: 'v1' },
    },
  ];
}

function main() {
  const outPath = path.join(__dirname, '..', 'n8n', 'workflows', 'beleidskompas', 'beleidskompas-step-stap1.json');
  const workflow = buildWorkflow();
  fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}

main();
