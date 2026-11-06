"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const policy = require("../../scripts/n8n-orchestrator-tool-policy");
const builder = require("../../scripts/orchestrator-utility-workflow");
const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, "../../agents/n8n/workflows/algemeen/orchestrator-litellm.json")))[0];

function writePolicy(directory, enabled = true) {
  const data = { default_timezone: "Europe/Amsterdam", tools: Object.fromEntries(Object.values(policy.TOOL_KEYS).map((key) => [key, enabled])) };
  fs.writeFileSync(path.join(directory, "policy.json"), JSON.stringify(data));
  return data;
}
function evaluate(expression, context = {}) {
  return vm.runInNewContext(expression.slice(3, -2), context);
}

test("workflow has five tools, explicit schemas and preserves original agent features", () => {
  for (const name of Object.keys(policy.TOOL_KEYS)) {
    const node = workflow.nodes.find((node) => node.name === name);
    assert.ok(node, name);
    assert.equal(node.disabled, undefined);
    assert.equal(workflow.connections[name].ai_tool[0][0].node, "AI Agent Orchestrator");
    if (name === "govchat_calculator_tool") {
      assert.equal(node.type, "@n8n/n8n-nodes-langchain.toolCalculator");
      assert.equal(node.typeVersion, 1);
    } else {
      assert.equal(node.parameters.workflowInputs.schema[0].id, "request");
      assert.equal(node.parameters.source, "database");
      const inline = JSON.parse(fs.readFileSync(path.join(__dirname, "../../agents/n8n/workflows", node.parameters.workflowId.value + ".json")))[0];
      assert.deepEqual(inline, builder.utilityWorkflow(builder.definitions.find((definition) => definition.name === name)));
      assert.equal(inline.nodes[0].parameters.workflowInputs.values[0].name, "request");
      for (const item of inline.nodes) if (item.parameters.jsCode) new vm.Script(`(async()=>{${item.parameters.jsCode}})()`);
    }
  }
  const agent = workflow.nodes.find((node) => node.id === "AIAgentOrchestrator");
  const system = evaluate(agent.parameters.options.systemMessage, { $json: { body: {} } });
  assert.match(system, /chronologische volgorde/);
  assert.match(system, /OpenHolidays/);
  assert.match(system, /FINAL_ANSWER/);
  assert.equal(agent.parameters.options.enableStreaming, true);
  assert.ok(workflow.nodes.find((node) => node.id === "DetectImageMessages"));
  assert.ok(workflow.nodes.find((node) => node.id === "ToolTopdeskKnowledgeSearch"));
  const copy = JSON.parse(JSON.stringify(workflow));
  builder.applyUtilityTools(copy);
  assert.deepEqual(copy, workflow, "generator must be idempotent");
});

test("inline workflow validates input, never includes token in response and calls a fixed tool endpoint", async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const definition of builder.definitions) {
    const inline = builder.utilityWorkflow(definition);
    const run = new AsyncFunction("$json", "$env", "Buffer", inline.nodes[1].parameters.jsCode);
    const items = await run({ request: '{"action":"categories"}' }, { CRAWLER_INTERNAL_TOKEN: "test-secret" }, Buffer);
    assert.equal(items[0].json.url, `http://govchat-overlay-admin:3002/api/orchestrator/tools/${definition.key}`);
    assert.equal(items[0].json.request.action, "categories");
    await assert.rejects(run({ request: "invalid" }, { CRAWLER_INTERNAL_TOKEN: "x" }, Buffer));
    await assert.rejects(run({ request: "[]" }, { CRAWLER_INTERNAL_TOKEN: "x" }, Buffer));
    await assert.rejects(run({ request: "{}" }, {}, Buffer));
    const response = new AsyncFunction("$json", inline.nodes[3].parameters.jsCode);
    const result = await response({ ok: false, error: { code: "TOOL_DISABLED", message: "disabled" } });
    assert.equal(JSON.parse(result[0].json.response).error.code, "TOOL_DISABLED");
    assert.doesNotMatch(result[0].json.response, /test-secret/);
  }
});

