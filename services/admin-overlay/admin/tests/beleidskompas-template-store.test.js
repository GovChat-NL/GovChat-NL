const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const connection = require("../db/connection");
const { createTemplateStore } = require("../lib/beleidskompas/template-store");
const { isUniqueViolation } = require("../lib/beleidskompas/store-errors");
const { skip, openTestPool } = require("./db-fixture");

const opts = { skip };
let close, db, store;

before(async () => {
  if (skip) return;
  const fixture = await openTestPool("beleidskompas_store_test");
  close = fixture.close;
  db = { query: (sql, params) => fixture.pool.query(sql, params), transaction: (fn) => connection.transaction(fixture.pool, fn) };
  store = createTemplateStore(db);
});
after(async () => { if (close) await close(); });

const doc = (text) => store.upsertDocument({ filename: `${text}.txt`, contentType: "text/plain", bytes: Buffer.from(text), previewText: text });

test("createTemplate writes version 1 and saveVersion numbers upward", opts, async () => {
  const { template, version } = await store.createTemplate({ name: "A", snapshot: { title: "A", steps: [] }, documentIds: [], note: "init" });
  assert.equal(version.version, 1);
  const v2 = await store.saveVersion(template.id, { title: "A2", steps: [] }, [], "edit");
  assert.equal(v2.version.version, 2);
  assert.equal((await store.getCurrent(template.id)).versionId, v2.version.id);
  const [t] = await store.listTemplates();
  // Nothing is deployed yet, so no version is live; saving never makes one live.
  assert.equal(t.live_version_id, null);
  assert.equal(t.versions[0].is_live, false);
  assert.equal(t.versions[1].is_live, false);
  assert.deepEqual(t.versions[0].snapshot, { title: "A2", steps: [] });
  assert.equal(typeof t.versions[0].published_at, "string");
});

test("upload reuses bytes by hash and pins documents per version", opts, async () => {
  const a = await store.upsertDocument({ filename: "a.txt", contentType: "text/plain", bytes: Buffer.from("same"), previewText: "same" });
  const b = await store.upsertDocument({ filename: "b.txt", contentType: "text/plain", bytes: Buffer.from("same"), previewText: "same" });
  assert.equal(a.id, b.id); assert.equal(a.reused, false); assert.equal(b.reused, true);
  const got = await store.getDocument(a.id);
  assert.equal(got.filename, "a.txt");
  assert.deepEqual(got.content, Buffer.from("same"));
  assert.equal(await store.getDocument(999999), null);
});

test("listDocuments shows history with active flag", opts, async () => {
  const d1 = await doc("hist-1");
  const d2 = await doc("hist-2");
  const { template } = await store.createTemplate({ name: "H", snapshot: {}, documentIds: [d1.id, d2.id], note: "" });
  await store.saveVersion(template.id, {}, [d2.id], "drop doc 1");
  const docs = await store.listDocuments(template.id);
  assert.equal(docs.length, 2);
  assert.equal(docs.find((d) => d.id === d1.id).active, false);
  assert.equal(docs.find((d) => d.id === d2.id).active, true);
  assert.equal(docs[0].size_bytes, 6);
  assert.equal(typeof docs[0].uploaded_at, "string");
});

test("renameDocument changes the filename", opts, async () => {
  const d = await doc("rename-me");
  await store.renameDocument(d.id, "renamed.txt");
  assert.equal((await store.getDocument(d.id)).filename, "renamed.txt");
});

test("saving never moves the live pointer; setLive does", opts, async () => {
  const d = await doc("live-doc");
  const d2 = await doc("live-doc-2");
  const { template, version } = await store.createTemplate({ name: "L", snapshot: { v: 1 }, documentIds: [d.id], note: "" });
  await store.setLive(template.id, version.id);
  const saved = await store.saveVersion(template.id, { v: 2 }, [d.id, d2.id], "");
  const live = await store.getLive();
  assert.equal(live.template_id, template.id);
  assert.equal(live.version_id, version.id);
  assert.deepEqual(live.snapshot, { v: 1 });
  assert.deepEqual(live.documents.map((x) => x.id), [d.id]);
  assert.equal("active" in live.documents[0], false);

  const listed = (await store.listTemplates()).find((t) => t.id === template.id);
  assert.equal(listed.live_version_id, version.id);
  assert.deepEqual(listed.versions.filter((v) => v.is_live).map((v) => v.id), [version.id]);
  const other = (await store.listTemplates()).find((t) => t.id !== template.id);
  assert.equal(other.live_version_id, null);

  await store.setLive(template.id, saved.version.id);
  const moved = await store.getLive();
  assert.equal(moved.version_id, saved.version.id);
  assert.deepEqual(moved.snapshot, { v: 2 });
  assert.deepEqual(moved.documents.map((x) => x.id), [d.id, d2.id]);
});

test("createTemplate copies document links, not bytes", opts, async () => {
  const x = await doc("copy-x");
  const src = await store.createTemplate({ name: "Src", snapshot: {}, documentIds: [x.id], note: "" });
  const copy = await store.createTemplate({ name: "Copy", snapshot: {}, documentIds: [x.id], createdFromVersionId: src.version.id, note: "" });
  assert.equal(copy.template.created_from_version_id, src.version.id);
  const cur = await store.getCurrent(copy.template.id);
  assert.deepEqual(cur.documentIds, [x.id]);
  const n = await db.query("SELECT count(*)::int AS n FROM documents WHERE filename = 'copy-x.txt'");
  assert.equal(n.rows[0].n, 1);
  assert.equal(await store.getCurrent(999999), null);
});

