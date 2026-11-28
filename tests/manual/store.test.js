"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createManualStore, atomic } = require("../../services/admin-overlay/admin/lib/manual-store");
const { run } = require("../../scripts/govchat-manual");
const { fixture } = require("./fixture");
function setup(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { dataDir: path.join(root, "private"), publishDir: path.join(root, "public"), ...extra };
  const store = createManualStore(options); store.init();
  return { root, options, store };
}
test("private atomic publication, optimistic draft/live conflicts, restart and rollback", t => {
  const { options, store } = setup(t);
  const initial = store.adminState(), saved = store.save(fixture(), initial);
  assert.equal(store.metadata().enabled, false);
  assert.throws(() => store.save(fixture(), initial), e => e.code === "REVISION_CONFLICT");
  const live = store.publish(saved); assert.equal(live.effective.enabled, true);
  const doc = store.document(); assert.equal(doc.revision, live.baseRevision);
  assert.deepEqual(fs.readdirSync(options.publishDir), ["manual-config.json"]);
  assert.ok(!fs.readFileSync(path.join(options.publishDir, "manual-config.json"), "utf8").includes("Vertrouwelijke"));
  assert.equal(fs.statSync(path.join(store.directory, "state.json")).mode & 0o777, 0o600);
  assert.throws(() => store.publish(saved), e => e.code === "REVISION_CONFLICT");
  const v = fixture(); v.sections[0].title = "Nieuwe titel";
  const next = store.publish(store.save(v, live));
  assert.notEqual(next.baseRevision, live.baseRevision);
  const restarted = createManualStore(options); restarted.init(); assert.equal(restarted.adminState().baseRevision, next.baseRevision);
  const restored = restarted.publish(next, live.baseRevision); assert.notEqual(restored.baseRevision, live.baseRevision); assert.equal(restored.model.sections[0].title, "Welkom");
  assert.equal(store.document().revision, restored.baseRevision);
});
test("invalid drafts do not change live content; publication IO failure fails closed until successful retry", t => {
  let failWrite = false;
  const { store, options } = setup(t, { io: (dir, file, data, mode) => { if (failWrite && file === "manual-config.json") throw new Error("simulated IO failure"); atomic(dir, file, data, mode); } });
  let state = store.publish(store.save(fixture(), store.adminState()));
  assert.throws(() => store.save({ enabled: "invalid" }, state)); assert.equal(store.document().revision, state.baseRevision);
  failWrite = true;
  assert.throws(() => store.disable(state), e => e.code === "PUBLISH_FAILED");
  assert.equal(store.metadata().enabled, false); assert.throws(() => store.document(), e => e.code === "MANUAL_UNAVAILABLE");
  assert.ok(!fs.existsSync(path.join(options.publishDir, "manual-config.json")));
  const restarted = createManualStore(options); assert.throws(() => restarted.init()); assert.equal(restarted.metadata().enabled, false);
  failWrite = false; state = store.publish(store.adminState()); assert.equal(state.effective.enabled, false); assert.throws(() => store.document(), e => e.code === "MANUAL_DISABLED");
});
test("disable blocks browser and agent; hard disable is a deployment upper bound", t => {
  const { store, options } = setup(t);
  const live = store.publish(store.save(fixture(), store.adminState()));
  store.disable(live); assert.equal(store.metadata().autoOpen, "never");
  assert.throws(() => store.document({ agent: true }));
  store.publish(store.save(fixture(), store.adminState()));
  const hard = createManualStore({ ...options, hardDisabled: true }); hard.init(); assert.equal(hard.metadata().enabled, false); assert.equal(hard.adminState().hardDisabled, true);
  assert.throws(() => hard.document());
});
test("file CLI uses same store, explicit paths, private export, import-once and dry-run", t => {
  const { root, options, store } = setup(t);
  const file = path.join(root, "import.json"); fs.writeFileSync(file, JSON.stringify(fixture()));
  const args = ["--data-dir", options.dataDir, "--publish-dir", options.publishDir];
  assert.throws(() => run(["import", ...args], {}));
  const before = store.adminState(); run(["import", ...args, "--file", file, "--dry-run"], {}); assert.equal(store.adminState().draftRevision, before.draftRevision);
  run(["import", ...args, "--file", file], {}); const pub = run(["publish", ...args], {}); assert.equal(pub.effective.enabled, true);
  const exported = path.join(root, "export.json"); run(["export", ...args, "--file", exported], {}); assert.equal(fs.statSync(exported).mode & 0o777, 0o600);
  assert.throws(() => run(["export", ...args, "--file", exported], {}));
  const restarted = createManualStore({ ...options, configFile: "/missing-must-not-be-read-after-initial-import" }); restarted.init(); assert.equal(restarted.adminState().baseRevision, pub.baseRevision);
  assert.equal(run(["validate", "--file", exported], {}).ok, true);
});
test("private state cannot be published; corrupt state fails closed", t => {
  const { store, options } = setup(t);
  assert.throws(() => createManualStore({ dataDir: options.publishDir, publishDir: options.publishDir }));
  fs.writeFileSync(path.join(store.directory, "state.json"), "corrupt"); assert.equal(store.metadata().enabled, false); assert.throws(() => store.document(), e => e.code === "MANUAL_UNAVAILABLE");
});
test("symlink imports/storage and concurrent lock are rejected without leaking private content", t => {
  const { store, root, options } = setup(t);
  const link = path.join(root, "link"); fs.symlinkSync(options.publishDir, link);
  assert.throws(() => createManualStore({ dataDir: link, publishDir: options.publishDir }));
  const input = path.join(root, "input.json"); fs.writeFileSync(input, JSON.stringify(fixture())); fs.symlinkSync(input, path.join(root, "input-link.json"));
  assert.throws(() => run(["validate", "--file", path.join(root, "input-link.json")], {}));
  fs.mkdirSync(path.join(store.directory, "write.lock")); assert.throws(() => store.publish(store.adminState()), e => e.code === "REVISION_CONFLICT"); fs.rmdirSync(path.join(store.directory, "write.lock"));
});
test("profile/deployment/admin precedence preserves explicit empty/false and field reset removes only override", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-precedence-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "deployment.json"); fs.writeFileSync(input, JSON.stringify({ schemaVersion: 1, profile: "limburg", organization: { helpdeskEmail: "deployment@example.org" }, autoOpen: "new-revision" }));
  const store = createManualStore({ dataDir: path.join(root, "private"), publishDir: path.join(root, "public"), configFile: input });
  let state = store.init(); assert.equal(state.model.organization.helpdeskEmail, "deployment@example.org"); assert.equal(state.model.organization.aiEmail, "ai@prvlimburg.nl");
  state = store.save({ organization: { helpdeskEmail: "" }, autoOpen: "never", enabled: false }, state);
  assert.equal(state.model.organization.helpdeskEmail, ""); assert.equal(state.model.autoOpen, "never"); assert.equal(state.sources["organization.helpdeskEmail"], "admin");
  state = store.reset("organization.helpdeskEmail", state); assert.equal(state.model.organization.helpdeskEmail, "deployment@example.org"); assert.equal(state.model.autoOpen, "never");
  state = store.reset("autoOpen", state); assert.equal(state.model.autoOpen, "new-revision"); assert.equal(state.model.enabled, false);
});
