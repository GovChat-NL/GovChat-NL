"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const cp = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

async function startServer(t, { token = "utility-test-token", legacy = { image_data_url_max_chars: 700000, image_max_resolution_px: 2048 } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "govchat-utility-server-"));
  const data = path.join(root, "data");
  const publish = path.join(root, "publish");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "orchestrator-config.json"), JSON.stringify(legacy));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const serverPath = path.resolve(__dirname, "../../services/admin-overlay/admin/server.js");
  const child = cp.spawn(process.execPath, ["-e", `globalThis.fetch=async()=>{throw new Error('TEST: unexpected outbound request')}; require(${JSON.stringify(serverPath)});`], {
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: "test-password", DATA_DIR: data, PUBLISH_DIR: publish, CRAWLER_INTERNAL_TOKEN: token, N8N_WEBHOOK_TOKEN: "", N8N_ORCHESTRATOR_ENABLE_NOS_NEWS: "false", N8N_ORCHESTRATOR_DEFAULT_TIMEZONE: "Europe/Amsterdam", IMAGE_JOBS_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => logs += chunk);
  child.stderr.on("data", (chunk) => logs += chunk);
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exit;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) assert.fail(`Server exited: ${logs}`);
    try { await fetch(base + "/login"); ready = true; break; } catch { await delay(30); }
  }
  assert.equal(ready, true, logs);
  const login = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const policy = () => JSON.parse(fs.readFileSync(path.join(publish, "orchestrator-config.json")));
  const request = async (route, body, headers = {}) => {
    const result = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  };
  return { base, data, publish, cookie, policy, request };
}

test('PR13 publication keeps policy and app config but never publishes code or private feedback', async (t) => {
  const server = await startServer(t);
  // The real image mounts overlay/defaults next to server.js. Seed the same
  // public documents here without writing into the read-only source checkout.
  for (const file of ['apps.json', 'help-content.json']) {
    fs.copyFileSync(path.resolve(__dirname, '../../overlay/defaults', file), path.join(server.data, file));
  }
  // publishAll also runs on the periodic refresh, after policy-only startup.
  await delay(15100);
  assert.ok(server.policy().tools);
  for (const file of ['apps.json', 'help-content.json', 'beleidskompas-config.json']) {
    assert.ok(fs.existsSync(path.join(server.publish, file)), `Missing public config: ${file}`);
  }
  for (const file of ['loader.js', 'custom.css', 'beleidskompas-feedback.json']) {
    assert.equal(fs.existsSync(path.join(server.publish, file)), false);
  }
  assert.equal((await server.request('/api/beleidskompas-feedback', { rating: 'invalid' })).status, 400);
  assert.equal((await server.request('/api/beleidskompas-feedback', {
    rating: 'up', comment: 'Test feedback', step_id: 'stap1', user_id: 'must-not-be-stored', conversation_id: 'private',
  })).status, 201);
  const stored = JSON.parse(fs.readFileSync(path.join(server.data, 'beleidskompas-feedback.json')));
  assert.deepEqual(Object.keys(stored.items[0]).sort(), ['comment', 'created_at', 'id', 'rating', 'step_id']);
  const unauthorized = await fetch(server.base + '/api/beleidskompas-feedback', { redirect: 'manual' });
  assert.ok([302, 401, 403].includes(unauthorized.status));
  const authorized = await fetch(server.base + '/api/beleidskompas-feedback', { headers: { cookie: server.cookie } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).totals.total, 1);
  assert.equal(fs.existsSync(path.join(server.publish, 'beleidskompas-feedback.json')), false);
});

