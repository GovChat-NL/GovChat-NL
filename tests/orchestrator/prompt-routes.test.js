"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { createPromptStore } = require("../../services/admin-overlay/admin/lib/orchestrator-prompt");
const { registerPromptRoutes } = require("../../services/admin-overlay/admin/lib/orchestrator-prompt-routes");

test("real HTTP routes enforce distinct auth, no-store, validation, reset and no public leakage", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-route-test-"));
  const store = createPromptStore({ dataDir: root, publishDir: path.join(root, "publish"), env: {} });
  const app = express();
  app.use(express.json());
  registerPromptRoutes(app, { store, isAuthenticated: req => req.headers.cookie === "session=test", token: "internal-test", extractToken: req => req.headers.authorization?.replace(/^Bearer /, "") });
  app.get("/api/config/orchestrator", (req, res) => res.json({ tools: {} }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = "/api/orchestrator/prompt";
  const runtime = "/api/internal/orchestrator/prompt";
  async function request(url, options = {}, status = 200) {
    const response = await fetch(base + url, options);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.json();
  }
  const headers = { cookie: "session=test", "content-type": "application/json" };
  await request(admin, {}, 401);
  await request(runtime, {}, 401);
  await request(runtime, { headers }, 401);
  await request(admin, { headers: { authorization: "Bearer internal-test" } }, 401);
  assert.equal((await request(runtime, { headers: { authorization: "Bearer internal-test" } })).source, "default");
  const prompt = "  Organisatie\n</script><img onerror=alert(1)>\n${literal}  ";
  assert.equal((await request(admin, { method: "POST", headers, body: JSON.stringify({ prompt }) })).prompt, prompt);
  assert.equal((await request(runtime, { headers: { authorization: "Bearer internal-test" } })).prompt, prompt);
  for (const body of [{ prompt: "" }, { prompt: 1 }, { prompt: "x".repeat(32001) }, { prompt: "ok", unknown: 1 }, []]) {
    await request(admin, { method: "POST", headers, body: JSON.stringify(body) }, 400);
  }
  await request(admin, { method: "POST", headers: { ...headers, origin: "https://attacker.invalid" }, body: JSON.stringify({ prompt: "attack" }) }, 403);
  await request(admin, { method: "DELETE", headers: { ...headers, "sec-fetch-site": "cross-site" } }, 403);
  assert.equal((await (await fetch(base + "/api/config/orchestrator")).json()).prompt, undefined);
  fs.writeFileSync(store.filename, "corrupt");
  await request(runtime, { headers: { authorization: "Bearer internal-test" } }, 503);
  await request(admin, { headers }, 503);
  assert.equal((await request(admin, { method: "DELETE", headers })).source, "default");
  assert.equal(fs.existsSync(store.filename), false);
});
