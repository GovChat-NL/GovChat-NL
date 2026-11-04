'use strict';

/**
 * Beleidskompas step 4 ("Governance-inrichting"): which substeps it has, and
 * where their prompts are. Each prompt file holds the instruction for the
 * model and, at the end, the example of the answer. runStep in shared.js
 * works through all substeps in one model call.
 *
 * In n8n this is the Code node "Build Step 4 Answer" in the workflow
 * "Beleidskompas Specialist - Stap 4": generate-workflow.js pastes this
 * definition there, texts included, together with runStep and the other
 * functions from shared.js. Change it here, not in n8n; the next run of the
 * generator overwrites the node.
 */

const { readPrompt, readSubstepPrompt } = require('../shared');

const STEP = {
  id: 'stap4',
  nr: 4,
  title: 'Governance-inrichting',
  role: readPrompt('step4/role.md'),
  substeps: [
    { id: '4.1', title: 'Good governance-principes', ...readSubstepPrompt('step4/4.1-good-governance-principes.md') },
    { id: '4.2', title: 'Organisatorische governance', ...readSubstepPrompt('step4/4.2-organisatorische-governance.md') },
    { id: '4.3', title: 'Governance-richtlijnen', ...readSubstepPrompt('step4/4.3-governance-richtlijnen.md') },
  ],
};

module.exports = { STEP };
