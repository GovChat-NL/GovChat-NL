"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const cp = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

test("real admin editor and allowlisted assets preserve auth, private caching and fetch-only bootstrap", async t => {
  const parent = path.resolve(__dirname, "../../.manual-tools/tmp"); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "editor-http-"));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const serverPath = path.resolve(__dirname, "../../services/admin-overlay/admin/server.js");
  const child = cp.spawn(process.execPath, ["-e", `globalThis.fetch=async()=>{throw Error('TEST: no outbound network')};require(${JSON.stringify(serverPath)})`], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: "editor-test-password", DATA_DIR: path.join(root, "data"), PUBLISH_DIR: path.join(root, "public"), PUBLIC_BASE_URL: "", GOVCHAT_MANUAL_CONFIG_FILE: "", GOVCHAT_MANUAL_HARD_DISABLED: "false", IMAGE_JOBS_ENABLED: "false", CRAWLER_INTERNAL_TOKEN: "test-only", N8N_ORCHESTRATOR_ENABLE_NOS_NEWS: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = ""; child.stdout.on("data", data => logs += data); child.stderr.on("data", data => logs += data);
  t.after(async () => { if (child.exitCode === null) { const exit = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exit; } fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let index = 0; index < 150; index++) { if (child.exitCode !== null) assert.fail(logs); try { await fetch(base + "/login"); ready = true; break; } catch { await delay(30); } }
  assert.equal(ready, true, logs);
  for (const route of ["/help-editor", "/help-editor-assets/editor.js", "/help-editor-assets/editor.css"]) {
    const response = await fetch(base + route, { redirect: "manual" }); assert.equal(response.status, 302); assert.equal(response.headers.get("location"), "/login");
  }
  const unauth = await fetch(base + "/api/admin/manual"); assert.equal(unauth.status, 401);
  const login = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "editor-test-password" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const headers = { cookie, "content-type": "application/json" };
  const state = await (await fetch(base + "/api/admin/manual", { headers })).json();
  // Malicious metadata must never be included in HTML or executable bootstrap.
  const poison = '</script><script>globalThis.__editorPoison=1</script>&\u2028{{jsonData}}';
  const savedResponse = await fetch(base + "/api/admin/manual/draft", { method: "PUT", headers, body: JSON.stringify({ model: { title: poison }, baseRevision: state.baseRevision, draftRevision: state.draftRevision }) });
  assert.equal(savedResponse.status, 200); const saved = await savedResponse.json(); assert.equal(saved.model.title, poison);
  const page = await fetch(base + "/help-editor", { headers }); assert.equal(page.status, 200);
  const html = await page.text(); assert.doesNotMatch(html, /__editorPoison|\{\{jsonData\}\}/);
  assert.match(page.headers.get("cache-control"), /no-store/); assert.match(page.headers.get("vary"), /Cookie/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff"); assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  for (const [file, type] of [["editor.js", "javascript"], ["editor.css", "css"]]) {
    const asset = await fetch(base + "/help-editor-assets/" + file, { headers }); assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), new RegExp(type)); assert.match(asset.headers.get("cache-control"), /private, no-store/); assert.match(asset.headers.get("vary"), /Cookie/); assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
  }
  for (const file of ["state.json", "manual.json", "server.js", "help-editor.html", "not-an-asset.js"]) assert.equal((await fetch(base + "/help-editor-assets/" + file, { headers })).status, 404);
  const trailing = await fetch(base + "/help-editor/", { headers, redirect: "manual" }); assert.equal(trailing.status, 302); assert.equal(trailing.headers.get("location"), "../help-editor");
  const cross = await fetch(base + "/api/admin/manual/preview", { method: "POST", headers: { ...headers, origin: "https://evil.invalid", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ model: saved.overrides }) }); assert.equal(cross.status, 403);
  // The editor HTML still loads when state storage is unavailable; the API reports the failure.
  fs.writeFileSync(path.join(root, "data/manual/state.json"), "corrupt-private-state");
  assert.equal((await fetch(base + "/help-editor", { headers })).status, 200);
  assert.equal((await fetch(base + "/api/admin/manual", { headers })).status, 503);
});