test("selection is fail-closed; unrelated existing tools are unaffected", () => {
  const tools = [...Object.keys(policy.TOOL_KEYS), "versimpelaar_b1_tool", "openbesluitvorming_search_tool"].map((name) => ({ name }));
  assert.equal(policy.selectTools(tools, null).length, 2);
  for (const key of Object.values(policy.TOOL_KEYS)) {
    const config = { tools: Object.fromEntries(Object.values(policy.TOOL_KEYS).map((item) => [item, item !== key])) };
    assert.equal(policy.selectTools(tools, config).length, 6);
    assert.ok(!policy.selectTools(tools, config).some((tool) => policy.TOOL_KEYS[tool.name] === key));
  }
});

test("published policy, invocation recheck and corrupt/missing policies", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "govchat-policy-"));
  const previous = process.env.N8N_ORCHESTRATOR_POLICY_FILE;
  process.env.N8N_ORCHESTRATOR_POLICY_FILE = path.join(directory, "policy.json");
  try {
    assert.equal(policy.readPolicy(), null);
    writePolicy(directory);
    let calls = 0;
    const tool = policy.guardTool({ name: "govchat_calculator_tool", _call: async () => { calls++; return "42"; } });
    assert.equal(await tool._call("6*7"), "42");
    writePolicy(directory, false);
    await assert.rejects(tool._call("6*7"), { code: "TOOL_DISABLED" });
    fs.writeFileSync(process.env.N8N_ORCHESTRATOR_POLICY_FILE, '{"tools":{"calculator":true}}');
    await assert.rejects(tool._call("6*7"), { code: "CONFIG_UNAVAILABLE" });
    fs.writeFileSync(process.env.N8N_ORCHESTRATOR_POLICY_FILE, "bad-json");
    assert.equal(policy.readPolicy(), null);
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.N8N_ORCHESTRATOR_POLICY_FILE; else process.env.N8N_ORCHESTRATOR_POLICY_FILE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("real n8n 2.25.7 calculator supply and engine execution enforce policy", async () => {
  // This integration runs in an isolated pinned n8n image with the overlay mounts.
  const base = "/usr/local/lib/node_modules/n8n/node_modules/.pnpm";
  const pkg = fs.readdirSync(base).find((name) => name.startsWith("@n8n+n8n-nodes-langchain@"));
  const calcPath = path.join(base, pkg, "node_modules/@n8n/n8n-nodes-langchain/dist/nodes/tools/ToolCalculator/ToolCalculator.node.js");
  const { ToolCalculator } = require(calcPath);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "govchat-calculator-"));
  const previous = process.env.N8N_ORCHESTRATOR_POLICY_FILE;
  process.env.N8N_ORCHESTRATOR_POLICY_FILE = path.join(directory, "policy.json");
  const ctx = {
    getNode: () => ({ name: "govchat_calculator_tool", id: "ToolCalculator", type: "@n8n/n8n-nodes-langchain.toolCalculator" }),
    getInputData: () => [{ json: { input: "6*7" } }],
    addInputData: () => ({}), addOutputData: () => {}, logNodeOutput: () => {},
    logAiEvent: () => {}, logger: { debug: () => {} },
  };
  try {
    writePolicy(directory);
    const calculator = new ToolCalculator();
    const supplied = await calculator.supplyData.call(ctx);
    assert.equal(await supplied.response.invoke("6*7"), "42");
    const results = await calculator.execute.call(ctx);
    assert.equal(results[0][0].json.response, "42");
    writePolicy(directory, false);
    await assert.rejects(supplied.response.invoke("6*7"), /disabled/);
    await assert.rejects(calculator.execute.call(ctx), /disabled/);
  } finally {
    if (previous === undefined) delete process.env.N8N_ORCHESTRATOR_POLICY_FILE; else process.env.N8N_ORCHESTRATOR_POLICY_FILE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
