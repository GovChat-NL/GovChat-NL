'use strict';

/**
 * The default Beleidskompas template in the admin's flow shape, built from
 * steps/*.js and prompts/**. generate-workflow.js writes it to
 * services/admin-overlay/admin/lib/beleidskompas/default-template.json (the
 * admin's seed) and bakes it into the orchestrator as its fallback.
 */

const {
  REPORT_PROMPT_TEMPLATE,
  CONVERSATION_PROMPT_TEMPLATE,
  ORCHESTRATOR_PROMPT_TEMPLATE,
  COMMON_RULES,
  DISCLAIMER,
} = require('./shared');
const { STEP: step1 } = require('./steps/step1');
const { STEP: step2 } = require('./steps/step2');
const { STEP: step3 } = require('./steps/step3');
const { STEP: step4 } = require('./steps/step4');

// The user-facing orchestrator messages. Same strings as the constants in
// orchestrator.js (kept there too, as its baked defaults; template.test.js
// checks they are equal). Defined here to avoid a require cycle.
const DEFAULT_MESSAGES = {
  unknown_step:
    'Beleidskompas kon niet bepalen voor welke stap dit bericht is en heeft het daarom niet beantwoord. ' +
    'Stel je vraag opnieuw vanaf de Beleidskompas-pagina, met een stap gekozen.',
  store_missing:
    'Beleidskompas kan zijn opslag niet gebruiken en heeft dit bericht daarom niet beantwoord. Meld dit bij de beheerder.',
  store_failed: 'De opslag van Beleidskompas gaf een fout. Dit bericht is daarom niet beantwoord; probeer het later opnieuw.',
  store_warning: 'Let op: de opslag van Beleidskompas gaf een fout. Dit antwoord is mogelijk niet bewaard.',
};

// The descriptions the admin shows for steps and substeps, by id.
const DESCRIPTIONS = {
  stap1: 'Bepaal probleem, publiek belang en provinciale legitimiteit op basis van wettelijke taken en beleidskaders.',
  '1.1': 'Probleem, oorzaken en symptomen.',
  '1.2': 'Is overheidsingrijpen gerechtvaardigd?',
  '1.3': 'Belanghebbenden, belangen en invloed.',
  '1.4': 'Aansluiting op provinciale beleidsdoelen.',
  '1.5': 'Oordeel over publiek en provinciaal belang.',
  stap2: 'Kies passende provinciale rol(len): regulerend, regisserend, stimulerend of faciliterend.',
  '2.1': 'Welke rol past de provincie, en waarom?',
  stap3: 'Vergelijk beleids- en uitvoeringsinstrumenten, inclusief argumentatie, risicobeoordeling en alternatieven.',
  '3.1': 'Mate van sturing bij de gekozen rol.',
  '3.2': 'Instrumenten bij rol, sturing en probleem.',
  '3.3': 'Meest geschikte samenwerkingsvorm.',
  '3.4': 'Gevolgen per instrument en de nuloptie.',
  stap4: 'Adviseer inrichting voor sturing, toezicht, beheersing en verantwoording, inclusief KPI’s.',
  '4.1': 'Sturing, toezicht, beheersing en verantwoording.',
  '4.2': 'Organisatorische inrichting van goed bestuur.',
  '4.3': 'Concrete richtlijnen per component.',
};

/** A STEP object from steps/ in the admin's step shape. */
function templateStep(step) {
  return {
    id: step.id,
    nr: step.nr,
    title: step.title,
    description: DESCRIPTIONS[step.id] || '',
    prompt: step.role,
    doc_tags: [],
    substeps: step.substeps.map((substep) => ({
      id: substep.id,
      title: substep.title,
      description: DESCRIPTIONS[substep.id] || '',
      prompt: substep.instruction,
      answer_format: substep.format,
    })),
  };
}

const DEFAULT_TEMPLATE = {
  title: 'Beleidskompas',
  disclaimer: 'Deze toepassing is een ondersteunend hulpmiddel en vervangt geen menselijke besluitvorming.',
  specialist_team: 'Bij hoge juridische/financiële impact: betrek concernjurist, financieel adviseur en programmaregisseur.',
  report_disclaimer: DISCLAIMER,
  rules: COMMON_RULES.join('\n'),
  report_prompt: REPORT_PROMPT_TEMPLATE,
  conversation_prompt: CONVERSATION_PROMPT_TEMPLATE,
  orchestrator_prompt: ORCHESTRATOR_PROMPT_TEMPLATE,
  messages: DEFAULT_MESSAGES,
  sources: [
    'SiS 4.0 Strategisch kader',
    'SiS 4.0 Uitvoeringskader',
    'Provinciale Instrumentenkoffer',
    'Coalitieakkoord en beleidskaders',
    'Overzicht wettelijke taken Provincie',
  ],
  steps: [step1, step2, step3, step4].map(templateStep),
};

/** The step of a template in the shape runStep works with, or null. */
function stepFromTemplate(template, stepId) {
  const steps = template && Array.isArray(template.steps) ? template.steps : [];
  const index = steps.findIndex((step) => step && step.id === stepId);
  if (index === -1) return null;
  const step = steps[index];
  return {
    id: step.id,
    nr: Number(step.nr) || index + 1,
    title: String(step.title || ''),
    role: String(step.prompt || ''),
    substeps: (Array.isArray(step.substeps) ? step.substeps : []).map((substep) => ({
      id: substep.id,
      title: String(substep.title || ''),
      instruction: String(substep.prompt || ''),
      format: String(substep.answer_format || ''),
    })),
  };
}

/** The rules of a template, one per non-empty line. */
function rulesFromTemplate(template) {
  return String((template && template.rules) || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

module.exports = { DEFAULT_TEMPLATE, DEFAULT_MESSAGES, stepFromTemplate, rulesFromTemplate };
