'use strict';

/**
 * Beleidskompas step 2 ("Rolbepaling provincie"): which substeps it has, and
 * where their prompts are. Each prompt file holds the instruction for the
 * model and, at the end, the example of the answer. runStep in shared.js
 * works through all substeps in one model call.
 *
 * In n8n this is the Code node "Build Step 2 Answer" in the workflow
 * "Beleidskompas Specialist - Stap 2": generate-workflow.js pastes this
 * definition there, texts included, together with runStep and the other
 * functions from shared.js. Change it here, not in n8n; the next run of the
 * generator overwrites the node.
 */

const { readPrompt, readSubstepPrompt } = require('../shared');

const STEP = {
  id: 'stap2',
  nr: 2,
  title: 'Rolbepaling provincie',
  role: readPrompt('step2/role.md'),
  substeps: [{ id: '2.1', title: 'Rolbepaling', ...readSubstepPrompt('step2/2.1-rolbepaling.md') }],
};

module.exports = { STEP };
