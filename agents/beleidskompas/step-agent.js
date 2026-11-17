'use strict';

/**
 * The agent of a step (the "Agent stap N" workflows in n8n, one per step
 * definition in steps/).
 *
 * The orchestrator calls a step's agent as a tool. The workflow then does
 * three things, each with a function from this file:
 *
 * 1. buildAssignment  - decide what the agent is told (before the agent)
 * 2. processReply     - take the agent's reply apart (after the agent)
 * 3. buildResult      - decide what the orchestrator gets back
 *
 * There are two kinds of assignment. "uitwerken" asks for the report of one
 * substep. The workflow stores that report itself, so what the page shows
 * is what the agent wrote, whatever the orchestrator says about it. The
 * orchestrator gets the report to read. Anything else is a question, and
 * its answer goes back as it is.
 *
 * generate-workflow.js copies these functions into the Code nodes.
 */

const { REPORT_PROMPT_TEMPLATE, CONVERSATION_PROMPT_TEMPLATE, COMMON_RULES, DISCLAIMER, toolCalls, nodeError } = require('./shared');

// --- 1. Before the agent: what it is told ---

/** True when the assignment asks for a report: the word "uitwerken". */
function asksForReport(assignmentText) {
  return /^uitwerk/i.test(String(assignmentText || '').trim());
}

/** The system prompt: a template from prompts/ with the step's texts
 *  filled in. `substeps` are the substeps the agent works on. */
function buildSystemPrompt({ template, step, substeps, rules }) {
  const values = {
    role: step.role,
    substeps: substeps.map((substep) => `Deelstap ${substep.id}: ${substep.title}\n${substep.instruction}`).join('\n\n'),
    rules: rules.map((rule) => '- ' + rule).join('\n'),
    substep_format: substeps.map((substep) => substep.format).join('\n\n'),
  };
  // {{name}} in the template becomes values.name; an unknown name stays.
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => (name in values ? values[name] : placeholder));
}

/** The user prompt: what there is to read about the case, then the task. */
function buildUserPrompt({ input, task }) {
  const parts = [];

  parts.push(input.case_text ? `Casus:\n${input.case_text}` : 'Casus: (nog geen casus bekend)');
  if (input.findings) parts.push(`Bevindingen tot nu toe:\n${input.findings}`);
  if (input.conversation) parts.push(`Laatste beurten van het gesprek:\n${input.conversation}`);
  parts.push(task);
  parts.push('Beleidsbronnen: geen beschikbaar. Vermeld dit alleen onder "Aannames en ontbrekende informatie".');

  return parts.join('\n\n');
}

/** What the agent is told.
 *
 *  `input` is what the orchestrator's tool call passed:
 *  - substep_id, assignment: filled in by the orchestrator's model
 *  - case_id, user_id, case_text, findings, conversation: filled in by the
 *    orchestrator workflow; `findings` holds the earlier reports in full
 *
 *  `texts` may replace the templates and the rules (reportTemplate,
 *  conversationTemplate, rules); without it the files in prompts/ are used.
 *
 *  The result has a `mode`:
 *  - "report": work out the one substep that was named
 *  - "conversation": answer a question, about the named substep or, when
 *    none is named, about the whole step
 *  - "invalid": a report was asked for a substep this step does not have */
