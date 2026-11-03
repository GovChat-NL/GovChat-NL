const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { startRetentionWorker } = require('../scripts/govchat-retention-worker');

function makeRuntime(events, { appConfig = { fileStrategy: 'local' } } = {}) {
  return {
    connectDb: async () => events.push('connect'),
    db: {},
    fileServices: {},
    getAppConfig: async (options) => {
      assert.deepEqual(options, { baseOnly: true });
      events.push('config');
      return appConfig;
    },
    initializeFileStorage: (config) => {
      assert.equal(config, appConfig);
      events.push('storage');
    },
    logger: { info: () => {}, error: () => {} },
    mongoose: { disconnect: async () => events.push('disconnect') },
    runAsSystem: async (callback) => callback(),
  };
}

test('worker initializes LibreChat before starting retention and drains before disconnect', async () => {
  const events = [];
  const processRef = new EventEmitter();
  const stop = await startRetentionWorker({
    runtime: makeRuntime(events),
    processRef,
    startPolicy: (options) => {
      assert.equal(options.db != null, true);
      assert.equal(options.mongoose != null, true);
      events.push('start-policy');
      return async () => events.push('stop-policy');
    },
  });

  assert.deepEqual(events, ['connect', 'config', 'storage', 'start-policy']);
  processRef.emit('SIGTERM');
  await stop();
  assert.deepEqual(events, ['connect', 'config', 'storage', 'start-policy', 'stop-policy', 'disconnect']);
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
  assert.equal(processRef.listenerCount('SIGINT'), 0);
});

test('worker fails closed and disconnects if LibreChat configuration is unavailable', async () => {
  const events = [];
  const runtime = makeRuntime(events, { appConfig: null });
  let policyStarted = false;

  await assert.rejects(
    startRetentionWorker({
      runtime,
      processRef: new EventEmitter(),
      startPolicy: () => {
        policyStarted = true;
        return async () => {};
      },
    }),
    /base configuration is unavailable/,
  );

  assert.equal(policyStarted, false);
  assert.deepEqual(events, ['connect', 'config', 'disconnect']);
});

test('worker disconnects and propagates initialization failures', async () => {
  const events = [];
  const runtime = makeRuntime(events);
  runtime.initializeFileStorage = () => {
    events.push('storage');
    throw new Error('storage initialization failed');
  };

  await assert.rejects(
    startRetentionWorker({ runtime, processRef: new EventEmitter() }),
    /storage initialization failed/,
  );
  assert.deepEqual(events, ['connect', 'config', 'storage', 'disconnect']);
});
