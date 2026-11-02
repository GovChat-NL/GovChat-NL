const fs = require('fs/promises');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = Object.freeze({
  chats: 30,
  uploads: 30,
  prompts: 730,
  images: 30,
  sweepIntervalMinutes: 60,
});
const BATCH_SIZE = 500;

function positiveInteger(value, fallback, name, logger = console) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  logger.warn(`[govchat-retention] Invalid ${name}; using safe default ${fallback}`);
  return fallback;
}

function readRetentionConfig(env = process.env, logger = console) {
  const chatsHours = positiveInteger(
    env.GOVCHAT_CHAT_RETENTION_HOURS,
    DEFAULTS.chats * 24,
    'GOVCHAT_CHAT_RETENTION_HOURS',
    logger,
  );
  const uploadsDays = positiveInteger(
    env.GOVCHAT_UPLOAD_RETENTION_DAYS,
    DEFAULTS.uploads,
    'GOVCHAT_UPLOAD_RETENTION_DAYS',
    logger,
  );
  const promptsDays = positiveInteger(
    env.GOVCHAT_PROMPT_RETENTION_DAYS,
    DEFAULTS.prompts,
    'GOVCHAT_PROMPT_RETENTION_DAYS',
    logger,
  );
  const imagesDays = positiveInteger(
    env.GOVCHAT_GENERATED_IMAGE_RETENTION_DAYS,
    DEFAULTS.images,
    'GOVCHAT_GENERATED_IMAGE_RETENTION_DAYS',
    logger,
  );
  const requestedInterval = positiveInteger(
    env.GOVCHAT_RETENTION_SWEEP_INTERVAL_MINUTES,
    DEFAULTS.sweepIntervalMinutes,
    'GOVCHAT_RETENTION_SWEEP_INTERVAL_MINUTES',
    logger,
  );
  const shortestRetentionMinutes = Math.min(
    chatsHours * 60,
    uploadsDays * 24 * 60,
    promptsDays * 24 * 60,
    imagesDays * 24 * 60,
  );
  const maxSafeInterval = Math.max(1, Math.floor(shortestRetentionMinutes / 2));
  const sweepIntervalMinutes = Math.min(requestedInterval, maxSafeInterval);
  if (sweepIntervalMinutes !== requestedInterval) {
    logger.warn(`[govchat-retention] Sweep interval capped at ${maxSafeInterval}m to stay below retention ages`);
  }

  return Object.freeze({
    chatsHours,
    uploadsDays,
    promptsDays,
    imagesDays,
    sweepIntervalMinutes,
  });
}

function cutoffDate(now, days, sweepIntervalMinutes = 0) {
  return new Date(now.getTime() - days * DAY_MS + sweepIntervalMinutes * 60 * 1000);
}

function isOlderThan(value, cutoff) {
  if (value == null || value === '') return false;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) && date <= cutoff;
}

function recordCreationDate(record) {
  if (record?.createdAt != null) return record.createdAt;
  return typeof record?._id?.getTimestamp === 'function' ? record._id.getTimestamp() : null;
}

function promptActivityDate(promptGroup) {
  return promptGroup?.updatedAt ?? recordCreationDate(promptGroup);
}

function shouldExpirePromptGroup(promptGroup, cutoff) {
  return promptGroup?.source !== 'langfuse' && isOlderThan(promptActivityDate(promptGroup), cutoff);
}

async function deleteConversationFiles({ ids, userId, appConfig, db, processDeleteRequest }) {
  const files = await db.getFiles({ conversationId: { $in: ids } });
  if (!files?.length) return;

  const result = await processDeleteRequest({
    req: {
      user: { id: String(userId) },
      config: appConfig,
      body: {},
    },
    files,
  });
  if (result.failedFileIds?.length) {
    throw new Error(`Storage deletion failed for ${result.failedFileIds.length} conversation file(s)`);
  }
}

async function removeConversationShares({ ids, userId, mongoose }) {
  const SharedLink = mongoose.models.SharedLink;
  const AclEntry = mongoose.models.AclEntry;
  if (!SharedLink) return;

  const shares = await SharedLink.find({ user: userId, conversationId: { $in: ids } })
    .select('_id')
    .lean();
  if (!shares.length) return;
  const shareIds = shares.map((share) => String(share._id));
  await SharedLink.deleteMany({ _id: { $in: shares.map((share) => share._id) } });
  if (AclEntry) {
    await AclEntry.deleteMany({ resourceId: { $in: shareIds } });
  }
}

async function getLatestMessageDate(Message, conversationId) {
  const latest = await Message.findOne({ conversationId })
    .sort({ createdAt: -1 })
    .select('createdAt')
    .lean();
  return latest?.createdAt ?? null;
}

