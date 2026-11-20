'use strict';

/**
 * Beleidskompas step 1 ("Publiek en provinciaal belang"): which substeps it has, and where
 * their prompts are. Each prompt file holds the instruction for the model
 * and, at the end, the answer format.
 *
 * This is what the admin starts with (see template.js). The workflows read
 * the steps from the template the admin published.
 */

const { readPrompt, readSubstepPrompt } = require('../shared');

const STEP = {
  id: 'stap1',
  nr: 1,
  title: 'Publiek en provinciaal belang',
  role: readPrompt('step1/role.md'),
  substeps: [
    { id: 'sub_qklcsmmg', title: 'Probleemdefinitie', ...readSubstepPrompt('step1/1.1-probleemdefinitie.md') },
    { id: 'sub_44xmfrqq', title: 'Overheidsinterventie', ...readSubstepPrompt('step1/1.2-overheidsinterventie.md') },
    { id: 'sub_rno733xd', title: 'Stakeholderanalyse', ...readSubstepPrompt('step1/1.3-stakeholderanalyse.md') },
    { id: 'sub_5awqht5w', title: 'Provinciaal doel', ...readSubstepPrompt('step1/1.4-provinciaal-doel.md') },
    { id: 'sub_ipcjfnt7', title: 'Integrale afweging', ...readSubstepPrompt('step1/1.5-integrale-afweging.md') },
  ],
};

module.exports = { STEP };
