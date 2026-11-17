"use strict";

const crypto = require("node:crypto");
const { ToolError, bodyObject, createSourceClient } = require("./utility-common");
const { newsTool } = require("./utility-news");
const { holidaysTool } = require("./utility-holidays");
const { timeTool } = require("./utility-time");
const TOOLS = ["nos_news", "l1_news", "holidays", "time"];

function errorBody(error) {
  return { ok: false, error: { code: error.code || "INTERNAL_ERROR", message: error instanceof ToolError ? error.message : "Utility tool failed" } };
}
function safeTokenEqual(supplied, expected) {
  if (typeof supplied !== "string" || !supplied || !expected) return false;
  // Fixed-length digests avoid token-length-dependent comparison and timingSafeEqual exceptions.
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(supplied).digest(), crypto.createHash("sha256").update(expected).digest());
}
function createUtilityHandler({ readConfig, token, extractToken = (req) => req.get("authorization")?.replace(/^Bearer /i, ""), client = createSourceClient(), now = () => Date.now() }) {
  return async function utilityHandler(req, res) {
    try {
      if (!token) throw new ToolError("AUTH_NOT_CONFIGURED", "Internal authentication token is not configured", 503);
      if (!safeTokenEqual(extractToken(req), token)) throw new ToolError("UNAUTHORIZED", "Unauthorized", 401);
      const tool = req.params.tool;
      if (!TOOLS.includes(tool)) throw new ToolError("UNKNOWN_TOOL", "Unknown utility tool", 404);
      let config;
      try { config = readConfig(); } catch { throw new ToolError("CONFIG_UNAVAILABLE", "Tool policy is unavailable or invalid", 503); }
      if (config?.tools?.[tool] !== true) throw new ToolError("TOOL_DISABLED", "Utility tool is disabled", 403);
      bodyObject(req.body);
      const result = tool === "time" ? timeTool(req.body, config, { now }) : tool === "holidays" ? await holidaysTool(req.body, config, client, { now }) : await newsTool(tool, req.body, client);
      return res.json(result);
    } catch (error) { return res.status(error.status || 500).json(errorBody(error)); }
  };
}

module.exports = { TOOLS, createUtilityHandler, safeTokenEqual };
