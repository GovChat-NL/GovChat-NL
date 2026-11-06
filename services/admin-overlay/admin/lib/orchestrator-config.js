"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const TOOL_NAMES = Object.freeze(["calculator", "nos_news", "l1_news", "holidays", "time"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function validateTimezone(value) {
  if (typeof value !== "string" || !value || value.length > 100 || /^[+-]/.test(value)) {
    throw new Error("Invalid IANA timezone");
  }
  try { new Intl.DateTimeFormat("nl-NL", { timeZone: value }).format(); }
  catch { throw new Error("Invalid IANA timezone"); }
  return value;
}

function environmentDefaults(env = process.env) {
  const tools = {};
  for (const tool of TOOL_NAMES) {
    const raw = env[`N8N_ORCHESTRATOR_ENABLE_${tool.toUpperCase()}`];
    if (raw !== undefined && raw !== "true" && raw !== "false") throw new Error(`Invalid boolean default for ${tool}`);
    tools[tool] = raw === undefined || raw === "true";
  }
  return {
    image_data_url_max_chars: Math.max(50000, parseInt(env.N8N_ORCHESTRATOR_IMAGE_DATA_URL_MAX_CHARS, 10) || 450000),
    image_max_resolution_px: Math.max(512, parseInt(env.N8N_ORCHESTRATOR_IMAGE_MAX_RESOLUTION_PX, 10) || 1568),
    tools,
    default_timezone: validateTimezone(env.N8N_ORCHESTRATOR_DEFAULT_TIMEZONE ?? "Europe/Amsterdam"),
  };
}

// Missing legacy fields inherit environment defaults. Invalid stored policy does not enable tools.
function normalizeConfig(stored = {}, defaults = environmentDefaults()) {
  object(stored, "Config");
  const result = { ...defaults, tools: { ...defaults.tools } };
  for (const [key, minimum] of [["image_data_url_max_chars", 50000], ["image_max_resolution_px", 512]]) {
    if (stored[key] !== undefined) result[key] = Math.max(minimum, parseInt(String(stored[key]), 10) || defaults[key]);
  }
  if (stored.tools !== undefined) {
    object(stored.tools, "Tools");
    for (const [key, value] of Object.entries(stored.tools)) {
      if (!TOOL_NAMES.includes(key)) throw new Error(`Unknown tool: ${key}`);
      if (typeof value !== "boolean") throw new Error(`Tool ${key} must be boolean`);
      result.tools[key] = value;
    }
  }
  if (stored.default_timezone !== undefined) result.default_timezone = validateTimezone(stored.default_timezone);
  return result;
}

function mergeConfig(input, current, defaults = environmentDefaults()) {
  object(input, "Config");
  const allowed = ["tools", "default_timezone", "image_data_url_max_chars", "image_max_resolution_px"];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown config field: ${key}`);
  const base = normalizeConfig(current, defaults);
  if (input.tools !== undefined) object(input.tools, "Tools");
  return normalizeConfig({ ...base, ...input, tools: { ...base.tools, ...(input.tools || {}) } }, defaults);
}

function atomicWriteJSON(directory, filename, value) {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, filename);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

module.exports = { TOOL_NAMES, validateTimezone, environmentDefaults, normalizeConfig, mergeConfig, atomicWriteJSON };
