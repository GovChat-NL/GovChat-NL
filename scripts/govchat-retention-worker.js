const path = require('node:path');
const { createRequire } = require('node:module');
const { startGovChatRetentionPolicy } = require('./govchat-retention-policy');

const DEFAULT_API_ROOT = '/app/api';

function loadLibreChatRuntime(apiRoot = process.env.GOVCHAT_LIBRECHAT_API_ROOT || DEFAULT_API_ROOT) {
  const resolvedApiRoot = path.resolve(apiRoot);
  const apiRequire = createRequire(path.join(resolvedApiRoot, 'package.json'));
  apiRequire('module-alias')({ base: resolvedApiRoot });

  const mongoose = apiRequire('mongoose');
  const { connectDb } = apiRequire(path.join(resolvedApiRoot, 'db'));
  const db = apiRequire(path.join(resolvedApiRoot, 'models'));
  const { getAppConfig } = apiRequire(path.join(resolvedApiRoot, 'server/services/Config'));
  const fileServices = apiRequire(path.join(resolvedApiRoot, 'server/services/Files/process'));
  const { initializeFileStorage } = apiRequire('@librechat/api');
  const { logger, runAsSystem } = apiRequire('@librechat/data-schemas');

  if (typeof initializeFileStorage !== 'function') {
    throw new Error('LibreChat initializeFileStorage export is unavailable; refusing to run retention');
  }
  if (typeof fileServices.processDeleteRequest !== 'function' || typeof fileServices.sweepExpiredFiles !== 'function') {
    throw new Error('LibreChat file deletion services are unavailable; refusing to run retention');
  }

  return { connectDb, db, fileServices, getAppConfig, initializeFileStorage, logger, mongoose, runAsSystem };
}

async function startRetentionWorker({
  runtime,
  loadRuntime = loadLibreChatRuntime,
  startPolicy = startGovChatRetentionPolicy,
  processRef = process,
} = {}) {
  const initializedRuntime = runtime ?? loadRuntime();
  const { connectDb, db, getAppConfig, initializeFileStorage, logger, mongoose, runAsSystem } = initializedRuntime;
  let stopPolicy;
  try {
    await connectDb();
    const appConfig = await getAppConfig({ baseOnly: true });
    if (!appConfig) throw new Error('LibreChat base configuration is unavailable; refusing to run retention');
    initializeFileStorage(appConfig);

    stopPolicy = startPolicy({
      db,
      mongoose,
      runAsSystem,
      appConfig,
      loadAppConfig: getAppConfig,
      logger,
    });
  } catch (error) {
    await mongoose.disconnect().catch((disconnectError) => {
      logger.error('[govchat-retention] Could not close MongoDB after startup failure', disconnectError);
    });
    throw error;
  }

  let stopping;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      processRef.removeListener('SIGTERM', onSigterm);
      processRef.removeListener('SIGINT', onSigint);
      try {
        await stopPolicy();
      } finally {
        await mongoose.disconnect();
      }
      logger.info('[govchat-retention] Worker stopped cleanly');
    })();
    return stopping;
  };
  const onSigterm = () => {
    logger.info('[govchat-retention] SIGTERM received; draining current sweep');
    stop().catch((error) => {
      logger.error('[govchat-retention] Shutdown failed', error);
      processRef.exitCode = 1;
    });
  };
  const onSigint = () => {
    logger.info('[govchat-retention] SIGINT received; draining current sweep');
    stop().catch((error) => {
      logger.error('[govchat-retention] Shutdown failed', error);
      processRef.exitCode = 1;
    });
  };
  processRef.once('SIGTERM', onSigterm);
  processRef.once('SIGINT', onSigint);
  logger.info('[govchat-retention] Dedicated worker initialized');
  return stop;
}

if (require.main === module) {
  startRetentionWorker().catch((error) => {
    console.error('[govchat-retention] Worker startup failed; refusing to run without initialized LibreChat services', error);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_API_ROOT, loadLibreChatRuntime, startRetentionWorker };
