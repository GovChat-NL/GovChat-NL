"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const net = require("node:net");
const cp = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const root = path.resolve(__dirname, "..");
const loader = fs.readFileSync(path.join(root, "overlay/defaults/chat-disclaimer.js"), "utf8");

function overlay({ appName = "LAICA", pathname = "/c/new", legacy = false } = {}) {
  const attributes = new Map();
  let writes = 0;
  let text = legacy ? "GovChat-NL v0.0.1" : "LibreChat v0.8.7 - Elke AI voor iedereen.";
  const span = {
    hidden: false,
    hasAttribute: (key) => attributes.has(key),
    setAttribute: (key, value) => { attributes.set(key, value); writes++; },
    get textContent() { return text; },
    set textContent(value) { text = value; writes++; },
  };
  let current = span;
  let response = { ok: true, json: async () => ({ showChatDisclaimer: true }) };
  const requests = [];
  const context = {
    window: { GOVCHAT_BRANDING: appName ? { appName } : undefined, location: { pathname } },
    document: {
      title: "GovChat-NL", readyState: "loading", addEventListener() {},
      querySelector(selector) {
        if (!current) return null;
        if (selector.includes("span[data-govchat-disclaimer]")) {
          return attributes.has("data-govchat-disclaimer") ? current : null;
        }
        if (selector.includes(legacy ? 'a[data-govchat-brand="1"]' : 'a[href*="librechat.ai"]')) {
          return { closest: () => current };
        }
        return null;
      },
    },
    fetch: async (...args) => { requests.push(args); if (response instanceof Error) throw response; return response; },
  };
  // Expose the actual production functions without booting unrelated app tools.
  vm.runInNewContext(loader.replace('  if (document.readyState === "loading") {',
    '  window.testAPI = { applyFooterBranding, loadUIConfig };\n  if (document.readyState === "loading") {'), context);
  return {
    ...context.window.testAPI, context, span, requests, writes: () => writes,
    response: (value) => { response = value; },
    remount: () => { attributes.clear(); text = "LibreChat v0.8.7"; span.hidden = false; },
    remove: () => { current = null; },
  };
}

test("footer: default enabled, configured title, safe plain text and idempotent updates", () => {
  for (const appName of ["LAICA", "A<script>&\"", null]) {
    const ui = overlay({ appName });
    ui.applyFooterBranding();
    assert.equal(ui.span.textContent, `${appName || "GovChat-NL"} kan fouten maken. Controleer belangrijke informatie.`);
    assert.equal(ui.span.hidden, false);
    const writes = ui.writes();
    ui.applyFooterBranding();
    assert.equal(ui.writes(), writes);
  }
});

test("footer: disable, re-enable, React remount, late branding and legacy overlay upgrade", async () => {
  for (const legacy of [false, true]) {
    const ui = overlay({ legacy });
    ui.response({ ok: true, json: async () => ({ showChatDisclaimer: false }) });
    await ui.loadUIConfig();
    assert.equal(ui.span.hidden, true);
    assert.equal(ui.requests[0][0], "/govchat-overlay/ui-config.json");
    assert.equal(ui.requests[0][1].cache, "no-store");
    ui.remount();
    ui.applyFooterBranding();
    assert.equal(ui.span.hidden, true);
    ui.context.window.GOVCHAT_BRANDING.appName = "Nieuwe app";
    ui.response({ ok: true, json: async () => ({ showChatDisclaimer: true }) });
    await ui.loadUIConfig();
    assert.equal(ui.span.hidden, false);
    assert.match(ui.span.textContent, /^Nieuwe app kan fouten maken\./);
  }
});

test("footer: missing configuration defaults on; transient errors preserve the last setting", async () => {
  const ui = overlay();
  for (const response of [{ ok: false }, new Error("Offline"), { ok: true, json: async () => ({}) }]) {
    ui.response(response);
    await ui.loadUIConfig();
    ui.applyFooterBranding();
    assert.equal(ui.span.hidden, false);
  }
  ui.response({ ok: true, json: async () => ({ showChatDisclaimer: false }) });
  await ui.loadUIConfig();
  ui.response(new Error("Offline"));
  await ui.loadUIConfig();
  assert.equal(ui.span.hidden, true);
});

test("footer: authentication/non-chat routes and absent footer are untouched", () => {
  for (const pathname of ["/login", "/register", "/", "/share/test"]) {
    const ui = overlay({ pathname });
    ui.applyFooterBranding();
    assert.equal(ui.writes(), 0);
  }
  const ui = overlay();
  ui.remove();
  assert.doesNotThrow(ui.applyFooterBranding);
});

test("real admin server: defaults, authenticated saves, validation, publication and restart persistence", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "govchat-disclaimer-"));
  const data = path.join(directory, "data");
  const publish = path.join(directory, "publish");
  let child;
  let logs = "";
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exit = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exit;
    }
  };
  t.after(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const start = async () => {
    child = cp.spawn(process.execPath, ["-e", `globalThis.fetch=async()=>{throw new Error('Unexpected outbound request')};require(${JSON.stringify(path.join(root, "services/admin-overlay/admin/server.js"))});`], {
      env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: "test-password", DATA_DIR: data, PUBLISH_DIR: publish, IMAGE_JOBS_ENABLED: "false", N8N_WEBHOOK_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) assert.fail(logs);
      try { await fetch(base + "/login"); return; } catch { await delay(30); }
    }
    assert.fail(`Server not ready: ${logs}`);
  };
  const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "ui-config.json"), "utf8"));
  await start();
  assert.deepEqual(await (await fetch(base + "/api/config/ui")).json(), { showChatDisclaimer: true });
  assert.deepEqual(read(publish), { showChatDisclaimer: true });
  const post = (body, cookie) => fetch(base + "/api/config/ui", {
    method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await post({ showChatDisclaimer: false })).status, 302);
  assert.deepEqual(read(publish), { showChatDisclaimer: true });
  const login = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const dashboard = await (await fetch(base + "/dashboard", { headers: { cookie } })).text();
  assert.match(dashboard, /id="show-chat-disclaimer" checked/);
  for (const body of [{}, { showChatDisclaimer: "false" }, { showChatDisclaimer: 0 }, { showChatDisclaimer: null }]) {
    assert.equal((await post(body, cookie)).status, 400);
    assert.deepEqual(read(publish), { showChatDisclaimer: true });
  }
  assert.equal((await post({ showChatDisclaimer: false, ignored: "value" }, cookie)).status, 200);
  assert.deepEqual(read(data), { showChatDisclaimer: false });
  assert.deepEqual(read(publish), read(data));
  await stop();
  await start();
  assert.deepEqual(read(publish), { showChatDisclaimer: false });
  assert.deepEqual(await (await fetch(base + "/api/config/ui")).json(), { showChatDisclaimer: false });
  // Check that the delayed publishAll does not overwrite a saved preference.
  await delay(15100);
  assert.deepEqual(read(publish), { showChatDisclaimer: false });
  const newLogin = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
  const newCookie = newLogin.headers.get("set-cookie").split(";")[0];
  const disabledDashboard = await (await fetch(base + "/dashboard", { headers: { cookie: newCookie } })).text();
  assert.doesNotMatch(disabledDashboard, /id="show-chat-disclaimer" checked/);
  assert.equal((await post({ showChatDisclaimer: true }, newCookie)).status, 200);
  assert.deepEqual(read(publish), { showChatDisclaimer: true });
});