async function hasRecentDescendantMessage({ Conversation, Message, conversation, cutoff }) {
  const userId = String(conversation.user);
  const ids = [conversation.conversationId];
  let frontier = [conversation.conversationId];
  while (frontier.length) {
    const children = await Conversation.find({
      user: userId,
      'subagentThread.parentConversationId': { $in: frontier },
    })
      .select('conversationId')
      .lean();
    frontier = children
      .map((item) => item.conversationId)
      .filter((id) => !ids.includes(id));
    ids.push(...frontier);
  }
  return Boolean(await Message.exists({ conversationId: { $in: ids }, createdAt: { $gt: cutoff } }));
}

async function purgeConversations({ db, mongoose, appConfig, processDeleteRequest, cutoff, logger }) {
  const Conversation = mongoose.models.Conversation;
  const Message = mongoose.models.Message;
  if (!Conversation || !Message) throw new Error('LibreChat Conversation/Message models are unavailable');

  let afterId;
  let deleted = 0;
  while (true) {
    const query = {
      $or: [{ createdAt: { $lte: cutoff } }, { createdAt: null }],
      ...(afterId ? { _id: { $gt: afterId } } : {}),
    };
    const candidates = await Conversation.find(query)
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .select('_id conversationId user createdAt updatedAt')
      .lean();
    if (!candidates.length) break;
    afterId = candidates[candidates.length - 1]._id;

    for (const conversation of candidates) {
      const lastMessageAt = await getLatestMessageDate(Message, conversation.conversationId);
      const activity = lastMessageAt ?? recordCreationDate(conversation);
      if (!isOlderThan(activity, cutoff)) continue;
      if (await hasRecentDescendantMessage({ Conversation, Message, conversation, cutoff })) continue;

      const userId = String(conversation.user);
      const result = await db.deleteConvos(
        userId,
        { conversationId: conversation.conversationId },
        {
          allowEmpty: true,
          beforeDelete: async (ids) => {
            await deleteConversationFiles({ ids, userId, appConfig, db, processDeleteRequest });
            await removeConversationShares({ ids, userId, mongoose });
          },
        },
      );
      deleted += Number(result?.deletedCount ?? 0);
    }
  }
  if (deleted) logger.info(`[govchat-retention] Removed ${deleted} inactive conversation(s)`);
  return deleted;
}

async function expireAndSweepFiles({ mongoose, fileServices, runAsSystem, appConfig, cutoff, now, logger }) {
  const File = mongoose.models.File;
  if (!File) throw new Error('LibreChat File model is unavailable');

  let afterId;
  while (true) {
    const query = {
      $and: [
        { $or: [{ createdAt: { $lte: cutoff } }, { createdAt: null }] },
        { $or: [{ expiredAt: null }, { expiredAt: { $gt: now } }] },
      ],
      ...(afterId ? { _id: { $gt: afterId } } : {}),
    };
    const staleFiles = await File.find(query)
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .select('_id createdAt file_id')
      .lean();
    if (!staleFiles.length) break;
    afterId = staleFiles[staleFiles.length - 1]._id;
    await Promise.all(
      staleFiles
        .filter((file) => isOlderThan(recordCreationDate(file), cutoff))
        .map((file) => File.updateOne({ _id: file._id }, { $set: { expiredAt: now } }, { timestamps: false })),
    );
  }

  let totalDeleted = 0;
  while (true) {
    const result = await runAsSystem(() => fileServices.sweepExpiredFiles({ appConfig, limit: BATCH_SIZE }));
    totalDeleted += Number(result?.deleted ?? 0);
    if (!result || result.scanned < BATCH_SIZE) break;
  }
  if (totalDeleted) logger.info(`[govchat-retention] Removed ${totalDeleted} expired upload(s)`);
  return totalDeleted;
}

async function purgePromptGroups({ mongoose, db, cutoff, logger }) {
  const PromptGroup = mongoose.models.PromptGroup;
  if (!PromptGroup) throw new Error('LibreChat PromptGroup model is unavailable');

  let afterId;
  let deleted = 0;
  while (true) {
    const query = {
      source: { $ne: 'langfuse' },
      $or: [
        { updatedAt: { $lte: cutoff } },
        { updatedAt: null, $or: [{ createdAt: { $lte: cutoff } }, { createdAt: null }] },
        { updatedAt: { $exists: false }, $or: [{ createdAt: { $lte: cutoff } }, { createdAt: null }] },
      ],
      ...(afterId ? { _id: { $gt: afterId } } : {}),
    };
    const groups = await PromptGroup.find(query)
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .select('_id source updatedAt createdAt')
      .lean();
    if (!groups.length) break;
    afterId = groups[groups.length - 1]._id;
    for (const group of groups) {
      if (!shouldExpirePromptGroup(group, cutoff)) continue;
      await db.deletePromptGroup({ _id: String(group._id) });
      deleted += 1;
    }
  }
  if (deleted) logger.info(`[govchat-retention] Removed ${deleted} expired prompt group(s)`);
  return deleted;
}

