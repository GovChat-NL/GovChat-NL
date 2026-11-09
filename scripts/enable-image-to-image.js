'use strict';
const fs = require('fs');
const path = require('path');
const { applyImageToolInputs, applyImageTriggerInputs } = require('./orchestrator-image-workflow');
const { applyImageEditWorkflow } = require('./image-edit-workflow');
const { applyOrchestratorImageEdits } = require('./orchestrator-image-edit-workflow');

// Apply to parsed, reviewed exports. No database, credential or deployment access.
function applyImageEvaluationWorkflows(orchestrator, image) {
  applyImageTriggerInputs(image);
  applyImageEditWorkflow(image);
  applyImageToolInputs(orchestrator);
  applyOrchestratorImageEdits(orchestrator);
  return { orchestrator, image };
}

if (require.main === module) {
  const root = path.resolve(__dirname, '../agents/n8n/workflows/algemeen');
  const files = ['orchestrator-litellm.json', 'image-generator-litellm.json'];
  const bundles = files.map(file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
  applyImageEvaluationWorkflows(...bundles.map(bundle => Array.isArray(bundle) ? bundle[0] : bundle));
  files.forEach((file, index) => fs.writeFileSync(path.join(root, file), JSON.stringify(bundles[index], null, 2) + '\n'));
  console.log('Updated tracked image evaluation templates only');
}
module.exports = { applyImageEvaluationWorkflows };
