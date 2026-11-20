'use strict';

/**
 * Beleidskompas step 4 ("Governance-inrichting"): which substeps it has, and where
 * their prompts are. Each prompt file holds the instruction for the model
 * and, at the end, the answer format.
 *
 * This is what the admin starts with (see template.js). The workflows read
 * the steps from the template the admin published.
 */

const { readPrompt, readSubstepPrompt } = require('../shared');

const STEP = {
  id: 'stap4',
  nr: 4,
  title: 'Governance-inrichting',
  role: readPrompt('step4/role.md'),
  substeps: [
    { id: 'sub_79tvogur', title: 'Good governance-principes', ...readSubstepPrompt('step4/4.1-good-governance-principes.md') },
    { id: 'sub_ychd11mr', title: 'Organisatorische governance', ...readSubstepPrompt('step4/4.2-organisatorische-governance.md') },
    { id: 'sub_t1723lbi', title: 'Governance-richtlijnen', ...readSubstepPrompt('step4/4.3-governance-richtlijnen.md') },
  ],
};

module.exports = { STEP };
