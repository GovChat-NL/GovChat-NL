'use strict';
const fs = require('node:fs');
const Module = require('node:module');

// GovChat's n8n overlay emits authoritative tool_call/result IDs. Node metadata
// and model-generated text are not additional invocations. Keep the bridge
// checkout unmodified and apply this compatibility overlay at startup.
function patchSource(source) {
  if (source.includes('govchat-authoritative-tool-events')) return source;
  const replacements = [
    ["const activeToolSteps = new Map();", "const activeToolSteps = new Map();\n    const seenToolCallIds = new Set(); // govchat-authoritative-tool-events"],
    ['const runtimeToolCallStart = this.extractRuntimeToolCallStart(response, runId);', 'const runtimeToolCallStart = null;'],
    ["if (!content || content[0] !== '{') {", "if (!['tool_call','tool_start','tool_result','tool_end','tool_error'].includes(data.type) || !content || content[0] !== '{') {"],
    ['const existingToolStep = activeToolSteps.get(toolCallStart.id);', 'const existingToolStep = seenToolCallIds.has(toolCallStart.id);'],
    ['activeToolSteps.set(toolCallStart.id, toolStep);', 'seenToolCallIds.add(toolCallStart.id);\n      activeToolSteps.set(toolCallStart.id, toolStep);'],
    ['const syntheticToolCallStart = maybeCreateSyntheticToolCallStart(parsed.raw);', 'const syntheticToolCallStart = null;', 2],
    ['const metadataToolCallStart = maybeCreateMetadataToolCallStart(parsed.raw);', 'const metadataToolCallStart = null;', 2],
    ['for (const candidate of filteredText.toolCalls) {', 'for (const candidate of []) { // Model text is not an executed tool call.', 2],
    ['for (const candidate of remainingText.toolCalls) {', 'for (const candidate of []) { // Model text is not an executed tool call.'],
  ];
  for (const [old, next, count = 1] of replacements) {
    if (source.split(old).length !== count + 1) throw new Error('Bridge tool-eventoverlay: onbekende bronstructuur');
    source = source.split(old).join(next);
  }
  return source;
}

function install() {
  const loader = Module._extensions['.js'];
  Module._extensions['.js'] = function(mod, filename) {
    if (filename === '/app/src/n8nClient.js') return mod._compile(patchSource(fs.readFileSync(filename, 'utf8')), filename);
    return loader(mod, filename);
  };
}

if (process.env.GOVCHAT_AUTHORITATIVE_TOOL_EVENTS === 'true') install();
module.exports = { patchSource };
