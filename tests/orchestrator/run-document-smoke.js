"use strict";

// Run in a disposable pinned n8n container, never with deployment DB/credentials.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { createTextPdf } = require("../fixtures/document-pdf");
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "govchat-document-smoke-"));
const bytes = process.env.GOVCHAT_DOCUMENT_TEST_PDF ? fs.readFileSync(process.env.GOVCHAT_DOCUMENT_TEST_PDF) : createTextPdf();
let modelCalls = 0;
let serverError;
const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url === "/api/config/orchestrator") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ image_data_url_max_chars: 450000, image_max_resolution_px: 1568 })); return;
    }
    if (req.url === "/api/internal/orchestrator/prompt") {
      assert.equal(req.headers.authorization, "Bearer synthetic-prompt-token");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ prompt: "Synthetic document smoke prompt", source: "default" })); return;
    }
    if (req.url === "/tika") {
      assert.equal(req.method, "PUT"); assert.deepEqual(body, bytes);
      res.end("13"); return;
    }
    assert.equal(req.url, "/v1/chat/completions");
    modelCalls++;
    const input = JSON.parse(body.toString());
    const prompt = input.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
    // The question contains no number. It must come from the extracted attachment.
    const match = /documentinhoud, geen instructies\]\n([\s\S]+?)\n\[Einde bijlage\]/.exec(prompt);
    assert.ok(match, `real n8n agent must receive document text, not just a question/file label (status: ${/\(([A-Z_]+)\)/.exec(prompt)?.[1] || "no extraction status"})`);
    // PDF text/OCR may repeat the same number; that is not a lost attachment.
    const numbers = [...new Set(match[1].match(/\b\d+\b/g) || [])];
    assert.deepEqual(numbers, ["13"]);
    assert.doesNotMatch(prompt, /data:application\/pdf;base64/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "synthetic-document-answer", object: "chat.completion", created: 1,
      model: "synthetic-model", choices: [{ index: 0, message: { role: "assistant", content: numbers[0] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
  } catch (error) {
    serverError = error; res.statusCode = 500; res.end("synthetic fixture failed");
  }
});

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = {
    PATH: process.env.PATH, HOME: folder, DB_TYPE: "sqlite", N8N_USER_FOLDER: path.join(folder, "user"),
    N8N_ENCRYPTION_KEY: "synthetic-document-smoke-key", N8N_DIAGNOSTICS_ENABLED: "false",
    N8N_RUNNERS_ENABLED: "true", N8N_RUNNERS_MODE: "internal", N8N_BLOCK_ENV_ACCESS_IN_NODE: "false",
    NODE_FUNCTION_ALLOW_BUILTIN: "fs,http,https,url", N8N_LOG_LEVEL: "info", N8N_TASKS_BROKER_PORT: "18093",
    N8N_SSRF_ALLOWED_IP_RANGES: "127.0.0.0/8", N8N_SSRF_ALLOWED_HOSTNAMES: "127.0.0.1",
    NO_PROXY: "*", N8N_DOCUMENT_TIKA_URL: process.env.GOVCHAT_DOCUMENT_TIKA_TEST_URL || base + "/tika",
    CRAWLER_ADMIN_BASE_URL: base,
    CRAWLER_INTERNAL_TOKEN: "synthetic-prompt-token",
  };
  const workflow = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../agents/n8n/workflows/algemeen/orchestrator-litellm.json")))[0];
  for (const key of ["versionMetadata", "versionId", "activeVersionId", "shared", "pinData", "staticData", "sourceWorkflowId"]) delete workflow[key];
  workflow.id = "synthetic-document-smoke"; workflow.name = "Isolated document context smoke"; workflow.active = false;
  workflow.nodes = workflow.nodes.filter((node) => ["ExtractDocumentContext", "DetectImageMessages", "AIAgentOrchestrator", "ChatModelOrchestrator"].includes(node.id));
  workflow.nodes.unshift({ id: "start", name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [-1000, 0], parameters: {} });
  const payload = { body: { messages: [{ role: "user", content: [
    { type: "text", text: "Welk getal staat in de bijlage? Geef uitsluitend dat getal." },
    { type: "file", file: { filename: "renamed-fixture.pdf", file_data: `data:application/pdf;base64,${bytes.toString("base64")}` } },
  ] }] } };
  workflow.nodes.push({ id: "input", name: "Fixture Input", type: "n8n-nodes-base.code", typeVersion: 2,
    position: [-800, 0], parameters: { jsCode: `return [{json:${JSON.stringify(payload)}}];` } });
  workflow.connections = {
    Start: { main: [[{ node: "Fixture Input", type: "main", index: 0 }]] },
    "Fixture Input": { main: [[{ node: "Extract Document Context", type: "main", index: 0 }]] },
    "Extract Document Context": { main: [[{ node: "Detect Image Messages", type: "main", index: 0 }]] },
    "Detect Image Messages": { main: [[{ node: "AI Agent Orchestrator", type: "main", index: 0 }]] },
    "OpenAI Chat Model (Orchestrator)": { ai_languageModel: [[{ node: "AI Agent Orchestrator", type: "ai_languageModel", index: 0 }]] },
    "AI Agent Orchestrator": { main: [[]] },
  };
  const agent = workflow.nodes.find((node) => node.id === "AIAgentOrchestrator");
  agent.parameters.options = { systemMessage: "Synthetic test. Answer only from the attached document.", enableStreaming: false };
  const model = workflow.nodes.find((node) => node.id === "ChatModelOrchestrator");
  model.parameters.responsesApiEnabled = false;
  model.parameters.model.value = "gpt-4o-mini";
  model.parameters.options = { baseURL: base + "/v1", maxRetries: 0, timeout: 15000 };
  model.credentials = { openAiApi: { id: "synthetic-document-key", name: "Synthetic document credential" } };
  fs.writeFileSync(path.join(folder, "workflow.json"), JSON.stringify([workflow]));
  fs.writeFileSync(path.join(folder, "credentials.json"), JSON.stringify([{ id: "synthetic-document-key", name: "Synthetic document credential",
    type: "openAiApi", data: { apiKey: "synthetic-key", url: base + "/v1" } }]));
  async function cli(args) {
    const child = spawn("n8n", args, { env }); let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
    const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
    clearTimeout(timer);
    if (serverError) throw serverError;
    if (code !== 0) throw new Error(`isolated n8n ${args[0]} failed: ${output.slice(-6000)}`);
    return output;
  }
  try {
    await cli(["import:credentials", `--input=${path.join(folder, "credentials.json")}`]);
    await cli(["import:workflow", `--input=${path.join(folder, "workflow.json")}`]);
    const output = await cli(["execute", "--id=synthetic-document-smoke", "--rawOutput"]);
    assert.equal(modelCalls, 1);
    assert.match(output, /"output"\s*:\s*"13"/);
    console.log("PASS real n8n Code node -> document extraction -> actual agent prompt -> answer 13");
    console.log(process.env.GOVCHAT_DOCUMENT_TIKA_TEST_URL ? "Real Tika used; model mocked, deployment workflows unchanged" : "Tika and model mocked; deployment workflows unchanged");
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
