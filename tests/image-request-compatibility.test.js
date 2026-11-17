'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflow = JSON.parse(fs.readFileSync(path.join(root, 'agents/n8n/workflows/algemeen/image-generator-litellm.json'), 'utf8'))[0];
const prepare = workflow.nodes.find(node => node.name === 'Prepare Image Request').parameters.jsCode;
const generator = fs.readFileSync(path.join(root, 'scripts/harden-image-workflow.js'), 'utf8');
const requestBlock = source => source.match(/const baseRaw = [\s\S]*?(?=\nreturn \[\{ json:)/)[0];

for (const model of ['gpt-image-1', 'gpt-image-1.5', 'dall-e-3', 'dall-e-2']) {
  for (const azure of [false, true]) {
    test(`${model} ${azure ? 'Azure' : 'OpenAI'} uses compatible image request parameters`, () => {
      assert.equal(requestBlock(prepare), requestBlock(generator), 'generator and workflow drifted');
      const build = new Function('$env', 'body', 'raw', 'prompt', 'asString',
        requestBlock(prepare) + '\nreturn { requestBody, generateUrl };');
      const result = build({ N8N_LITELLM_IMAGE_MODEL: model, N8N_LITELLM_IMAGE_API_KEY: 'synthetic-key',
        N8N_LITELLM_IMAGE_BASE_URL: azure ? 'https://example.invalid/openai/deployments/test' : 'https://example.invalid' },
        { size: '1024x1024', quality: 'low' }, {}, 'Synthetic test', value => typeof value === 'string' ? value.trim() : '');
      assert.equal(result.requestBody.prompt, 'Synthetic test');
      assert.equal(Object.hasOwn(result.requestBody, 'model'), !azure);
      assert.equal(Object.hasOwn(result.requestBody, 'quality'), model !== 'dall-e-2');
      if (model.startsWith('gpt-image-')) assert.equal(Object.hasOwn(result.requestBody, 'response_format'), false);
      else assert.equal(result.requestBody.response_format, 'b64_json');
      assert.equal(JSON.stringify(result).includes('synthetic-key'), false);
    });
  }
}
