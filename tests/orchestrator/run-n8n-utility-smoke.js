#!/usr/bin/env node
"use strict";

// Run only in a disposable n8n image. Uses its own DB, credentials and loopback
// HTTP fixtures; never connects to a deployment or a real language model.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "govchat-n8n-smoke-"));
const policy = require("../../scripts/n8n-orchestrator-tool-policy");
const source = JSON.parse(fs.readFileSync("agents/n8n/workflows/orchestrator-litellm.json"))[0];
const workflow = JSON.parse(JSON.stringify(source));
for (const key of ["versionMetadata", "versionId", "activeVersionId", "shared", "pinData", "staticData", "sourceWorkflowId"]) delete workflow[key];
workflow.id = "govchat-utility-smoke";
workflow.name = "GovChat isolated utility smoke";
workflow.active = false;
workflow.nodes = workflow.nodes.filter((node) => Object.hasOwn(policy.TOOL_KEYS, node.name) || ["AIAgentOrchestrator", "ChatModelOrchestrator"].includes(node.id));
workflow.nodes.unshift({ id: "manual", name: "Smoke Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [-800, 240], parameters: {} });
workflow.connections = Object.fromEntries(Object.entries(workflow.connections).filter(([name]) => workflow.nodes.some((node) => node.name === name)));
workflow.connections["Smoke Start"] = { main: [[{ node: "AI Agent Orchestrator", type: "main", index: 0 }]] };
const agent = workflow.nodes.find((node) => node.id === "AIAgentOrchestrator");
agent.parameters.text = "Run the requested smoke tool and return smoke-success.";
agent.parameters.options.systemMessage = "Isolated test, use available tools.";
agent.parameters.options.enableStreaming = false;
const model = workflow.nodes.find((node) => node.id === "ChatModelOrchestrator");
model.parameters.options.baseURL = "http://127.0.0.1:18081/v1";
model.parameters.model.value = "gpt-4o-mini";
model.parameters.responsesApiEnabled = false;
model.parameters.options.maxRetries = 0;
model.parameters.options.timeout = 15000;
model.credentials.openAiApi = { id: "govchat-smoke-credential", name: "GovChat isolated smoke credential" };
const utilityBuilder = require("../../scripts/orchestrator-utility-workflow");
fs.writeFileSync(path.join(directory, "workflow.json"), JSON.stringify([workflow, ...utilityBuilder.definitions.map(utilityBuilder.utilityWorkflow)]));
fs.writeFileSync(path.join(directory, "credentials.json"), JSON.stringify([{ id: "govchat-smoke-credential", name: "GovChat isolated smoke credential", type: "openAiApi", data: { apiKey: "synthetic-test-key", url: "http://127.0.0.1:18081/v1" } }]));
fs.writeFileSync(path.join(directory, "network-debug.js"), `const d = require('node:diagnostics_channel'); d.channel('undici:request:create').subscribe(({request}) => console.error('SMOKE HTTP',request.origin,request.path)); d.channel('undici:request:error').subscribe(({error}) => console.error('SMOKE NETWORK',error.message,error.cause?.message));`);
const env = {
  ...process.env, N8N_USER_FOLDER: path.join(directory, "user"), N8N_DIAGNOSTICS_ENABLED: "false",
  HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "*",
  N8N_SSRF_ALLOWED_IP_RANGES: "127.0.0.0/8", N8N_SSRF_ALLOWED_HOSTNAMES: "127.0.0.1",
  N8N_RUNNERS_MODE: "internal", N8N_RUNNERS_ENABLED: "true", N8N_BLOCK_ENV_ACCESS_IN_NODE: "false",
  N8N_ORCHESTRATOR_POLICY_FILE: path.join(directory, "policy.json"),
  CRAWLER_ADMIN_BASE_URL: "http://127.0.0.1:18081", CRAWLER_INTERNAL_TOKEN: "synthetic-internal-token",
  N8N_LOG_LEVEL: "info", N8N_TASKS_BROKER_PORT: "18082",
  NODE_OPTIONS: `--require ${path.join(directory, "network-debug.js")}`,
};
let requestedTool;
let enabled = true;
let backendCalls = 0;
let modelCalls = 0;
let serverError;
const server = http.createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/chat/completions") {
      modelCalls++;
      const names = (body.tools || []).map((tool) => tool.function.name);
      assert.deepEqual(names.sort(), enabled ? Object.keys(policy.TOOL_KEYS).sort() : []);
      const alreadyCalled = body.messages.some((message) => message.role === "tool");
      if (alreadyCalled) {
        const result = body.messages.find((message) => message.role === "tool").content;
        if (requestedTool === "govchat_calculator_tool") assert.equal(JSON.parse(result)[0].response, "42");
        else assert.match(result, /\\?"ok\\?"\s*:\s*true/, `Actual tool result: ${result}`);
      }
      const args = requestedTool === "govchat_calculator_tool" ? { input: "6*7" } : { request: JSON.stringify({ action: policy.TOOL_KEYS[requestedTool] === "time" ? "now" : policy.TOOL_KEYS[requestedTool] === "holidays" ? "countries" : "categories" }) };
      const message = enabled && !alreadyCalled
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_smoke", type: "function", function: { name: requestedTool, arguments: JSON.stringify(args) } }] }
        : { role: "assistant", content: "smoke-success" };
      res.end(JSON.stringify({ id: "chatcmpl-smoke", object: "chat.completion", created: 1, model: "gpt-5.4", choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    } else {
      assert.equal(req.url, `/api/orchestrator/tools/${policy.TOOL_KEYS[requestedTool]}`);
      assert.equal(req.headers.authorization, "Bearer synthetic-internal-token");
      assert.ok(body.action);
      backendCalls++;
      res.end(JSON.stringify({ ok: true, action: body.action, smoke: true }));
    }
  } catch (error) {
    serverError = error;
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error.message }));
  }
});
async function cli(args) {
  const child = spawn("n8n", args, { env });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(timeout);
  if (serverError) throw serverError;
  if (code !== 0) throw new Error(`n8n ${args[0]} failed (${code}, ${modelCalls} model requests): ${output.slice(-12000)}`);
  return output;
}
async function main() {
  await new Promise((resolve) => server.listen(18081, "127.0.0.1", resolve));
  try {
    await cli(["import:credentials", `--input=${path.join(directory, "credentials.json")}`]);
    await cli(["import:workflow", `--input=${path.join(directory, "workflow.json")}`]);
    for (const definition of utilityBuilder.definitions) {
      await cli(["publish:workflow", `--id=${utilityBuilder.utilityWorkflow(definition).id}`]);
    }
    const tools = Object.fromEntries(Object.values(policy.TOOL_KEYS).map((key) => [key, true]));
    fs.writeFileSync(env.N8N_ORCHESTRATOR_POLICY_FILE, JSON.stringify({ tools, default_timezone: "Europe/Amsterdam" }));
    for (requestedTool of Object.keys(policy.TOOL_KEYS)) {
      const output = await cli(["execute", "--id=govchat-utility-smoke", "--rawOutput"]);
      if (serverError) throw serverError;
      assert.match(output, /smoke-success/);
      assert.doesNotMatch(output, /executionError|errorMessage/);
      console.log(`PASS real n8n agent -> ${requestedTool} -> tool response -> final answer`);
    }
    assert.equal(backendCalls, 4);
    enabled = false;
    fs.writeFileSync(env.N8N_ORCHESTRATOR_POLICY_FILE, JSON.stringify({ tools: Object.fromEntries(Object.keys(tools).map((key) => [key, false])), default_timezone: "Europe/Amsterdam" }));
    const output = await cli(["execute", "--id=govchat-utility-smoke", "--rawOutput"]);
    if (serverError) throw serverError;
    assert.match(output, /smoke-success/);
    assert.equal(backendCalls, 4);
    console.log(`PASS all tools disabled: no model-visible tools and no backend call (${modelCalls} model requests total)`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
