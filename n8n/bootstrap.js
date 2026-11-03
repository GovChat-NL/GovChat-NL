#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const N8N_URL = 'http://n8n:5678';
const WORKFLOWS_DIR = String(
  process.env.AGENTS_LOCAL_WORKFLOWS_DIR || '/workspace/agents/n8n/workflows',
).trim();
const MARKER_FILE = '/home/node/.n8n/.govchat-seeded-v6';

function runN8n(args) {
  execFileSync('n8n', args, { stdio: 'inherit' });
}

async function waitForSettings(maxRetries = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(`${N8N_URL}/rest/settings`);
      if (response.ok) return response.json();
    } catch {
      // n8n may need time to finish booting.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('n8n /rest/settings bleef onbereikbaar tijdens owner bootstrap');
}

async function loginCheck(email, password) {
  const response = await fetch(`${N8N_URL}/rest/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emailOrLdapLoginId: email, password }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`n8n owner-login check mislukt voor ${email} (status ${response.status}): ${body}`);
  }
}

async function setupOwner(email, password, firstName, lastName) {
  const response = await fetch(`${N8N_URL}/rest/owner/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, firstName, lastName, password }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`n8n owner setup mislukt (status ${response.status}): ${body}`);
  }

  const settings = await waitForSettings();
  if (Boolean(settings?.data?.userManagement?.showSetupOnFirstLoad)) {
    throw new Error('Owner setup leek gelukt, maar n8n geeft nog steeds setup-scherm terug');
  }
}

async function ensureOwner() {
  const email = String(process.env.N8N_OWNER_EMAIL || '').trim();
  const password = String(process.env.N8N_OWNER_PASSWORD || '');
  const firstName = String(process.env.N8N_OWNER_FIRST_NAME || 'GovChat').trim();
  const lastName = String(process.env.N8N_OWNER_LAST_NAME || 'Admin').trim();
  const enforceOwner = String(process.env.N8N_OWNER_ENFORCE || 'true').trim().toLowerCase() === 'true';

  if (!email || !password) {
    console.log('[bootstrap] N8N owner bootstrap overgeslagen (N8N_OWNER_EMAIL/N8N_OWNER_PASSWORD leeg)');
    return;
  }

  const settings = await waitForSettings();
  const showSetup = Boolean(settings?.data?.userManagement?.showSetupOnFirstLoad);
  if (showSetup) {
    await setupOwner(email, password, firstName, lastName);
  } else {
    try {
      await loginCheck(email, password);
    } catch (error) {
      if (!enforceOwner) throw error;
      console.log(`[bootstrap] Bestaande owner komt niet overeen met .env credentials; reset user-management en provision owner opnieuw`);
      runN8n(['user-management:reset']);
      await setupOwner(email, password, firstName, lastName);
    }
  }

  await loginCheck(email, password);
  console.log(`[bootstrap] N8N owner-login check geslaagd voor ${email}`);
}

function importLiteLLMCredential() {
  const apiKey = String(process.env.LITELLM_API_KEY || '');
  const baseUrl = String(process.env.LITELLM_URL || '').replace(/\/$/, '');
  if (!apiKey) throw new Error("LITELLM_API_KEY ontbreekt; kan n8n credential niet bootstrap'en");
  if (!baseUrl) throw new Error("LITELLM_URL ontbreekt; kan n8n credential niet bootstrap'en");

  const credentialPath = '/tmp/litellm-openai-credential.json';
  fs.writeFileSync(
    credentialPath,
    JSON.stringify([
      {
        id: '00000000-0000-4000-8000-000000000111',
        name: 'LiteLLM API',
        type: 'openAiApi',
        data: { apiKey, url: `${baseUrl}/v1` },
      },
    ]),
    { mode: 0o600 },
  );
  runN8n([`import:credentials`, `--input=${credentialPath}`]);
}

function buildTopdeskCredential(env = process.env) {
  const username = String(env.TOPDESK_API_USERNAME || '').trim();
  const password = String(env.TOPDESK_API_PASSWORD || '');
  if (!username && !password) {
    return null;
  }
  if (!username || !password) {
    throw new Error('TOPDESK_API_USERNAME en TOPDESK_API_PASSWORD moeten beide ingesteld zijn');
  }

  return {
    id: '00000000-0000-4000-8000-000000000222',
    name: 'TOPdesk API - Knowledge Items',
    type: 'httpBasicAuth',
    data: { user: username, password },
  };
}

function importTopdeskCredential() {
  const credential = buildTopdeskCredential();
  if (!credential) {
    console.log('[bootstrap] TOPdesk credential bootstrap overgeslagen (TOPDESK_API_USERNAME/TOPDESK_API_PASSWORD leeg)');
    return false;
  }

  const credentialPath = '/tmp/topdesk-basic-auth-credential.json';
  fs.writeFileSync(credentialPath, JSON.stringify([credential]), { mode: 0o600 });
  try {
    runN8n([`import:credentials`, `--input=${credentialPath}`]);
  } finally {
    fs.rmSync(credentialPath, { force: true });
  }
  console.log('[bootstrap] TOPdesk HTTP Basic Auth credential geïmporteerd');
  return true;
}

