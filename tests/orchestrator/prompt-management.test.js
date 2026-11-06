"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createPromptStore, DEFAULT_PROMPT, MAX_PROMPT_LENGTH, validatePrompt } = require("../../services/admin-overlay/admin/lib/orchestrator-prompt");
const { configurePromptManagement } = require("../../scripts/orchestrator-prompt-workflow");
const { configureTopdeskIntegration } = require("../../n8n/bootstrap");
const template = JSON.parse(fs.readFileSync(path.join(__dirname, "../../agents/n8n/workflows/orchestrator-litellm.json")))[0];
function fixture(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publishDir = path.join(root, "publish");
  fs.mkdirSync(publishDir);
  return { root, publishDir, store: createPromptStore({ dataDir: root, publishDir, env }) };
}

test("precedence, multiline preservation, private permissions and actual deletion on reset", t => {
  const env = {};
  const { store, publishDir } = fixture(t, env);
  assert.equal(store.read().prompt, DEFAULT_PROMPT);
  assert.equal(store.read().source, "default");
  env.N8N_ORCHESTRATOR_MASTER_PROMPT = "  Omgeving\nregel 2\r\n  ";
  assert.equal(store.read().source, "environment");
  const override = "  Organisatie\n${doNotEvaluate()}\n</script><img src=x onerror=alert(1)>  ";
  assert.equal(store.save(override).prompt, override);
  assert.equal(store.read().source, "admin");
  assert.equal(fs.statSync(store.filename).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(store.filename)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(publishDir), []);
  assert.equal(store.reset().prompt, env.N8N_ORCHESTRATOR_MASTER_PROMPT);
  assert.equal(fs.existsSync(store.filename), false);
  delete env.N8N_ORCHESTRATOR_MASTER_PROMPT;
  assert.equal(store.reset().source, "default");
});

test("type, empty and length validation; corrupt override must never fall back", t => {
  for (const value of [undefined, null, 2, {}, [], "", " \r\n", "x".repeat(MAX_PROMPT_LENGTH + 1)]) {
    assert.throws(() => validatePrompt(value));
  }
  assert.equal(validatePrompt("x".repeat(MAX_PROMPT_LENGTH)).length, MAX_PROMPT_LENGTH);
  const env = { N8N_ORCHESTRATOR_MASTER_PROMPT: "Environment" };
  const { store } = fixture(t, env);
  store.save("Admin");
  for (const corrupt of ["not json", '{"version":1,"prompt":""}', '{"version":2,"prompt":"wrong"}', '{"version":1,"prompt":"ok","other":1}']) {
    fs.writeFileSync(store.filename, corrupt);
    assert.throws(() => store.read(), /ongeldig/);
  }
  assert.equal(store.reset().source, "environment");
  env.N8N_ORCHESTRATOR_MASTER_PROMPT = " ";
  assert.throws(() => store.read());
  store.save("Admin wins over invalid env");
  assert.equal(store.read().source, "admin");
  assert.throws(() => store.reset());
  assert.equal(store.read().source, "admin");
});

test("public storage locations and symlinks are refused", t => {
  const { root, publishDir, store } = fixture(t);
  assert.throws(() => createPromptStore({ dataDir: publishDir, publishDir, env: {} }), /publicatiemap/);
  fs.symlinkSync(publishDir, path.join(root, "private"));
  assert.throws(() => store.save("secret"), /symlink/);
  assert.throws(() => store.read(), /symlink/);
});

test("organization text remains data; independent technical instructions and integrations survive", () => {
  const [enabled] = configureTopdeskIntegration([template], { N8N_ENABLE_TOPDESK_SEARCH: "true" });
  const agent = enabled.nodes.find(n => n.id === "AIAgentOrchestrator");
  const evaluate = input => vm.runInNewContext(agent.parameters.options.systemMessage.slice(3, -2), { $json: input });
  assert.throws(() => evaluate({}), /Masterpromptconfiguratie/);
  const organization = "Alleen organisatiebeleid\n${process.exit()}\n</script>";
  const text = evaluate({ orchestratorPrompt: organization, body: { userName: " Test ", userEmail: " test@example.org ", streamId: "12345678-1234-4123-8123-123456789012" } });
  assert.ok(text.startsWith(organization));
  assert.ok(!text.includes("chronologische volgorde"));
  for (const value of ["FINAL_ANSWER", "alleen als dat functioneel nodig is", "OpenHolidays", "naam: Test", "[TOPDESK KNOWLEDGE SOURCE]"]) assert.ok(text.includes(value), value);
  assert.ok(text.includes("[govchat-stream-id:12345678-1234-4123-8123-123456789012]"));
  assert.deepEqual(configurePromptManagement(structuredClone(template)), template, "migration must be idempotent");
  for (const key of ["saveDataSuccessExecution", "saveDataErrorExecution"]) assert.equal(template.settings[key], "none");
  assert.equal(template.settings.saveManualExecutions, false);
});

test("runtime loader authenticates every request, overwrites spoofed input and fails closed", async () => {
  const code = template.nodes.find(n => n.id === "DetectImageMessages").parameters.jsCode;
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const run = new AsyncFunction("$json", "$env", "require", "fetch", "Buffer", "AbortSignal", code);
  let requests = 0;
  let mode = "good";
  const fakeFetch = async (url, options) => {
    if (url.endsWith("/api/internal/orchestrator/prompt")) {
      requests++;
      assert.equal(options.headers.authorization, "Bearer test-token");
      assert.equal(options.headers["cache-control"], "no-store");
      if (mode === "offline") throw new Error("sensitive body must never leak");
      if (mode === "unauthorized") return { ok: false, status: 401, text: async () => "sensitive body" };
      const data = mode === "bad" ? { prompt: 42, source: "admin" } : { prompt: "Fresh prompt " + requests, source: "admin" };
      return { ok: true, status: 200, text: async () => mode === "json" ? "invalid JSON" : JSON.stringify(data) };
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const env = { CRAWLER_INTERNAL_TOKEN: "test-token" };
  for (let i = 1; i <= 2; i++) {
    const output = await run({ body: { messages: [] }, orchestratorPrompt: "spoof" }, env, require, fakeFetch, Buffer, AbortSignal);
    assert.equal(output[0].json.orchestratorPrompt, "Fresh prompt " + i);
  }
  for (mode of ["offline", "unauthorized", "bad", "json"]) {
    await assert.rejects(run({}, env, require, fakeFetch, Buffer, AbortSignal), error => {
      assert.match(error.message, /verzoek afgebroken zonder vervangende prompt/);
      assert.ok(!error.message.includes("sensitive"));
      return true;
    });
  }
  await assert.rejects(run({}, {}, require, fakeFetch, Buffer, AbortSignal), /authenticatie ontbreekt/);
});
