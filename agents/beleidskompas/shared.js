'use strict';

/**
 * What the Beleidskompas workflows share: the prompt texts, reading the
 * caller's token, taking the message of the page apart, LibreChat's
 * conversation-title request and reading which tools an agent called.
 * orchestrator.js and step-agent.js build on these; generate-workflow.js
 * copies the functions a workflow needs into its Code nodes.
 */

const fs = require('node:fs');
const path = require('node:path');

// --- The prompt texts ---
//
// The texts the model gets live as files in prompts/: the template of the
// system prompt, the rules that apply to every step, and per step the role
// of the model and one instruction per substep. They are read here, in
// Node; generate-workflow.js pastes them as text into the workflows, so n8n
// never reads a file.

const PROMPTS_DIR = path.join(__dirname, 'prompts');

/** The text of a file in prompts/, without surrounding whitespace. */
function readPrompt(relativePath) {
  return fs.readFileSync(path.join(PROMPTS_DIR, relativePath), 'utf-8').trim();
}

/** A substep's prompt file: the instruction, and after "Antwoord in deze
 *  vorm:" the answer format, the markdown headings the model answers with.
 *  The answer format goes into the report prompt as it is written. */
function readSubstepPrompt(relativePath) {
  const text = readPrompt(relativePath);
  const match = /\n\s*Antwoord in deze vorm:\s*\n/.exec(text);
  if (!match) throw new Error(`${relativePath} has no "Antwoord in deze vorm:" before its answer format`);
  const instruction = text.slice(0, match.index).trim();
  const format = text.slice(match.index + match[0].length).trim();
  if (!format) throw new Error(`${relativePath} has no answer format after "Antwoord in deze vorm:"`);
  return { instruction, format };
}

const REPORT_PROMPT_TEMPLATE = readPrompt('report-prompt.md');
const CONVERSATION_PROMPT_TEMPLATE = readPrompt('conversation-prompt.md');
// The system prompt of the orchestrator agent (prompts/orchestrator-prompt.md):
// {{steps}} is the list of step agents it can call.
const ORCHESTRATOR_PROMPT_TEMPLATE = readPrompt('orchestrator-prompt.md');

// One rule per line in rules.md.
const COMMON_RULES = readPrompt('rules.md')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const DISCLAIMER =
  'Dit resultaat is een ondersteunend concept ten behoeve van de voorbereiding van beleidsadvies. ' +
  'Het is geen besluit en vervangt geen menselijke afweging of besluitvorming.';

// --- The caller's token ---

function extractSuppliedToken(headers) {
  const h = headers && typeof headers === 'object' ? headers : {};
  const direct = String(h['x-govchat-token'] || h['X-Govchat-Token'] || '').trim();
  if (direct) return direct;
  // The n8n-openai-bridge (LibreChat's real custom-endpoint pipeline) sends the
  // shared webhook secret as a standard Authorization bearer token instead of
  // the x-govchat-token header used by direct/manual webhook calls.
  const authHeader = String(h['authorization'] || h['Authorization'] || '').trim();
  if (/^Bearer\s/i.test(authHeader)) {
    return authHeader.slice(authHeader.indexOf(' ') + 1).trim();
  }
  return '';
}

// --- The message as the Beleidskompas page composes it ---

// The page can only send text, so it puts what the orchestrator needs to
// know about a request behind the visible text of the message, in a
// markdown link definition with base64 JSON (composePrompt in
// overlay/src/apps/beleidskompas/beleidskompas-api.js writes it):
// the substep, the case as the user described it and the message the user
// typed just now. A markdown view does not show the definition, and what
// the user typed sits inside the JSON, so it can never be mistaken for one
// of those fields. A message that was typed means a conversation turn.
// Without a message, the request is for the report of the substep.
const REQUEST_META_LABEL = 'beleidskompas-request';

/** Takes a message apart. `fromPage` says whether the message carries the
 *  block of the page; without it the message was typed in LibreChat's own
 *  chat and all of it is the message. A substep id also names its step:
 *  1.3 is a substep of stap1. A part that is missing is ''. */
