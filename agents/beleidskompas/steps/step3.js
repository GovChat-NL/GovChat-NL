'use strict';

/**
 * Beleidskompas step 3 ("Instrumentkeuze"): which substeps it has, and where
 * their prompts are. Each prompt file holds the instruction for the model
 * and, at the end, the example of the answer. runStep in shared.js works
 * through all substeps in one model call.
 *
 * In n8n this is the Code node "Build Step 3 Answer" in the workflow
 * "Beleidskompas Specialist - Stap 3": generate-workflow.js pastes this
 * definition there, texts included, together with runStep and the other
 * functions from shared.js. Change it here, not in n8n; the next run of the
 * generator overwrites the node.
 */

const { readPrompt, readSubstepPrompt } = require('../shared');

const STEP = {
  id: 'stap3',
  nr: 3,
  title: 'Instrumentkeuze',
  role: readPrompt('step3/role.md'),
  substeps: [
    { id: '3.1', title: 'Sturingsbepaling', ...readSubstepPrompt('step3/3.1-sturingsbepaling.md') },
    { id: '3.2', title: 'Instrumentarium', ...readSubstepPrompt('step3/3.2-instrumentarium.md') },
    { id: '3.3', title: 'Afwegingskader', ...readSubstepPrompt('step3/3.3-afwegingskader.md') },
    { id: '3.4', title: 'Gevolgenanalyse', ...readSubstepPrompt('step3/3.4-gevolgenanalyse.md') },
  ],
};

module.exports = { STEP };