function discoverWorkflows(workflowsDir = WORKFLOWS_DIR) {
  if (!fs.existsSync(workflowsDir)) throw new Error(`Workflow directory ontbreekt: ${workflowsDir}`);

  const files = fs
    .readdirSync(workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) throw new Error(`Geen workflow-JSON-bestanden gevonden in ${workflowsDir}`);

  const ids = new Set();
  return files.map((file) => {
    const fullPath = path.join(workflowsDir, file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (error) {
      throw new Error(`Ongeldige workflow-JSON in ${file}: ${error.message}`);
    }

    const workflows = Array.isArray(parsed) ? parsed : [parsed];
    if (!workflows.length || workflows.some((workflow) => !workflow || !Array.isArray(workflow.nodes))) {
      throw new Error(`${file} bevat geen geldige n8n workflow(s) met een nodes-array`);
    }

    for (const workflow of workflows) {
      const id = String(workflow.id || '').trim();
      if (!id) throw new Error(`Workflow in ${file} mist een stabiele id`);
      if (ids.has(id)) throw new Error(`Dubbele workflow-id "${id}" aangetroffen in ${file}`);
      ids.add(id);
    }

    return {
      file,
      fullPath,
      ids: workflows.map((workflow) => String(workflow.id).trim()),
      inactiveIds: workflows
        .filter((workflow) => workflow.active !== true)
        .map((workflow) => String(workflow.id).trim()),
    };
  });
}

function getTopdeskBaseUrl(env = process.env) {
  const tenant = String(env.TOPDESK_TENANT || '').trim().toLowerCase();
  const domain = String(env.TOPDESK_BASE_DOMAIN || 'topdesk.net').trim().toLowerCase();
  if (!tenant) return '';
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(tenant)) {
    throw new Error('TOPDESK_TENANT moet een geldige tenant-subdomain zijn');
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain)) {
    throw new Error('TOPDESK_BASE_DOMAIN moet een domeinnaam zonder protocol of pad zijn');
  }
  return `https://${tenant}.${domain}`;
}

function renderWorkflowTemplate(content, env = process.env) {
  const publicBaseUrl = String(env.TOPDESK_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (publicBaseUrl) {
    let parsedUrl;
    try {
      parsedUrl = new URL(publicBaseUrl);
    } catch {
      throw new Error('TOPDESK_PUBLIC_BASE_URL moet een geldige absolute URL zijn');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || /['"\\\s<>]/.test(publicBaseUrl)) {
      throw new Error('TOPDESK_PUBLIC_BASE_URL moet een HTTP(S)-URL zonder quotes of witruimte zijn');
  }
  }
  const template = JSON.parse(String(content));
  const replacements = {
    __TOPDESK_BASE_URL__: getTopdeskBaseUrl(env),
    __TOPDESK_PUBLIC_BASE_URL__: publicBaseUrl,
  };
  const replaceValues = (value) => {
    if (typeof value === 'string') {
      return Object.entries(replacements).reduce((result, [placeholder, replacement]) => result.replaceAll(placeholder, replacement), value);
    }
    if (Array.isArray(value)) return value.map(replaceValues);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceValues(entry)]));
    }
    return value;
  };
  return `${JSON.stringify(replaceValues(template), null, 2)}\n`;
}

function writeRenderedWorkflow(workflow, env = process.env) {
  const source = fs.readFileSync(workflow.fullPath, 'utf8');
  const rendered = renderWorkflowTemplate(source, env);
  const outputDir = '/tmp/govchat-workflow-bootstrap';
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const outputPath = path.join(outputDir, workflow.file);
  fs.writeFileSync(outputPath, rendered, { mode: 0o600 });
  return outputPath;
}

function importVerifyAndPublish(workflows) {
  const force = String(process.env.AGENTS_BOOTSTRAP_FORCE || 'false').trim().toLowerCase() === 'true';
  if (!force && fs.existsSync(MARKER_FILE)) {
    console.log('[bootstrap] Skip import/publish (already seeded; set AGENTS_BOOTSTRAP_FORCE=true to force)');
    return;
  }

  console.log(`[bootstrap] Import/publish ${workflows.length} workflowbestand(en) (force=${force})`);
  for (const workflow of workflows) {
    console.log(`[bootstrap] Import ${workflow.file}`);
    const inputPath = writeRenderedWorkflow(workflow);
    runN8n([`import:workflow`, `--input=${inputPath}`]);
  }

  let exportIndex = 0;
  for (const workflow of workflows) {
    for (const id of workflow.ids) {
      const verificationPath = `/tmp/verify-workflow-${exportIndex++}.json`;
      runN8n([`export:workflow`, `--id=${id}`, `--output=${verificationPath}`]);
    }
  }

  for (const workflow of workflows) {
    for (const id of workflow.ids) runN8n([`publish:workflow`, `--id=${id}`]);
  }

  // n8n 2.x publishes inactive exports as active by default. Restore the
  // source export's intended disabled state after publishing its draft.
  for (const workflow of workflows) {
    for (const id of workflow.inactiveIds || []) runN8n([`unpublish:workflow`, `--id=${id}`]);
  }

  fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
  fs.writeFileSync(MARKER_FILE, new Date().toISOString(), 'utf8');
  console.log('[bootstrap] Workflow import/publish geverifieerd');
}

async function main() {
  const workflows = discoverWorkflows();
  console.log(`[bootstrap] Ontdekte workflows: ${workflows.map((workflow) => workflow.file).join(', ')}`);
  console.log('[bootstrap] Controleer n8n owner setup...');
  await ensureOwner();
  importLiteLLMCredential();
  importTopdeskCredential();
  importVerifyAndPublish(workflows);
}

module.exports = { buildTopdeskCredential, discoverWorkflows, getTopdeskBaseUrl, renderWorkflowTemplate };

if (require.main === module) {
  main().catch((error) => {
    console.error('[bootstrap] Fout:', error);
    process.exitCode = 1;
  });
}
