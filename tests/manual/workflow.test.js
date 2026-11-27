"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const builder = require("../../scripts/orchestrator-manual-workflow"), policy = require("../../scripts/n8n-orchestrator-tool-policy");
test("both orchestrator routes preserve prompt/name expression and final stream correlation", () => {
  const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, "../../agents/n8n/workflows/algemeen/orchestrator-litellm.json"), "utf8"))[0];
  const before = JSON.stringify(workflow); builder.applyManualTool(workflow); assert.equal(JSON.stringify(workflow), before);
  const names = workflow.nodes.filter(n => ["AIAgentOrchestrator", "AIAgentAuthorizedMcp"].includes(n.id)).map(n => n.name);
  assert.deepEqual(workflow.connections.govchat_manual_tool.ai_tool[0].map(c => c.node), names);
  const original = '={{ $json.customPrompt + "\\nNaam: " + $json.name + "\\n[govchat-stream-id:abc]" }}';
  const expression = builder.appendRule(original), fn = new Function("$json", "return " + expression.slice(3, -2));
  const output = fn({ customPrompt: "Mijn specifieke beleid", name: "LAICA" }); assert.ok(output.startsWith("Mijn specifieke beleid\nNaam: LAICA")); assert.ok(output.endsWith("\n[govchat-stream-id:abc]")); assert.ok(output.includes(builder.RULE));
  for (const n of builder.manualWorkflow().nodes) if (n.parameters.jsCode) new Function(n.parameters.jsCode);
  for (const n of workflow.nodes.filter(n => names.includes(n.name))) { new Function("return " + n.parameters.options.systemMessage.slice(3, -2)); assert.ok(n.parameters.options.systemMessage.includes(builder.RULE)); }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, "../../agents/n8n/workflows/govchat-manual-read.json"), "utf8")), [builder.manualWorkflow()]);
});
test("tool policy fail closed before selection and at invocation, including disable between calls", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-tool-")); const file = path.join(root, "manual-config.json"), old = process.env.N8N_MANUAL_POLICY_FILE;
  process.env.N8N_MANUAL_POLICY_FILE = file;
  t.after(() => { if (old === undefined) delete process.env.N8N_MANUAL_POLICY_FILE; else process.env.N8N_MANUAL_POLICY_FILE = old; fs.rmSync(root, { recursive: true, force: true }); });
  const tool = { name: "govchat_manual_tool", _call: async () => "actual source" };
  assert.deepEqual(policy.selectTools([tool]), []); policy.guardTool(tool); await assert.rejects(tool._call(), e => e.code === "MANUAL_UNAVAILABLE");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, agentEnabled: true, revision: "12345678-1234-1234-1234-123456789abc" })); assert.equal(policy.selectTools([tool]).length, 1); assert.equal(await tool._call(), "actual source");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: false, agentEnabled: true })); await assert.rejects(tool._call()); assert.deepEqual(policy.selectTools([tool]), []);
  fs.writeFileSync(file, "corrupt"); await assert.rejects(tool._call());
});
