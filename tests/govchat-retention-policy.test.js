const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  cutoffDate,
  isOlderThan,
  makeDistributedLock,
  purgeConversations,
  purgeGeneratedImages,
  readRetentionConfig,
  shouldExpirePromptGroup,
} = require('../scripts/govchat-retention-policy');

test('distributed retention lock excludes concurrent workers and only releases its owner lease', async () => {
  let lease;
  const released = [];
  const collection = {
    async findOneAndUpdate(_filter, update) {
      if (lease && lease.leaseUntil > new Date()) return null;
      lease = { _id: 'global', ...update.$set };
      return { ...lease };
    },
    async deleteOne(filter) {
      released.push(filter);
      if (lease?.owner === filter.owner) lease = undefined;
    },
  };
  const mongoose = { connection: { collection: () => collection } };
  const workerA = makeDistributedLock(mongoose);
  const workerB = makeDistributedLock(mongoose);
  const now = new Date();

  assert.equal(await workerA.acquire(now, 60_000), true);
  assert.equal(await workerB.acquire(now, 60_000), false);
  await workerB.release();
  assert.equal(lease.owner != null, true, 'a non-owner cannot remove the current lease');
  await workerA.release();
  assert.equal(lease, undefined);
  assert.equal(released.length, 2);
  assert.notEqual(released[0].owner, released[1].owner);
});

test('retention settings are independent, defaulted, and reject invalid values safely', () => {
  const config = readRetentionConfig({
    GOVCHAT_CHAT_RETENTION_HOURS: '480',
    GOVCHAT_UPLOAD_RETENTION_DAYS: '30',
    GOVCHAT_PROMPT_RETENTION_DAYS: '730',
    GOVCHAT_GENERATED_IMAGE_RETENTION_DAYS: '14',
    GOVCHAT_RETENTION_SWEEP_INTERVAL_MINUTES: '15',
  });
  assert.deepEqual(config, {
    chatsHours: 480,
    uploadsDays: 30,
    promptsDays: 730,
    imagesDays: 14,
    sweepIntervalMinutes: 15,
  });

  const warnings = [];
  const defaults = readRetentionConfig({ GOVCHAT_UPLOAD_RETENTION_DAYS: '-1' }, {
    warn: (message) => warnings.push(message),
  });
  assert.equal(defaults.chatsHours, 720);
  assert.equal(defaults.uploadsDays, 30);
  assert.equal(defaults.promptsDays, 730);
  assert.equal(warnings.length, 1);

  const capped = readRetentionConfig({
    GOVCHAT_CHAT_RETENTION_HOURS: '2',
    GOVCHAT_RETENTION_SWEEP_INTERVAL_MINUTES: '100',
  }, { warn: (message) => warnings.push(message) });
  assert.equal(capped.sweepIntervalMinutes, 60);
});

test('cutoff comparison expires exactly-at-cutoff records and keeps newer records', () => {
  const now = new Date('2026-10-30T00:00:00.000Z');
  const cutoff = cutoffDate(now, 30);
  assert.equal(cutoff.toISOString(), '2026-09-30T00:00:00.000Z');
  assert.equal(
    cutoffDate(now, 30, 60).toISOString(),
    '2026-09-30T01:00:00.000Z',
    'the sweep margin makes the cutoff early enough to avoid exceeding max age between runs',
  );
  assert.equal(isOlderThan(cutoff, cutoff), true);
  assert.equal(isOlderThan(new Date(cutoff.getTime() + 1), cutoff), false);
  assert.equal(isOlderThan('not-a-date', cutoff), false);
});

test('prompt expiration uses age fallback and excludes source-managed Langfuse groups', () => {
  const cutoff = new Date('2025-01-01T00:00:00.000Z');
  assert.equal(shouldExpirePromptGroup({ createdAt: new Date('2024-01-01') }, cutoff), true);
  assert.equal(
    shouldExpirePromptGroup({ updatedAt: new Date('2025-02-01'), createdAt: new Date('2020-01-01') }, cutoff),
    false,
  );
  assert.equal(
    shouldExpirePromptGroup({ source: 'langfuse', createdAt: new Date('2020-01-01') }, cutoff),
    false,
  );
  assert.equal(shouldExpirePromptGroup({ createdAt: null }, cutoff), false);
});

