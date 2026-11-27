"use strict";

// Shared by the agent binding overlay and the unmodified n8n calculator implementation.
// Never derive enabled-state from an LLM argument or request body.
const fs = require("node:fs");
const TOOL_KEYS = Object.freeze({
  govchat_calculator_tool: "calculator",
  govchat_nos_news_tool: "nos_news",
  govchat_l1_news_tool: "l1_news",
  govchat_holidays_tool: "holidays",
  govchat_time_tool: "time",
});

function readManualPolicy(filename = process.env.N8N_MANUAL_POLICY_FILE || "/govchat-config/manual-config.json") {
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 1024) return false;
    const policy = JSON.parse(fs.readFileSync(filename, "utf8"));
    return policy.schemaVersion === 1 && policy.enabled === true && policy.agentEnabled === true && typeof policy.revision === "string" && /^[a-f0-9-]{36}$/.test(policy.revision);
  } catch { return false; }
}

function readPolicy(filename = process.env.N8N_ORCHESTRATOR_POLICY_FILE || "/govchat-config/orchestrator-config.json") {
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 16384) return null;
    const config = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!config || !config.tools || Array.isArray(config.tools) ||
        Object.values(TOOL_KEYS).some((key) => typeof config.tools[key] !== "boolean") ||
        typeof config.default_timezone !== "string") return null;
    return config;
  } catch {
    return null;
  }
}

function selectTools(tools, policy = readPolicy()) {
  return tools.filter((tool) => {
    if (tool.name === "govchat_manual_tool") return readManualPolicy();
    if (tool.name === "topdesk_knowledge_search_tool") {
      return typeof tool.description === "string" && tool.description.startsWith("[GOVCHAT_TOPDESK_AVAILABLE] ");
    }
    return !Object.hasOwn(TOOL_KEYS, tool.name) || policy?.tools?.[TOOL_KEYS[tool.name]] === true;
  });
}

function guardTool(tool) {
  if (tool.name === "govchat_manual_tool") {
    const original = tool._call;
    tool._call = async function (...args) {
      if (!readManualPolicy()) {
        const error = new Error("GovChat manual is disabled or unavailable"); error.code = "MANUAL_UNAVAILABLE"; throw error;
      }
      return original.apply(this, args);
    };
    return tool;
  }
  if (!Object.hasOwn(TOOL_KEYS, tool.name)) return tool;
  const original = tool._call;
  // Patch before n8n's logWrapper builds its proxy. Covers invoke(), call() and
  // the engine's separately supplied calculator, not just model-visible tools.
  tool._call = async function (...args) {
    const policy = readPolicy();
    if (!policy || policy.tools[TOOL_KEYS[tool.name]] !== true) {
      const error = new Error(policy ? "GovChat utility tool is disabled" : "GovChat utility tool policy is unavailable");
      error.code = policy ? "TOOL_DISABLED" : "CONFIG_UNAVAILABLE";
      throw error;
    }
    return original.apply(this, args);
  };
  return tool;
}

module.exports = { TOOL_KEYS, readPolicy, readManualPolicy, selectTools, guardTool };