function parsePageMessage(text) {
  const raw = String(text || '');
  const parts = { fromPage: false, stepId: '', substepId: '', caseText: '', message: raw.trim() };
  const marker = `[${REQUEST_META_LABEL}]: data:application/json;base64,`;
  const idx = raw.lastIndexOf(marker);
  if (idx === -1) return parts;

  let request;
  try {
    const encoded = raw.slice(idx + marker.length).split('\n')[0].trim();
    request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (_) {
    return parts;
  }
  const substepMatch = /^(\d+)\.\d+/.exec(String(request.substep_id || '').trim());
  parts.fromPage = true;
  parts.substepId = substepMatch ? substepMatch[0] : '';
  parts.stepId = substepMatch ? `stap${substepMatch[1]}` : '';
  parts.caseText = String(request.case_text || '').trim();
  parts.message = String(request.message || '').trim();
  return parts;
}

// --- LibreChat conversation-title requests ---
//
// LibreChat generates each conversation's title by sending an extra request
// to the SAME custom endpoint/model with an instruction to summarize the
// conversation in a few words (see librechat.yaml's `titlePrompt`, which
// embeds TITLE_REQUEST_MARKER so it's reliably recognizable here). Without
// this, the instruction would be treated as a message about a case, and the
// answer to it would become the "title".

const TITLE_REQUEST_MARKER = '__BELEIDSKOMPAS_TITLE_REQUEST__';
const TITLE_PREFIX = 'Beleidskompas - ';

function isTitleRequest(text) {
  return String(text || '').includes(TITLE_REQUEST_MARKER);
}

/** Deterministic title when no LLM is configured, or the LLM call fails:
 *  strips the marker/markdown and takes the first few words. */
function buildFallbackTitle(text) {
  const cleaned = String(text || '')
    .replaceAll(TITLE_REQUEST_MARKER, '')
    .replace(/[#*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Beleidskompas casus';
  const words = cleaned.split(' ').slice(0, 8);
  const joined = words.join(' ');
  return joined.length < cleaned.length ? joined + '…' : joined;
}

/** librechat.yaml's titlePrompt renders as our instruction followed by the
 *  real conversation via the "User: ...\nAI: ..." transcript format (the
 *  `{convo}` placeholder, filled in by @librechat/agents before this ever
 *  reaches us). Extracting just the user's case text keeps the title (and
 *  its deterministic fallback) focused on the actual case instead of the
 *  instruction sentence that precedes it. Falls back to the input unchanged
 *  when that format isn't present (e.g. direct webhook/test calls). */
function extractConvoCaseText(text) {
  const s = String(text || '');
  const userIdx = s.indexOf('User:');
  if (userIdx === -1) return s.trim();
  const afterUser = s.slice(userIdx + 'User:'.length);
  const aiIdx = afterUser.indexOf('\nAI:');
  return (aiIdx === -1 ? afterUser : afterUser.slice(0, aiIdx)).trim();
}

// --- What an agent did ---

/** The tools an AI Agent node called, in order, from the intermediate steps
 *  the node returns: the name of each tool and what the model passed it. */
function toolCalls(agentOutput) {
  const steps = agentOutput && Array.isArray(agentOutput.intermediateSteps) ? agentOutput.intermediateSteps : [];
  return steps.map((step) => ({
    tool: (step && step.action && step.action.tool) || null,
    input: step && step.action ? step.action.toolInput : null,
  }));
}

/** The error an AI Agent node (or an HTTP Request node) returned instead of
 *  failing the workflow, as text, or null when there was none. */
function nodeError(output) {
  const error = output && output.error;
  if (!error) return null;
  return String((typeof error === 'object' && error.message) || error);
}

module.exports = {
  DISCLAIMER,
  TITLE_REQUEST_MARKER,
  TITLE_PREFIX,
  REQUEST_META_LABEL,
  extractSuppliedToken,
  parsePageMessage,
  isTitleRequest,
  buildFallbackTitle,
  extractConvoCaseText,
  readPrompt,
  readSubstepPrompt,
  REPORT_PROMPT_TEMPLATE,
  CONVERSATION_PROMPT_TEMPLATE,
  ORCHESTRATOR_PROMPT_TEMPLATE,
  COMMON_RULES,
  toolCalls,
  nodeError,
};