function buildAssignment({ step, input, texts }) {
  const given = input || {};
  const custom = texts || {};

  const substepId = String(given.substep_id || '').trim();
  const substep = step.substeps.find((candidate) => candidate.id === substepId) || null;
  const forReport = asksForReport(given.assignment);

  // What every result carries, whatever the mode.
  const about = {
    case_id: given.case_id,
    user_id: given.user_id,
    step_id: step.id,
    step_nr: step.nr,
    step_title: step.title,
    substep_id: substep ? substep.id : '',
    substep_title: substep ? substep.title : '',
  };

  if (forReport && !substep) {
    const known = step.substeps.map((candidate) => candidate.id).join(', ');
    const error = `Stap ${step.nr} kent deelstap "${substepId}" niet. Bekende deelstappen: ${known}.`;
    return { ...about, mode: 'invalid', valid: false, error };
  }

  const rules = Array.isArray(custom.rules) ? custom.rules : COMMON_RULES;
  // A question without a substep is about the whole step.
  const substeps = substep ? [substep] : step.substeps;

  if (forReport) {
    return {
      ...about,
      mode: 'report',
      valid: true,
      system_prompt: buildSystemPrompt({ template: custom.reportTemplate || REPORT_PROMPT_TEMPLATE, step, substeps, rules }),
      user_prompt: buildUserPrompt({ input: given, task: `Opdracht: werk deelstap ${substep.id} (${substep.title}) uit.` }),
    };
  }

  return {
    ...about,
    mode: 'conversation',
    valid: true,
    system_prompt: buildSystemPrompt({ template: custom.conversationTemplate || CONVERSATION_PROMPT_TEMPLATE, step, substeps, rules }),
    user_prompt: buildUserPrompt({ input: given, task: `Bericht van de gebruiker:\n${String(given.assignment || '').trim()}` }),
  };
}

// --- 2. After the agent: its reply ---

/** The reply without a surrounding ```markdown code block, if it had one. */
function unwrapCodeBlock(text) {
  const trimmed = String(text || '').trim();
  const wrapped = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return wrapped ? wrapped[1].trim() : trimmed;
}

/** Takes the agent's reply apart. `assignment` is what buildAssignment
 *  returned, `agent` the output of the AI Agent node.
 *
 *  For a report the result holds the text as the store keeps it and the
 *  page shows it (`report_text`: the step heading, the reply, the
 *  disclaimer). `save` says whether there is a report to store. */
function processReply({ assignment, agent, disclaimer }) {
  const text = unwrapCodeBlock(agent && agent.output);

  let error = nodeError(agent);
  if (!error && !text) error = `De agent van stap ${assignment.step_nr} gaf geen antwoord.`;

  const heading = `**Stap ${assignment.step_nr} · ${assignment.step_title} · ${assignment.substep_id} ${assignment.substep_title}**`;
  const footer = '---\n' + (disclaimer || DISCLAIMER);

  return {
    mode: assignment.mode,
    case_id: assignment.case_id,
    user_id: assignment.user_id,
    substep_id: assignment.substep_id,
    save: assignment.mode === 'report' && !error,
    report_text: [heading, text, footer].join('\n\n'),
    answer: text,
    tools: toolCalls(agent),
    error,
  };
}

// --- 3. What the orchestrator gets back ---

/** The result of the tool call, as the orchestrator's model reads it.
 *
 *  `reply` is what processReply returned; it is absent when the assignment
 *  was invalid, because the agent did not run then. `saved` is what the
 *  store answered to storing the report; it is absent when nothing was
 *  stored.
 *
 *  The result has a `kind`:
 *  - "error": something went wrong; `error` says what
 *  - "answer": the answer to a question, as the agent gave it
 *  - "report": the report, and whether the store has it */
function buildResult({ assignment, reply, saved }) {
  if (assignment.mode === 'invalid') {
    return { kind: 'error', error: assignment.error };
  }
  if (reply.error) {
    return { kind: 'error', error: reply.error };
  }
  if (reply.mode === 'conversation') {
    return { kind: 'answer', step_id: assignment.step_id, answer: reply.answer, tools: reply.tools };
  }

  // The store answers with the version number of the report it stored.
  const stored = Boolean(saved) && Number.isInteger(saved.version);

  return {
    kind: 'report',
    step_id: assignment.step_id,
    substep_id: reply.substep_id,
    saved: stored,
    version: stored ? saved.version : null,
    error: stored ? null : 'Het rapport is gemaakt, maar opslaan is mislukt.',
    report: reply.report_text,
    tools: reply.tools,
  };
}

module.exports = { asksForReport, buildSystemPrompt, buildUserPrompt, buildAssignment, unwrapCodeBlock, processReply, buildResult };
