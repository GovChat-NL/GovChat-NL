'use strict';

// Serialized into an n8n expression; keep this function self-contained.
function trustedImageUserId(request, expectedToken) {
  const headers = request?.headers || {};
  const auth = String(headers.authorization || headers.Authorization || '').trim();
  const expected = String(expectedToken || '').trim();
  const bearer = /^bearer /i.test(auth) ? auth.slice(7).trim() : '';
  if (!expected || bearer !== expected) throw new Error('Unauthorized image tool caller');
  // Only the service-authenticated bridge payload is trusted, never tool arguments.
  const userId = typeof request?.body?.userId === 'string' ? request.body.userId.trim() : '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(userId)) throw new Error('Authenticated user context is missing');
  return userId;
}

const fields = ['prompt', 'size', 'quality', 'userId'];
const trustedUserExpression = `={{ (${trustedImageUserId.toString()})($('Webhook Orchestrator').first().json, $env.N8N_WEBHOOK_TOKEN) }}`;

function applyImageToolInputs(workflow) {
  const tool = workflow.nodes.find(node => node.name === 'image_generation_tool');
  if (!tool) throw new Error('Image generation tool is missing');
  tool.parameters.workflowInputs = {
    mappingMode: 'defineBelow',
    value: {
      prompt: "={{ $fromAI('prompt', 'Beschrijving van de te genereren afbeelding', 'string') }}",
      size: "={{ $fromAI('size', 'Afbeeldingsformaat, standaard 1024x1024', 'string', '1024x1024') }}",
      quality: "={{ $fromAI('quality', 'Afbeeldingskwaliteit, standaard low', 'string', 'low') }}",
      userId: trustedUserExpression,
    },
    matchingColumns: [],
    schema: fields.map(id => ({ id, displayName: id, required: id === 'prompt' || id === 'userId',
      defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' })),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  };
  return workflow;
}

function applyImageTriggerInputs(workflow) {
  const trigger = workflow.nodes.find(node => node.name === 'When Executed by Another Workflow');
  if (!trigger) throw new Error('Image workflow trigger is missing');
  trigger.typeVersion = 1.1;
  trigger.parameters = { inputSource: 'workflowInputs', workflowInputs: { values: fields.map(name => ({ name, type: 'string' })) } };
  return workflow;
}

module.exports = { trustedImageUserId, trustedUserExpression, applyImageToolInputs, applyImageTriggerInputs };