test('generated image sweep physically unlinks only aged GovChat-generated images', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'govchat-retention-'));
  const oldImage = path.join(directory, 'generated-1000000000-abc123.png');
  const newImage = path.join(directory, `generated-${Date.now()}-def456.png`);
  const unrelated = path.join(directory, 'user-upload.png');
  await Promise.all([oldImage, newImage, unrelated].map((file) => fs.writeFile(file, 'data')));
  const oldDate = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(oldImage, oldDate, oldDate);
  await fs.utimes(unrelated, oldDate, oldDate);

  try {
    assert.equal(await purgeGeneratedImages({
      directory,
      retentionDays: 30,
      now: new Date('2026-10-30T00:00:00.000Z'),
      logger: { info() {} },
    }), 1);
    await assert.rejects(fs.access(oldImage));
    await fs.access(newImage);
    await fs.access(unrelated);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('conversation cleanup keys off latest message and deletes associated files before the chat cascade', async () => {
  const cutoff = new Date('2026-09-30T00:00:00.000Z');
  const conversations = [
    { _id: 'a', conversationId: 'expired', user: 'user-1', createdAt: new Date('2026-01-01') },
    { _id: 'b', conversationId: 'active', user: 'user-2', createdAt: new Date('2026-01-01') },
    { _id: 'c', conversationId: 'parent', user: 'user-3', createdAt: new Date('2026-01-01') },
  ];
  const messages = {
    expired: new Date('2026-09-29T00:00:00.000Z'),
    active: new Date('2026-10-01T00:00:00.000Z'),
    parent: new Date('2026-09-01T00:00:00.000Z'),
    child: new Date('2026-10-02T00:00:00.000Z'),
  };
  const query = (value) => ({
    sort() { return this; },
    limit() { return this; },
    select() { return this; },
    lean: async () => value,
  });
  const Conversation = {
    find(filter) {
      if (filter['subagentThread.parentConversationId']) {
        const parents = filter['subagentThread.parentConversationId'].$in;
        return query(parents.includes('parent') ? [{ conversationId: 'child' }] : []);
      }
      const after = filter._id?.$gt;
      const createdBefore = filter.$or.find((part) => part.createdAt?.$lte)?.createdAt.$lte;
      return query(conversations.filter((item) => item.createdAt <= createdBefore && (!after || item._id > after)));
    },
  };
  const Message = {
    findOne({ conversationId }) {
      return {
        sort() { return this; },
        select() { return this; },
        lean: async () => (messages[conversationId] ? { createdAt: messages[conversationId] } : null),
      };
    },
    exists({ conversationId, createdAt }) {
      const ids = conversationId.$in;
      return Promise.resolve(ids.some((id) => messages[id] > createdAt.$gt));
    },
  };
  const events = [];
  const db = {
    getFiles: async ({ conversationId }) => {
      const ids = conversationId.$in;
      return ids.includes('expired') ? [{ file_id: 'file-1', source: 'local' }] : [];
    },
    deleteConvos: async (userId, filter, options) => {
      await options.beforeDelete([filter.conversationId]);
      events.push(`conversation:${filter.conversationId}`);
      return { deletedCount: 1 };
    },
  };
  const SharedLink = {
    find: () => ({ select: () => ({ lean: async () => [] }) }),
  };
  const AclEntry = { deleteMany: async () => ({}) };

  const deleted = await purgeConversations({
    db,
    mongoose: { models: { Conversation, Message, SharedLink, AclEntry } },
    appConfig: {},
    processDeleteRequest: async ({ files }) => {
      assert.deepEqual(files.map((file) => file.file_id), ['file-1']);
      events.push('file:file-1');
      return { deletedFileIds: ['file-1'], failedFileIds: [] };
    },
    cutoff,
    logger: { info() {} },
  });

  assert.equal(deleted, 1);
  assert.deepEqual(events, ['file:file-1', 'conversation:expired']);
});
