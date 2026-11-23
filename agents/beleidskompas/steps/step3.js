'use strict';

/**
 * Beleidskompas step 3 ("Instrumentkeuze"): which substeps it has, and where
 * their prompts are. Each prompt file holds the instruction for the model
 * and, at the end, the answer format.
 *
 * This is what the admin starts with (see template.js). The workflows read
 * the steps from the template the admin published.
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
