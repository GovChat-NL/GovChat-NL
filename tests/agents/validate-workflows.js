#!/usr/bin/env node
'use strict';

const path = require('path');
const { discoverWorkflows, getTopdeskBaseUrl, renderWorkflowTemplate } = require('../../n8n/bootstrap');

const workflowsDir = path.resolve(__dirname, '../../agents/n8n/workflows');
const workflows = discoverWorkflows(workflowsDir);
const workflowIds = workflows.flatMap((entry) => entry.ids);
const inactiveWorkflowIds = workflows.flatMap((entry) => entry.inactiveIds || []);
if (new Set(workflowIds).size !== workflowIds.length) {
  throw new Error('Discovered workflow IDs are not unique');
}
if (workflowIds.some((id) => id.length > 36)) {
  throw new Error('A workflow ID exceeds the n8n/Postgres 36-character limit');
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const readWorkflow = (file) => JSON.parse(require('fs').readFileSync(path.join(workflowsDir, file), 'utf8'));
const nodeByName = (workflow, name) => workflow.nodes.find((node) => node.name === name);
const ingest = readWorkflow('topdesk-knowledge-items-ingest.json');
const search = readWorkflow('topdesk-knowledge-items-search.json');

assert(ingest.active === false && search.active === false, 'TOPdesk workflows must remain inactive until configured');
assert(inactiveWorkflowIds.includes(ingest.id) && inactiveWorkflowIds.includes(search.id), 'Bootstrap must preserve TOPdesk inactive defaults');
assert(nodeByName(ingest, '1. Configuration (edit after import)'), 'TOPdesk ingest configuration node is missing');
assert(nodeByName(ingest, 'Run with parameters'), 'TOPdesk ingest runtime parameter trigger is missing');
assert(nodeByName(ingest, 'Run with parameters').parameters.workflowInputs.values.some((value) => value.name === 'root_knowledge_item_id'), 'TOPdesk parent ID input is missing');
assert(nodeByName(ingest, 'Run with parameters').parameters.workflowInputs.values.some((value) => value.name === 'include_attachments'), 'TOPdesk attachment toggle input is missing');
assert(nodeByName(ingest, '2. Fetch child knowledge items'), 'TOPdesk item-fetch node is missing');
assert(nodeByName(ingest, '7b. Extract attachment text (Apache Tika)'), 'Tika attachment extraction node is missing');
assert(nodeByName(ingest, '7a. Upsert article in Qdrant'), 'Qdrant article upsert node is missing');
assert(nodeByName(search, 'Execute Workflow Trigger'), 'TOPdesk search must be callable as a subworkflow');
assert(nodeByName(search, '4. Search Qdrant'), 'TOPdesk Qdrant search node is missing');
assert(nodeByName(search, '5. Return ranked sources'), 'TOPdesk search result formatter is missing');
assert(getTopdeskBaseUrl({ TOPDESK_TENANT: 'prvlimburg', TOPDESK_BASE_DOMAIN: 'topdesk.net' }) === 'https://prvlimburg.topdesk.net', 'TOPdesk tenant URL is not assembled from environment settings');
assert(getTopdeskBaseUrl({ TOPDESK_TENANT: '', TOPDESK_BASE_DOMAIN: 'topdesk.net' }) === '', 'Missing TOPdesk tenant should not produce an organization URL');
assert(!JSON.stringify(ingest).includes('prvlimburg') && !JSON.stringify(ingest).includes('example.org'), 'TOPdesk organization URL must not be hardcoded in the workflow template');
const renderedIngest = JSON.parse(renderWorkflowTemplate(require('fs').readFileSync(path.join(workflowsDir, 'topdesk-knowledge-items-ingest.json'), 'utf8'), {
  TOPDESK_TENANT: 'example',
  TOPDESK_BASE_DOMAIN: 'service.example',
  TOPDESK_PUBLIC_BASE_URL: 'https://portal.example/knowledge',
}));
const renderedConfig = nodeByName(renderedIngest, '1. Configuration (edit after import)').parameters.jsCode;
assert(renderedConfig.includes("topdeskBaseUrl:'https://example.service.example'"), 'TOPdesk API base URL placeholder was not rendered');
assert(renderedConfig.includes("publicKnowledgeItemUrl:'https://portal.example/knowledge'"), 'TOPdesk public base URL placeholder was not rendered');

for (const workflow of [ingest, search]) {
  const names = new Set(workflow.nodes.map((node) => node.name));
  const ids = new Set(workflow.nodes.map((node) => node.id));
  assert(names.size === workflow.nodes.length, `${workflow.name} has duplicate node names`);
  assert(ids.size === workflow.nodes.length, `${workflow.name} has duplicate node ids`);
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.code') {
      try {
        // Catch syntax errors in embedded JavaScript before importing into n8n.
        new Function(node.parameters.jsCode);
      } catch (error) {
        throw new Error(`${workflow.name} has invalid JavaScript in node "${node.name}": ${error.message}`);
      }
    }
  }
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    assert(names.has(source), `${workflow.name} connection source is unknown: ${source}`);
    for (const output of outputs.main || []) {
      for (const edge of output || []) assert(names.has(edge.node), `${workflow.name} connection target is unknown: ${edge.node}`);
    }
  }
  const serialized = JSON.stringify(workflow);
  assert(!/(?:sk-[A-Za-z0-9]{12,}|password\s*[:=]\s*['"][^'"]+['"])/i.test(serialized), `${workflow.name} appears to contain a hardcoded secret`);
}

for (const workflow of workflows) console.log(`[PASS] ${workflow.file}`);
console.log(`Validated ${workflows.length} discovered workflow export(s); ${workflowIds.length} unique workflow ID(s).`);
console.log('[PASS] TOPdesk ingest/search structure, inactive defaults, connection references, and secret hygiene');
