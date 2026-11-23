'use strict';

/**
 * Beleidskompas step 2 ("Rolbepaling provincie"): which substeps it has, and where
 * their prompts are. Each prompt file holds the instruction for the model
 * and, at the end, the answer format.
 *
 * This is what the admin starts with (see template.js). The workflows read
 * the steps from the template the admin published.
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