test("real server: startup publishes normalized env/legacy config; authenticated partial saves publish full policy", async (t) => {
  const server = await startServer(t);
  const before = server.policy();
  assert.equal(before.tools.nos_news, false);
  assert.equal(before.tools.calculator, true);
  assert.equal(before.default_timezone, "Europe/Amsterdam");
  assert.equal(before.image_data_url_max_chars, 700000);
  // Exercise the delayed publishAll path while private storage is still legacy/image-only.
  await delay(15100);
  assert.deepEqual(server.policy(), before);
  let result = await server.request("/api/orchestrator/config", { tools: { time: false } }, { cookie: server.cookie });
  assert.equal(result.status, 200);
  assert.deepEqual(server.policy(), result.body.config);
  assert.equal(result.body.config.tools.nos_news, false);
  assert.equal(result.body.config.image_max_resolution_px, 2048);
  result = await server.request("/api/orchestrator/config", { default_timezone: "UTC" }, { cookie: server.cookie });
  assert.equal(result.body.config.tools.time, false);
  assert.equal(server.policy().default_timezone, "UTC");
  assert.deepEqual(fs.readdirSync(server.publish).filter((file) => file.startsWith("orchestrator-config")), ["orchestrator-config.json"]);
  const original = server.policy();
  for (const body of [{ tools: { time: "false" } }, { default_timezone: "Invalid/Timezone" }, { tools: [] }]) {
    assert.equal((await server.request("/api/orchestrator/config", body, { cookie: server.cookie })).status, 400);
    assert.deepEqual(server.policy(), original);
  }
});

test("real route: internal auth, dynamic disabled gate, unsupported calculator and stable input errors", async (t) => {
  const server = await startServer(t);
  const auth = { authorization: "Bearer utility-test-token" };
  assert.equal((await server.request("/api/orchestrator/tools/time", {})).status, 401);
  assert.equal((await server.request("/api/orchestrator/tools/time", {}, { cookie: server.cookie })).status, 401);
  assert.equal((await server.request("/api/orchestrator/tools/calculator", {}, auth)).body.error.code, "UNKNOWN_TOOL");
  assert.equal((await server.request("/api/orchestrator/tools/nos_news", { action: "headlines" }, auth)).body.error.code, "TOOL_DISABLED");
  const converted = await server.request("/api/orchestrator/tools/time", { action: "convert", datetime: "2026-03-29T01:30:00Z", target_timezone: "Europe/Amsterdam" }, auth);
  assert.equal(converted.body.datetime, "2026-03-29T03:30:00+02:00");
  assert.equal(converted.body.ok, true);
  assert.equal((await server.request("/api/orchestrator/tools/time", {}, { "x-govchat-token": "utility-test-token" })).status, 200);
  assert.equal((await server.request("/api/orchestrator/tools/time", null, auth)).body.error.code, "INVALID_INPUT");
  await server.request("/api/orchestrator/config", { tools: { time: false } }, { cookie: server.cookie });
  assert.equal((await server.request("/api/orchestrator/tools/time", {}, auth)).body.error.code, "TOOL_DISABLED");
  const bad = await fetch(server.base + "/api/orchestrator/tools/time", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{" });
  assert.equal((await bad.json()).error.code, "INVALID_JSON");
  const large = await server.request("/api/orchestrator/tools/time", { query: "x".repeat(17000) }, auth);
  assert.equal(large.status, 413);
  assert.equal(large.body.error.code, "INPUT_TOO_LARGE");
  fs.writeFileSync(path.join(server.data, "orchestrator-config.json"), "{broken");
  const corrupt = await server.request("/api/orchestrator/tools/time", {}, auth);
  assert.equal(corrupt.status, 503);
  assert.equal(corrupt.body.error.code, "CONFIG_UNAVAILABLE");
});

test("real route rejects every utility call when internal token is not configured", async (t) => {
  const server = await startServer(t, { token: "" });
  const result = await server.request("/api/orchestrator/tools/time", {}, { authorization: "Bearer guessed" });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "AUTH_NOT_CONFIGURED");
});

test("startup with corrupt stored config invalidates an obsolete published policy and exits closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "govchat-invalid-policy-"));
  try {
    const data = path.join(root, "data");
    const publish = path.join(root, "publish");
    fs.mkdirSync(data);
    fs.mkdirSync(publish);
    fs.writeFileSync(path.join(data, "orchestrator-config.json"), "{broken");
    fs.writeFileSync(path.join(publish, "orchestrator-config.json"), JSON.stringify({ tools: { calculator: true } }));
    const result = cp.spawnSync(process.execPath, [path.resolve(__dirname, "../../services/admin-overlay/admin/server.js")], { env: { ...process.env, DATA_DIR: data, PUBLISH_DIR: publish, PORT: "0" }, timeout: 5000, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(fs.existsSync(path.join(publish, "orchestrator-config.json")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
