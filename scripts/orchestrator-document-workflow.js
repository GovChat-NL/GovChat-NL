"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { normalizeDocumentContext } = require("./n8n-document-context");

function applyDocumentContext(workflow) {
  const detector = workflow.nodes.find((node) => node.id === "DetectImageMessages");
  if (!detector) throw new Error("DetectImageMessages node not found");
  const name = "Extract Document Context";
  const node = {
    id: "ExtractDocumentContext", name, type: "n8n-nodes-base.code", typeVersion: 2,
    position: [detector.position[0] - 220, detector.position[1]],
    parameters: { jsCode: `return await (${normalizeDocumentContext.toString()})($json, $env);` },
  };
  const index = workflow.nodes.findIndex((item) => item.id === node.id);
  if (index < 0) workflow.nodes.push(node); else workflow.nodes[index] = node;
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    if (source === name) continue;
    for (const branch of outputs.main || []) {
      for (const edge of branch) {
        if (edge.node === detector.name) edge.node = name;
      }
    }
  }
  workflow.connections[name] = { main: [[{ node: detector.name, type: "main", index: 0 }]] };
  // Preserve document failures; successful mixed document/image turns still use vision.
  detector.parameters.jsCode = detector.parameters.jsCode
    .replace("let precomputedResponse = '';", "let precomputedResponse = String(raw.precomputed_response || '');")
    .replace("if (imageParts > 0) {", "if (imageParts > 0 && !precomputedResponse) {");
  return workflow;
}

if (require.main === module) {
  const filename = path.resolve(__dirname, "../agents/n8n/workflows/algemeen/orchestrator-litellm.json");
  const data = JSON.parse(fs.readFileSync(filename, "utf8"));
  applyDocumentContext(Array.isArray(data) ? data[0] : data);
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
}
module.exports = { applyDocumentContext };
