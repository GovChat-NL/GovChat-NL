'use strict';

/**
 * Beleidskompas step 1 ("Publiek en provinciaal belang"): which substeps it
 * has, and where their prompts are. Each prompt file holds the instruction
 * for the model and, at the end, the answer format. runStep in
 * shared.js works through all substeps in one model call.
 *
 * In n8n this is the Code node "Build Step 1 Answer" in the workflow
 * "Beleidskompas Specialist - Stap 1": generate-workflow.js pastes this
 * definition there, texts included, together with runStep and the other
 * functions from shared.js. Change it here, not in n8n; the next run of the
 * generator overwrites the node.
 */

const { readPrompt, readSubstepPrompt } = require('../shared');

const STEP = {
  id: 'stap1',
  nr: 1,
  title: 'Publiek en provinciaal belang',
  role: readPrompt('step1/role.md'),
  substeps: [
    { id: '1.1', title: 'Probleemdefinitie', ...readSubstepPrompt('step1/1.1-probleemdefinitie.md') },
    { id: '1.2', title: 'Overheidsinterventie', ...readSubstepPrompt('step1/1.2-overheidsinterventie.md') },
    { id: '1.3', title: 'Stakeholderanalyse', ...readSubstepPrompt('step1/1.3-stakeholderanalyse.md') },
    { id: '1.4', title: 'Provinciaal doel', ...readSubstepPrompt('step1/1.4-provinciaal-doel.md') },
    { id: '1.5', title: 'Integrale afweging', ...readSubstepPrompt('step1/1.5-integrale-afweging.md') },
  ],
};

module.exports = { STEP };
