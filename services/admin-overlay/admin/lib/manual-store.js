"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ManualError, resolve, migrate, compile, revision, clone, CAPABILITIES, RIGHTS } = require("./manual-model");
function mergeOverrides(defaults, overrides) {
  const result = { ...defaults, ...overrides };
  if (defaults.organization || overrides.organization) result.organization = { ...(defaults.organization || {}), ...(overrides.organization || {}) };
  if (defaults.visibility || overrides.visibility) {
    result.visibility = { ...(defaults.visibility || {}), ...(overrides.visibility || {}) };
    for (const key of ["chapters", "topics", "categories", "articles"]) if (defaults.visibility?.[key] || overrides.visibility?.[key]) result.visibility[key] = { ...(defaults.visibility?.[key] || {}), ...(overrides.visibility?.[key] || {}) };
  }
  return result;
}
function validateOverrideShape(model) {
  if (!model || typeof model !== "object" || Array.isArray(model)) throw new ManualError("INVALID_MANUAL", "Ongeldig conceptmodel");
  for (const key of ["organization", "visibility"]) if (model[key] !== undefined && (!model[key] || typeof model[key] !== "object" || Array.isArray(model[key]))) throw new ManualError("INVALID_MANUAL", "Ongeldig conceptmodel");
  for (const key of ["chapters", "topics", "categories", "articles"]) if (model.visibility?.[key] !== undefined && (!model.visibility[key] || typeof model.visibility[key] !== "object" || Array.isArray(model.visibility[key]))) throw new ManualError("INVALID_MANUAL", "Ongeldige zichtbaarheid");
}
function sources(model, defaults, overrides, source) {
  const profile = model.profile === "limburg" ? require("../defaults/manual-limburg.json").organization : {};
  const result = {};
  for (const key of Object.keys(model)) result[key] = Object.hasOwn(overrides, key) ? source : Object.hasOwn(defaults, key) ? "deployment-file" : "default";
  for (const key of Object.keys(model.organization)) result[`organization.${key}`] = Object.hasOwn(overrides.organization || {}, key) ? source : Object.hasOwn(defaults.organization || {}, key) ? "deployment-file" : Object.hasOwn(profile, key) ? "profile" : "default";
  result["visibility.errors"] = Object.hasOwn(overrides.visibility || {}, "errors") ? source : Object.hasOwn(defaults.visibility || {}, "errors") ? "deployment-file" : "default";
  for (const group of ["chapters", "topics", "categories", "articles"]) for (const id of Object.keys(model.visibility[group])) result[`visibility.${group}.${id}`] = Object.hasOwn(overrides.visibility?.[group] || {}, id) ? source : Object.hasOwn(defaults.visibility?.[group] || {}, id) ? "deployment-file" : "default";
  return result;
}
function rejectSymlinks(target) {
  const absolute = path.resolve(target), parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Manual storage/import cannot follow symlinks"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function atomic(directory, filename, value, mode = 0o600) {
  rejectSymlinks(path.join(directory, filename));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${filename}.${revision()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, path.join(directory, filename));
    const directoryFd = fs.openSync(directory, "r"); try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
}
function readFile(filename, limit = 48000000) {
  rejectSymlinks(filename);
  // De leaf mag tussen padcontrole en lezen niet alsnog een symlink worden.
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new ManualError("MANUAL_UNAVAILABLE", "Handleidingopslag is ongeldig", 503);
    const text = fs.readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > limit) throw new ManualError("MANUAL_UNAVAILABLE", "Handleidingopslag is te groot", 503);
    return JSON.parse(text);
  } finally { fs.closeSync(fd); }
}
function createManualStore({ dataDir, publishDir, hardDisabled = false, configFile = "", io = atomic }) {
  let locallyBlocked = false;
  let writing = false;
  let retainLock = false;
  const directory = path.join(dataDir, "manual");
  const filename = path.join(directory, "state.json"), blocked = path.join(directory, "blocked.json"), lock = path.join(directory, "write.lock");
  // This directory must NOT be inside the public asset tree.
  const privatePath = path.resolve(directory), publicPath = path.resolve(publishDir);
  rejectSymlinks(privatePath); rejectSymlinks(publicPath);
  if (privatePath === publicPath || privatePath.startsWith(publicPath + path.sep)) throw new Error("Private manual storage cannot be in the publish directory");
  function read() {
    try {
      const state = readFile(filename);
      if (state.version !== 1 || !Array.isArray(state.history) || !state.live?.revision || !state.draftRevision) throw new Error();
      resolve(state.live.model); resolve(state.draft);
      return state;
    } catch (error) { throw new ManualError("MANUAL_UNAVAILABLE", "De handleiding is tijdelijk niet beschikbaar", 503); }
  }
  function withLock(action) {
    rejectSymlinks(directory); rejectSymlinks(publishDir); rejectSymlinks(lock);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw new ManualError("REVISION_CONFLICT", "Een andere schrijver is actief; lees de actuele revisie opnieuw", 409); }
    writing = true;
    try { return action(); } finally { writing = false; if (!retainLock) fs.rmdirSync(lock); }
  }
  function isBlocked() {
    // Ook een achtergebleven lock of een dangling symlink mag geen oude publicatie vrijgeven.
    try { rejectSymlinks(blocked); rejectSymlinks(lock); }
    catch { return true; }
    return locallyBlocked || fs.existsSync(blocked) || (!writing && fs.existsSync(lock));
  }
  function record(model, source, overrides = {}) {
    const rev = revision();
    return { revision: rev, publishedAt: new Date().toISOString(), source, overrides, model, compiled: compile(model, { revision: rev, capabilities: CAPABILITIES, rights: RIGHTS }) };
  }
  function metadata() {
    try {
      const live = read().live;
      const enabled = live.model.enabled && !hardDisabled && !isBlocked();
      return { schemaVersion: 1, enabled, revision: live.revision, autoOpen: enabled ? live.model.autoOpen : "never", agentEnabled: enabled && live.model.agentEnabled };
    } catch { return { schemaVersion: 1, enabled: false, revision: null, autoOpen: "never", agentEnabled: false }; }
  }
  function publishMetadata() { io(publishDir, "manual-config.json", metadata(), 0o644); }
  function invalidate() {
    locallyBlocked = true;
    // Persist a fail-closed marker before touching the authoritative publication.
    try { atomic(directory, "blocked.json", { blocked: true }); retainLock = false; }
    catch (error) {
      // Als de marker niet duurzaam geschreven kan worden, behoud de reeds bestaande
      // lock. Andere processen en een herstart mogen de oude live staat niet vrijgeven.
      retainLock = true;
      throw error;
    }
    finally {
      // Verwijder oude activatiemetadata ook wanneer het schrijven van de marker faalt.
      for (const name of ["manual-config.json", "help-content.json"]) fs.rmSync(path.join(publishDir, name), { force: true });
    }
  }
  function init() {
    return withLock(() => {
      if (!fs.existsSync(filename)) {
        const base = resolve();
        let draft = base, source = "default", deploymentDefaults = {}, draftOverrides = {};
        if (configFile) { const raw = readFile(configFile, 2200000); deploymentDefaults = raw.schemaVersion === undefined ? migrate(raw) : raw; draft = resolve(deploymentDefaults); source = "deployment-file"; }
        else if (fs.existsSync(path.join(dataDir, "help-content.json"))) { draft = migrate(readFile(path.join(dataDir, "help-content.json"), 2200000)); draftOverrides = draft; source = "legacy-import"; }
        io(directory, "state.json", { version: 1, live: record(base, "default"), deploymentDefaults, draftOverrides, draft, draftSource: source, draftRevision: revision(), history: [] });
      }
      // Never copy legacy HTML into public assets, including on restarts.
      fs.rmSync(path.join(publishDir, "help-content.json"), { force: true });
      try { read(); publishMetadata(); } catch (error) { invalidate(); throw error; }
      return adminState();
    });
  }
  function adminState() {
    const state = read();
    const defaults = state.deploymentDefaults || {}, overrides = state.draftOverrides || {};
    const profileReview = state.draft.profile === "limburg" ? { required: require("../defaults/manual-limburg.json").reviewRequired, note: require("../defaults/manual-limburg.json").note } : null;
    return { model: state.draft, overrides, sources: sources(state.draft, defaults, overrides, state.draftSource), profileReview, baseRevision: state.live.revision, draftRevision: state.draftRevision, source: state.draftSource, hardDisabled, blocked: isBlocked(), effective: metadata(), history: state.history.map(({ revision, publishedAt, source }) => ({ revision, publishedAt, source })) };
  }
  function check(state, expected) {
    if (!expected || expected.baseRevision !== state.live.revision || expected.draftRevision !== state.draftRevision) throw new ManualError("REVISION_CONFLICT", "De handleiding is gewijzigd; laad het actuele concept en vergelijk je wijzigingen", 409);
  }
  function save(model, expected, source = "admin") {
    validateOverrideShape(model);
    const overrides = clone(model);
    return withLock(() => { const state = read(); check(state, expected); const normalized = resolve(mergeOverrides(state.deploymentDefaults || {}, overrides)); state.draft = normalized; state.draftOverrides = overrides; state.draftRevision = revision(); state.draftSource = source; io(directory, "state.json", state); return adminState(); });
  }
  function reset(field, expected) {
    const state = read(); check(state, expected);
    if (typeof field !== "string" || !/^(?:enabled|agentEnabled|autoOpen|profile|title|subtitle|reviewedAt|sections|errorCategories|organization\.[A-Za-z]+|visibility\.(?:errors|(?:chapters|topics|categories|articles)\.[A-Za-z0-9_-]+))$/.test(field)) throw new ManualError("INVALID_INPUT", "Ongeldig resetveld");
    const overrides = clone(state.draftOverrides || {}), parts = field.split(".");
    let known = state.draft;
    for (const key of parts) {
      if (!known || typeof known !== "object" || !Object.hasOwn(known, key)) {
        // Zichtbaarheidsflags zijn sparse: alleen bestaande passage-IDs zijn geldig.
        const group = parts[1], id = parts[2];
        const ids = group === "chapters" ? state.draft.sections.map(s => s.id) : group === "topics" ? state.draft.sections.flatMap(s => s.items.map(n => n.id)) : group === "categories" ? state.draft.errorCategories.map(c => c.id) : group === "articles" ? state.draft.errorCategories.flatMap(c => c.articles.map(n => n.id)) : [];
        if (parts.length === 3 && parts[0] === "visibility" && key === id && ids.includes(id)) break;
        throw new ManualError("INVALID_INPUT", "Onbekend resetveld");
      }
      known = known[key];
    }
    let parent = overrides;
    for (const key of parts.slice(0, -1)) { if (!parent[key]) return save(overrides, expected); parent = parent[key]; }
    delete parent[parts.at(-1)];
    return save(overrides, expected, "admin");
  }
  function publicationModel(state, rollbackRevision, disabling) {
    const restored = rollbackRevision ? state.history.find(r => r.revision === rollbackRevision) : null;
    if (rollbackRevision && !restored) throw new ManualError("PASSAGE_NOT_FOUND", "Historische revisie niet gevonden", 404);
    return { restored, model: resolve(disabling ? { ...clone(state.live.model), enabled: false } : restored ? restored.model : state.draft) };
  }
  function plan(expected, rollbackRevision, disabling = false) {
    const state = read(); check(state, expected);
    return { ok: true, dryRun: true, baseRevision: state.live.revision, model: publicationModel(state, rollbackRevision, disabling).model };
  }
  function publish(expected, rollbackRevision, disabling = false) {
    return withLock(() => {
      const state = read(); check(state, expected);
      const { restored, model } = publicationModel(state, rollbackRevision, disabling);
      const overrides = disabling ? { ...(state.live.overrides || {}), enabled: false } : restored ? restored.overrides || restored.model : state.draftOverrides || state.draft;
      const next = record(model, disabling ? "disable" : restored ? "rollback" : state.draftSource, overrides);
      try {
        invalidate();
        state.history = [state.live, ...state.history].slice(0, 10);
        state.live = next; state.draft = model; state.draftOverrides = overrides; state.draftRevision = revision(); state.draftSource = next.source;
        // Keep bounded history within the private read budget even for a near-limit model.
        while (state.history.length && Buffer.byteLength(JSON.stringify(state)) > 44000000) state.history.pop();
        io(directory, "state.json", state);
        // Metadata is not authoritative for browser/tool reads. Keep blocked until it was written.
        io(publishDir, "manual-config.json", { schemaVersion: 1, enabled: model.enabled && !hardDisabled, revision: next.revision, autoOpen: model.enabled && !hardDisabled ? model.autoOpen : "never", agentEnabled: model.enabled && model.agentEnabled && !hardDisabled }, 0o644);
        fs.rmSync(blocked, { force: true });
        locallyBlocked = false;
      } catch {
        try { invalidate(); } catch { /* in-process and persisted publication stay unavailable when possible */ }
        throw new ManualError("PUBLISH_FAILED", "Publicatie mislukt; de handleiding is geblokkeerd tot een geslaagde publicatie", 503);
      }
      return adminState();
    });
  }
  function document(context = {}) {
    if (isBlocked() || writing) throw new ManualError("MANUAL_UNAVAILABLE", "De handleiding is tijdelijk niet beschikbaar", 503);
    const live = read().live;
    if (hardDisabled || !live.model.enabled) throw new ManualError("MANUAL_DISABLED", "De handleiding is uitgeschakeld", 404);
    if (context.agent && !live.model.agentEnabled) throw new ManualError("TOOL_DISABLED", "De handleidingtool is uitgeschakeld", 403);
    return compile(live.model, { revision: live.revision, capabilities: context.capabilities, rights: context.rights });
  }
  function preview(model, context = {}) { validateOverrideShape(model); return compile(resolve(mergeOverrides(read().deploymentDefaults || {}, model)), { ...context, hardDisabled, preview: true }); }
  function disable(expected) {
    // One locked publication, with invalidation BEFORE any write that could fail.
    // Disable the live model, not an unrelated draft (and never a two-step save/publish).
    return publish(expected, undefined, true);
  }
  return { init, adminState, save, reset, plan, publish, disable, document, preview, metadata, directory };
}
module.exports = { createManualStore, atomic, readFile, rejectSymlinks };
