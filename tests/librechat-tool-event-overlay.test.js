const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  patchCallbacksSource,
  patchInitializeSource,
} = require('../scripts/librechat-tool-event-overlay');
const { createLibreChatStepEventDecoder } = require('../scripts/librechat-tool-event-protocol');
const { processEventStream } = require('../scripts/n8n-processEventStream.patched');
const librechatRoot = process.env.GOVCHAT_TEST_LIBRECHAT_ROOT ||
  (fs.existsSync('/app/api/server/controllers/agents/callbacks.js') ? '/app' :
    path.resolve(__dirname, '../../LibreChat'));

test('overlay source patch is valid, idempotent, and routes decoded events through handlers', () => {
  const target = path.join(librechatRoot, 'api/server/controllers/agents/callbacks.js');
  const original = fs.readFileSync(target, 'utf8');
  const patched = patchCallbacksSource(original);

  assert.notEqual(patched, original);
  assert.equal(patchCallbacksSource(patched), patched);
  assert.match(patched, /createLibreChatStepEventDecoder\(\)/);
  assert.match(patched, /contentParts = null/);
  assert.match(patched, /typeof content === 'string'/);
  assert.match(patched, /content: contentIsArray \? \[\{ \.\.\.part, text \}\] : text/);
  assert.match(patched, /eventHandler\.handle\(eventName, eventData, metadata\)/);
  assert.match(patched, /let nextLibreChatToolStepIndex = 0/);
  assert.match(patched, /index: Math\.max\(data\.index \?\? 0, nextLibreChatToolStepIndex\)/);
  assert.match(patched, /index: nextLibreChatToolStepIndex\+\+/);
  assert.match(patched, /emitDecodedStepEvent\(GraphEvents\.ON_RUN_STEP, shiftedStep\)/);
  assert.match(patched, /emitDecodedStepEvent/);
  assert.match(patched, /if \(event === 'on_run_step_closed'\)/);
  assert.doesNotThrow(() => new Function('require', 'module', 'exports', patched));
});

test('initialize overlay provides message content parts for native run-step indexing', () => {
  const target = path.join(librechatRoot, 'api/server/services/Endpoints/agents/initialize.js');
  const original = fs.readFileSync(target, 'utf8');
  const patched = patchInitializeSource(original);

  assert.match(patched, /res,\s+contentParts,\s+stepMap,/);
  assert.equal(patchInitializeSource(patched), patched);
});

test('overlay supports the stock v0.8.7 callback API and its older event emitter', () => {
  const legacyCallbacks = `const { saveBase64Image } = require('~/server/services/Files/process');
function getDefaultHandlers({
  res,
  aggregateContent,
  toolEndCallback,
  collectedUsage,
  streamId = null,
}) {
  const handlers = {
    [GraphEvents.ON_MESSAGE_DELTA]: {
      /**
       * Handle ON_MESSAGE_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        aggregateContent({ event, data });
        if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitEvent(res, streamId, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitEvent(res, streamId, { event, data });
        }
      },
    },
  };
}`;
  const patched = patchCallbacksSource(legacyCallbacks);

  assert.match(patched, /emitEvent\(res, streamId, \{ event, data \}\)/);
  assert.doesNotThrow(() => new Function('require', 'module', 'exports', patched));
});

