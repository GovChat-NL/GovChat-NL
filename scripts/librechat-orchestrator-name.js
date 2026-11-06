"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const { validateMetadata, validateName, DEFAULT_DISPLAY_NAME } = require("./orchestrator-name");
const ENDPOINT = "govchat-orchestrator";

function readName({ filename = process.env.GOVCHAT_ORCHESTRATOR_NAME_FILE || "/app/govchat-public/orchestrator-name.json", env = process.env } = {}) {
  try {
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error("Symlink geweigerd");
    return validateMetadata(JSON.parse(fs.readFileSync(filename, "utf8"))).display_name;
  } catch (error) {
    // Optional admin-overlay profile absent: use env/default. Corrupt metadata fails closed.
    if (error.code !== "ENOENT") throw new Error("Publieke orkestratornaammetadata ongeldig of onleesbaar");
    return env.N8N_ORCHESTRATOR_DISPLAY_NAME ? validateName(env.N8N_ORCHESTRATOR_DISPLAY_NAME) : DEFAULT_DISPLAY_NAME;
  }
}

function overlayAppConfig(config, name) {
  if (!config || typeof config !== "object") return config;
  const result = { ...config };
  if (Array.isArray(config.endpoints?.custom)) {
    result.endpoints = { ...config.endpoints, custom: config.endpoints.custom.map(endpoint =>
      endpoint.name === ENDPOINT ? { ...endpoint, modelDisplayLabel: name } : endpoint) };
  }
  if (config.modelSpecs?.list) {
    result.modelSpecs = { ...config.modelSpecs, list: config.modelSpecs.list.map(spec =>
      spec.preset?.endpoint === ENDPOINT ? { ...spec, label: name } : spec) };
  }
  return result;
}

function overlayEndpoints(config, name) {
  if (!config?.[ENDPOINT]) return config;
  return { ...config, [ENDPOINT]: { ...config[ENDPOINT], modelDisplayLabel: name } };
}

function installNameOverlay() {
  const original = Module._load;
  const wrapped = new WeakSet();
  const targets = new Map([
    ["/app/api/server/services/Config/app.js", ["getAppConfig", overlayAppConfig]],
    ["/app/api/server/services/Config/getEndpointsConfig.js", ["getEndpointsConfig", overlayEndpoints]],
  ]);
  Module._load = function loadWithName(request, parent, isMain) {
    const exports = original.apply(this, arguments);
    const target = targets.get(Module._resolveFilename(request, parent, isMain));
    if (target && exports && !wrapped.has(exports)) {
      const [key, overlay] = target;
      if (typeof exports[key] !== "function") throw new Error("LibreChat-naamoverlay niet compatibel met configuratie-API");
      const fn = exports[key];
      exports[key] = async function () { return overlay(await fn.apply(this, arguments), readName()); };
      wrapped.add(exports);
    }
    return exports;
  };
}

module.exports = { readName, overlayAppConfig, overlayEndpoints, installNameOverlay };
