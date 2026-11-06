"use strict";

// Execute inside a disposable container with the repository mounted read-only.
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const directory = fs.mkdtempSync("/tmp/govchat-utility-deps-");
for (const name of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join("services/admin-overlay/admin", name), path.join(directory, name));
const install = cp.spawnSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: directory, stdio: "inherit" });
if (install.status !== 0) process.exit(install.status || 1);
const result = cp.spawnSync(process.execPath, ["--test", "tests/orchestrator/utility-tools.test.js", "tests/orchestrator/utility-server.test.js", "tests/orchestrator/prompt-management.test.js", "tests/orchestrator/prompt-routes.test.js", "tests/orchestrator/prompt-editor.test.js", "tests/orchestrator/name-management.test.js", "tests/orchestrator/name-routes.test.js", "tests/orchestrator/name-editor.test.js", "tests/orchestrator/name-overlay-loader.test.js"], {
  stdio: "inherit", env: { ...process.env, NODE_PATH: path.join(directory, "node_modules") },
});
process.exit(result.status || (result.signal ? 1 : 0));