test('overlay places multiple tool steps before an already-started assistant turn', async () => {
  const callbackSource = `const { saveBase64Image } = require('~/server/services/Files/process');
const StepTypes = { TOOL_CALLS: 'tool_calls' };
const GraphEvents = { ON_RUN_STEP: 'on_run_step', ON_MESSAGE_DELTA: 'on_message_delta' };
function getDefaultHandlers({
  res,
  aggregateContent,
  toolEndCallback,
  streamId = null,
}) {
  const handlers = {
    [GraphEvents.ON_RUN_STEP]: {
      handle: async (event, data) => {
        aggregateContent({ event, data });
        await emitEvent(res, streamId, { event, data });
      },
    },
    [GraphEvents.ON_MESSAGE_DELTA]: {
      /**
       * Handle ON_MESSAGE_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        aggregateContent({ event, data });
        if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitEvent(res, streamId, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitEvent(res, streamId, { event, data });
        }
      },
    },
  };
  return handlers;
}
module.exports = { getDefaultHandlers };`;
  const patched = patchCallbacksSource(callbackSource);
  const emitted = [];
  const contentParts = [];
  const stepMap = new Map();
  const aggregateContent = ({ event, data }) => {
    if (event === 'on_run_step') {
      stepMap.set(data.id, data);
      if (data.stepDetails.type === 'tool_calls') {
        const existingPart = contentParts[data.index];
        if (!existingPart || existingPart.type === 'tool_call') {
          contentParts[data.index] = {
            type: 'tool_call',
            tool_call: data.stepDetails.tool_calls[0],
          };
        }
      }
    } else if (event === 'on_message_delta') {
      const step = stepMap.get(data.id);
      if (step && !contentParts[step.index]) {
        const content = data.delta.content;
        const text = Array.isArray(content) ? content[0]?.text : content;
        contentParts[step.index] = { type: 'text', text };
      }
    }
  };
  const emitEvent = async (_res, _streamId, event) => emitted.push(event);
  const module = { exports: {} };
  const decoderModule = {
    createLibreChatStepEventDecoder: () => ({
      push: (text) => [{ type: 'text', text }],
      flush: () => [],
    }),
  };
  const mockRequire = (name) =>
    name === '/app/govchat-overlay/librechat-tool-event-protocol'
      ? decoderModule
      : { saveBase64Image: () => {} };
  new Function('require', 'module', 'exports', 'emitEvent', 'checkIfLastAgent', patched)(
    mockRequire,
    module,
    module.exports,
    emitEvent,
    () => true,
  );

  const handlers = module.exports.getDefaultHandlers({ res: {}, aggregateContent, contentParts });
  await handlers.on_run_step.handle('on_run_step', {
    id: 'assistant-step',
    index: 0,
    runId: 'response-1',
    stepDetails: { type: 'message_creation' },
  });
  await handlers.on_run_step.handle('on_run_step', {
    id: 'tool-step',
    index: 0,
    runId: 'response-1',
    stepDetails: {
      type: 'tool_calls',
      tool_calls: [{ id: 'call-first', name: 'first_tool', args: {} }],
    },
  });
  await handlers.on_message_delta.handle('on_message_delta', {
    id: 'assistant-step',
    delta: { content: [{ type: 'text', text: 'Internal tool-call log' }] },
  });
  await handlers.on_run_step.handle('on_run_step', {
    id: 'second-tool-step',
    index: 1,
    runId: 'response-1',
    stepDetails: {
      type: 'tool_calls',
      tool_calls: [{ id: 'call-second', name: 'second_tool', args: {} }],
    },
  });

  const finalById = new Map(emitted.map(({ data }) => [data.id, data]));
  assert.equal(finalById.get('tool-step').index, 0);
  assert.equal(finalById.get('second-tool-step').index, 1);
  assert.equal(finalById.get('assistant-step').index, 2);
  assert.equal(contentParts[0].type, 'tool_call');
  assert.equal(contentParts[1].type, 'tool_call');
  assert.deepEqual(contentParts[2], { type: 'text', text: 'Internal tool-call log' });
});

test('initialize overlay adds contentParts to v0.8.7 handler options', () => {
  const legacyInitialize = `async function initializeClient() {
  const { contentParts, aggregateContent } = createContentAggregator();
  const eventHandlers = getDefaultHandlers({
    res,
    aggregateContent,
    toolEndCallback,
    streamId,
  });
}`;
  const patched = patchInitializeSource(legacyInitialize);

  assert.match(patched, /aggregateContent,\s+contentParts,\s+toolEndCallback/);
  assert.equal(patchInitializeSource(patched), patched);
});

test('mounted overlay protocol strips control frames but returns regular text around them', () => {
  const event = {
    event: 'on_run_step_closed',
    data: { id: 'step-1', status: 'completed' },
  };
  const encoded = `\u001eLCSTEP:${Buffer.from(JSON.stringify(event)).toString('base64url')}\u001f`;
  const decoder = createLibreChatStepEventDecoder();

  assert.deepEqual(decoder.push(`before${encoded}after`), [
    { type: 'text', text: 'before' },
    { type: 'event', event },
    { type: 'text', text: 'after' },
  ]);
});

