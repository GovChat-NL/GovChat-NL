#!/usr/bin/env node
"use strict";
// File-only management uses EXACTLY the same private store/compiler as the admin API.
const fs = require("node:fs");
const path = require("node:path");
const { resolve, migrate } = require("../services/admin-overlay/admin/lib/manual-model");
const { createManualStore, readFile, atomic } = require("../services/admin-overlay/admin/lib/manual-store");
function run(argv = process.argv.slice(2), env = process.env) {
  const [action, ...args] = argv;
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") options.dryRun = true;
    else if (["--file", "--data-dir", "--publish-dir", "--revision"].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
    else throw new Error("Onbekend of onvolledig argument");
  }
  if (!["validate", "migrate", "import", "export", "state", "publish", "rollback", "disable"].includes(action)) throw new Error("Acties: validate, migrate, import, export, state, publish, rollback, disable");
  if (["validate", "migrate", "import", "export"].includes(action) && !options.file) throw new Error("Eén expliciet --file pad is vereist");
  const readModel = () => migrate(readFile(options.file, 2200000));
  if (action === "validate") return { ok: true, schemaVersion: resolve(readModel()).schemaVersion };
  if (action === "migrate") return readModel();
  const dataDir = options["data-dir"] || env.DATA_DIR, publishDir = options["publish-dir"] || env.PUBLISH_DIR;
  if (!dataDir || !publishDir) throw new Error("Expliciete --data-dir en --publish-dir vereist (of DATA_DIR/PUBLISH_DIR)");
  if (options.dryRun && action === "import") { resolve(readModel()); return { ok: true, dryRun: true }; }
  const hard = env.GOVCHAT_MANUAL_HARD_DISABLED || "false";
  if (!["true", "false"].includes(hard)) throw new Error("Ongeldige harde disable");
  const store = createManualStore({ dataDir, publishDir, hardDisabled: hard === "true" });
  if (!options.dryRun) store.init();
  const current = store.adminState();
  if (action === "rollback" && !options.revision) throw new Error("Rollback vereist --revision");
  if (options.dryRun && ["publish", "rollback", "disable"].includes(action)) return store.plan(current, action === "rollback" ? options.revision : undefined, action === "disable");
  if (options.dryRun) return { ok: true, dryRun: true, model: resolve(current.model), baseRevision: current.baseRevision };
  if (action === "state") return current;
  if (action === "import") { const raw = readFile(options.file, 2200000); return store.save(raw.schemaVersion === undefined ? migrate(raw) : raw, current, "script-import"); }
  if (action === "export") {
    if (fs.existsSync(options.file)) throw new Error("Exportpad bestaat al; kies bewust een nieuw pad");
    atomic(path.dirname(path.resolve(options.file)), path.basename(options.file), current.model);
    return { ok: true };
  }
  if (action === "publish") return store.publish(current);
  if (action === "disable") return store.disable(current);
  if (!options.revision) throw new Error("Rollback vereist --revision");
  return store.publish(current, options.revision);
}
if (require.main === module) {
  try { console.log(JSON.stringify(run(), null, 2)); } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code || "INVALID_INPUT", message: error.message })); process.exitCode = 1; }
}
module.exports = { run };