test("concurrent saves: both succeed, the second one with the next version number", opts, async () => {
  const { template } = await store.createTemplate({ name: "C", snapshot: {}, documentIds: [], note: "" });
  // Hold back both inserts until each has started, so they really overlap.
  let release;
  const gate = db.transaction(async (q) => {
    await q("LOCK TABLE template_versions IN SHARE MODE");
    await new Promise((r) => { release = r; });
  });
  while (!release) await new Promise((r) => setImmediate(r));
  const saves = Promise.allSettled([
    store.saveVersion(template.id, { a: 1 }, [], ""),
    store.saveVersion(template.id, { b: 1 }, [], ""),
  ]);
  const waiting = "SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND relation = 'template_versions'::regclass";
  for (let tries = 0; (await db.query(waiting)).rows[0].n < 2; tries++) {
    if (tries === 50) { release(); await gate; assert.fail("saves never reached the lock"); }
    await new Promise((r) => setTimeout(r, 100));
  }
  release();
  await gate;
  const results = await saves;
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(results.map((r) => r.value.version.version).sort(), [2, 3]);
});

test("transaction rolls back on throw", opts, async () => {
  const before = (await db.query("SELECT count(*)::int AS n FROM templates")).rows[0].n;
  await assert.rejects(db.transaction(async (q) => {
    await q("INSERT INTO templates (name) VALUES ($1)", ["x"]);
    throw new Error("boom");
  }));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM templates")).rows[0].n, before);
});

test("isUniqueViolation recognises a duplicate key", opts, async () => {
  const insert = () => db.query("INSERT INTO documents (sha256, filename, content_type, size, content) VALUES ('dup', 'x', 'text/plain', 1, 'x')");
  await insert();
  await assert.rejects(insert(), isUniqueViolation);
});

test("settings round-trip", opts, async () => {
  assert.equal(await store.getSettings(), null);
  await store.saveSettings({ a: 1 });
  await store.saveSettings({ a: 2 });
  assert.deepEqual(await store.getSettings(), { a: 2 });
});

test("importLegacyState maps versions in date order and keeps the legacy live version", opts, async () => {
  const state = {
    versions: [
      { id: "v2", published_at: "2026-02-01T00:00:00.000Z", published_by: "Bob", note: "second", snapshot: { n: 2 } },
      { id: "v1", published_at: "2026-01-01T00:00:00.000Z", published_by: "Ann", note: "first", snapshot: { n: 1 } },
    ],
    documents: [{ filename: "legacy.txt", mime_type: "text/plain", content_base64: Buffer.from("x").toString("base64"), preview_text: "x" }],
    live_version_id: "v1",
  };
  const result = await store.importLegacyState(state, "Legacy");
  const t = (await store.listTemplates()).find((x) => x.id === result.templateId);
  assert.equal(t.name, "Legacy");
  const byId = Object.fromEntries(t.versions.map((v) => [v.id, v]));
  assert.equal(result.newestVersionId, result.versionIds.v2);
  assert.equal(byId[result.versionIds.v1].snapshot.n, 1);
  assert.equal(byId[result.versionIds.v2].snapshot.n, 2);
  const nums = await db.query("SELECT id, version FROM template_versions WHERE template_id = $1", [result.templateId]);
  const num = Object.fromEntries(nums.rows.map((r) => [r.id, r.version]));
  assert.equal(num[result.versionIds.v1], 1);
  assert.equal(num[result.versionIds.v2], 2);
  assert.equal(byId[result.versionIds.v1].published_by, "Ann");
  assert.equal(byId[result.versionIds.v2].published_by, "Bob");
  assert.equal(byId[result.versionIds.v1].published_at, "2026-01-01T00:00:00.000Z");
  assert.equal(byId[result.versionIds.v2].published_at, "2026-02-01T00:00:00.000Z");
  const links = await db.query(
    "SELECT vd.version_id, d.filename FROM version_documents vd JOIN documents d ON d.id = vd.document_id WHERE vd.version_id = ANY($1)",
    [Object.values(result.versionIds)]);
  assert.equal(links.rows.length, 2);
  assert.ok(links.rows.every((r) => r.filename === "legacy.txt"));
  assert.equal(await db.query("SELECT 1 FROM live WHERE template_id = $1", [result.templateId]).then((r) => r.rowCount), 0);
});

test("importLegacyState defaults missing author and mime type, and rolls back on failure", opts, async () => {
  const ok = await store.importLegacyState({
    versions: [{ id: "a", published_at: "2026-03-01T00:00:00.000Z", published_by: null, note: "", snapshot: {} }],
    documents: [{ filename: "nomime.bin", content_base64: Buffer.from("nomime").toString("base64"), preview_text: "" }],
  }, "Defaults");
  const t = (await store.listTemplates()).find((x) => x.id === ok.templateId);
  assert.equal(t.versions[0].published_by, "Onbekend");
  assert.equal((await store.getDocument((await store.listDocuments(ok.templateId))[0].id)).mime_type, "application/octet-stream");

  const before = (await store.listTemplates()).length;
  await assert.rejects(store.importLegacyState({
    versions: [
      { id: "x", published_at: "2026-01-01T00:00:00.000Z", published_by: "A", snapshot: {} },
      { id: "y", published_at: "2026-02-01T00:00:00.000Z", published_by: "A", snapshot: null },
    ],
    documents: [],
  }, "Broken"));
  assert.equal((await store.listTemplates()).length, before);
});

test("createTemplate leaves no template behind when the version fails", opts, async () => {
  const before = (await store.listTemplates()).length;
  await assert.rejects(store.createTemplate({ name: "Bad", snapshot: {}, documentIds: [999999], note: "" }));
  assert.equal((await store.listTemplates()).length, before);
});