test('mounted overlay protocol decodes markers split across model text deltas', () => {
  const event = {
    event: 'on_run_step',
    data: { id: 'step-split', status: 'in_progress' },
  };
  const encoded = `\u001eLCSTEP:${Buffer.from(JSON.stringify(event)).toString('base64url')}\u001f`;
  const decoder = createLibreChatStepEventDecoder();
  const split = Math.floor(encoded.length / 2);

  assert.deepEqual(decoder.push(`answer${encoded.slice(0, split)}`), [
    { type: 'text', text: 'answer' },
  ]);
  assert.deepEqual(decoder.push(`${encoded.slice(split)} done`), [
    { type: 'event', event },
    { type: 'text', text: ' done' },
  ]);
});

test('mounted overlay protocol preserves malformed sideband-looking text', () => {
  const decoder = createLibreChatStepEventDecoder();
  const malformed = '\u001eLCSTEP:not-base64-json\u001f';

  assert.deepEqual(decoder.push(malformed), [{ type: 'text', text: malformed }]);
});

test('n8n patched event stream forwards real tool output correlated to the model tool-call id', async () => {
  const sent = [];
  const ctx = { sendChunk: (...args) => sent.push(args) };
  const events = [
    {
      event: 'on_chat_model_end',
      data: {
        output: {
          content: '',
          tool_calls: [
            {
              id: 'call-calc-1',
              name: 'Calculator',
              args: { input: '2343924 * 2347232' },
            },
          ],
        },
      },
    },
    {
      event: 'on_tool_end',
      name: 'Calculator',
      data: { input: { input: '2343924 * 2347232' }, output: '5501733418368' },
    },
  ];

  await processEventStream(ctx, events, 0);

  const toolCall = sent.find(([type]) => type === 'tool_call');
  const toolResult = sent.find(([type]) => type === 'tool_result');
  assert.equal(JSON.parse(toolCall[2]).id, 'call-calc-1');
  assert.equal(JSON.parse(toolResult[2]).id, 'call-calc-1');
  assert.equal(JSON.parse(toolResult[2]).output, '5501733418368');
  assert.equal(sent.some(([type]) => type === 'tool_error'), false);
});

test('n8n patched event stream reports tool errors instead of inventing successful results', async () => {
  const sent = [];
  const ctx = { sendChunk: (...args) => sent.push(args) };
  const events = [
    {
      event: 'on_chat_model_end',
      data: {
        output: {
          content: '',
          tool_calls: [{ id: 'call-wait-1', name: 'wait_test_tool', args: { delayMs: 10 } }],
        },
      },
    },
    {
      event: 'on_tool_error',
      name: 'wait_test_tool',
      data: { error: new Error('runner unavailable') },
    },
  ];

  await processEventStream(ctx, events, 0);

  const toolError = sent.find(([type]) => type === 'tool_error');
  assert.equal(JSON.parse(toolError[2]).id, 'call-wait-1');
  assert.match(JSON.parse(toolError[2]).error, /runner unavailable/);
  assert.equal(sent.some(([type]) => type === 'tool_result'), false);
});

test('n8n patched event stream emits an error for active calls if the event stream throws', async () => {
  const sent = [];
  const ctx = { sendChunk: (...args) => sent.push(args) };
  async function* events() {
    yield {
      event: 'on_chat_model_end',
      data: {
        output: {
          content: '',
          tool_calls: [{ id: 'call-crash-1', name: 'wait_test_tool', args: { delayMs: 10 } }],
        },
      },
    };
    throw new Error('stream disconnected');
  }

  await assert.rejects(processEventStream(ctx, events(), 0), /stream disconnected/);
  const toolError = sent.find(([type]) => type === 'tool_error');
  assert.equal(JSON.parse(toolError[2]).id, 'call-crash-1');
  assert.match(JSON.parse(toolError[2]).error, /stream disconnected/);
});