async function purgeGeneratedImages({ directory, retentionDays, sweepIntervalMinutes = 0, now, logger }) {
  if (!directory) return 0;
  const cutoff = cutoffDate(now, retentionDays, sweepIntervalMinutes);
  let files;
  try {
    files = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  let deleted = 0;
  for (const entry of files) {
    if (!entry.isFile() || !/^generated-[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/i.test(entry.name)) continue;
    const filepath = path.join(directory, entry.name);
    const stat = await fs.stat(filepath);
    if (stat.mtime <= cutoff) {
      await fs.unlink(filepath);
      deleted += 1;
    }
  }
  if (deleted) logger.info(`[govchat-retention] Removed ${deleted} generated image(s)`);
  return deleted;
}

async function runRetentionSweep({ db, mongoose, runAsSystem, appConfig, fileServices, processDeleteRequest, config, logger = console, now = new Date() }) {
  const chatCutoff = cutoffDate(now, config.chatsHours / 24, config.sweepIntervalMinutes);
  const uploadCutoff = cutoffDate(now, config.uploadsDays, config.sweepIntervalMinutes);
  const promptCutoff = cutoffDate(now, config.promptsDays, config.sweepIntervalMinutes);

  await runAsSystem(async () => {
    await purgeConversations({ db, mongoose, appConfig, processDeleteRequest, cutoff: chatCutoff, logger });
    await expireAndSweepFiles({
      mongoose,
      fileServices,
      runAsSystem,
      appConfig,
      cutoff: uploadCutoff,
      now,
      logger,
    });
    await purgePromptGroups({ mongoose, db, cutoff: promptCutoff, logger });
  });

  await purgeGeneratedImages({
    directory: process.env.GOVCHAT_GENERATED_IMAGES_DIR || '/app/client/public/images',
    retentionDays: config.imagesDays,
    sweepIntervalMinutes: config.sweepIntervalMinutes,
    now,
    logger,
  });
}

function makeDistributedLock(mongoose) {
  const collection = mongoose.connection.collection('govchat_retention_locks');
  const owner = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  return {
    async acquire(now, leaseMs) {
      try {
        const result = await collection.findOneAndUpdate(
          { _id: 'global', $or: [{ leaseUntil: { $lte: now } }, { leaseUntil: { $exists: false } }] },
          { $set: { owner, leaseUntil: new Date(now.getTime() + leaseMs) } },
          { upsert: true, returnDocument: 'after' },
        );
        return result?.owner === owner || result?.value?.owner === owner;
      } catch (error) {
        if (error.code === 11000) return false;
        throw error;
      }
    },
    async release() {
      await collection.deleteOne({ _id: 'global', owner });
    },
  };
}

function startGovChatRetentionPolicy({ db, mongoose, runAsSystem, appConfig, loadAppConfig, logger = console }) {
  const config = readRetentionConfig(process.env, logger);
  const fileServices = require('/app/api/server/services/Files/process');
  const processDeleteRequest = fileServices.processDeleteRequest;
  const lock = makeDistributedLock(mongoose);
  let running = false;
  let inFlight;

  const run = async () => {
    if (running) return inFlight;
    running = true;
    inFlight = (async () => {
      let acquired = false;
      try {
        const now = new Date();
        acquired = await lock.acquire(now, 4 * 60 * 60 * 1000);
        if (!acquired) return;
        const currentConfig = (await loadAppConfig?.({ baseOnly: true })) ?? appConfig;
        await runRetentionSweep({
          db,
          mongoose,
          runAsSystem,
          appConfig: currentConfig,
          fileServices,
          processDeleteRequest,
          config,
          logger,
          now,
        });
        logger.info('[govchat-retention] Sweep completed successfully');
      } catch (error) {
        logger.error('[govchat-retention] Sweep failed; it will be retried on the next interval', error);
      } finally {
        if (acquired) {
          await lock.release().catch((error) => logger.error('[govchat-retention] Could not release sweep lock', error));
        }
      }
    })();
    try {
      await inFlight;
    } finally {
      running = false;
      inFlight = undefined;
    }
  };

  const stop = async () => {
    clearTimeout(initial);
    clearInterval(interval);
    await inFlight;
  };

  const initial = setTimeout(run, 30_000);
  const interval = setInterval(run, config.sweepIntervalMinutes * 60 * 1000);
  initial.unref?.();
  interval.unref?.();
  logger.info(
    `[govchat-retention] Enabled: chats=${config.chatsHours}h, uploads=${config.uploadsDays}d, prompts=${config.promptsDays}d (age-based), generated-images=${config.imagesDays}d, sweep=${config.sweepIntervalMinutes}m`,
  );
  return stop;
}

module.exports = {
  DEFAULTS,
  DAY_MS,
  cutoffDate,
  isOlderThan,
  makeDistributedLock,
  positiveInteger,
  recordCreationDate,
  purgeConversations,
  promptActivityDate,
  purgeGeneratedImages,
  readRetentionConfig,
  runRetentionSweep,
  shouldExpirePromptGroup,
  startGovChatRetentionPolicy,
};
