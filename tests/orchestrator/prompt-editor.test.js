"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("editor uses literal text, separate API, source display, preview and explicit reset", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../../services/admin-overlay/admin/views/orchestrator-editor.html"), "utf8");
  const elements = new Map();
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], { value: "", checked: false, disabled: false, hidden: false, textContent: "" });
  elements.get("orchestrator-seed").textContent = "{}";
  const text = "</script><img src=x onerror=alert(1)>\n${literal()}";
  const calls = [];
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id), createElement: () => ({ remove() {} }), body: { appendChild() {} } },
    confirm: () => true, setTimeout: () => {},
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url.endsWith('/name') ? { display_name: 'Testnaam', source: 'default' } : ({ prompt: text, source: options.method === "POST" ? "admin" : "default" }) };
    },
  });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join("\n");
  assert.ok(!scripts.includes("innerHTML"));
  vm.runInContext(scripts, context);
  await vm.runInContext("loadPrompt()", context);
  assert.equal(elements.get("masterPrompt").value, text);
  assert.match(elements.get("promptStatus").textContent, /GovChat-standaard/);
  vm.runInContext("previewPrompt()", context);
  assert.ok(elements.get("masterPromptPreview").textContent.endsWith(text));
  assert.equal(elements.get("masterPromptPreview").hidden, false);
  await vm.runInContext("changePrompt('POST')", context);
  assert.match(elements.get("promptStatus").textContent, /beheerdersoverride/);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { prompt: text });
  await vm.runInContext("changePrompt('DELETE')", context);
  assert.equal(calls.at(-1).options.method, "DELETE");
  assert.equal(calls.at(-1).options.body, undefined);
  for (const call of calls.filter(call => !call.url.endsWith('/name'))) { assert.equal(call.url, "/api/orchestrator/prompt"); assert.equal(call.options.cache, "no-store"); }
});
