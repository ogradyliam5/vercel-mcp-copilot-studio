"use strict";

const { validate } = require("./validation");
const { redact } = require("./vercel-api");
const enabled = (name) => process.env[name] === "true";

function allowed(tool) {
  const selected = process.env.VERCEL_MCP_TOOLS;
  if (selected !== undefined && !selected.split(",").map((s) => s.trim()).includes(tool.name)) return false;
  if (!tool.annotations.readOnlyHint && !enabled("VERCEL_MCP_ALLOW_WRITES")) return false;
  if (tool.cliBacked && !enabled("VERCEL_MCP_ENABLE_CLI_APIS")) return false;
  if (tool.externalFetch && !enabled("VERCEL_MCP_ALLOW_EXTERNAL_FETCH")) return false;
  return true;
}
function authorize(tool, args) {
  if (!allowed(tool)) throw new Error("Tool disabled by server policy; ask the operator to review its configuration");
  validate(tool.inputSchema, args);
  if (["promote_deployment", "create_env_var", "delete_env_var"].includes(tool.name) || (!tool.annotations.readOnlyHint && args.target === "production")) {
    const previewEnv = tool.name === "create_env_var" && args.target?.length && !args.target.includes("production");
    if (!previewEnv && !enabled("VERCEL_MCP_ALLOW_PRODUCTION")) throw new Error("Production-affecting changes require VERCEL_MCP_ALLOW_PRODUCTION=true");
  }
}
function sanitize(value, token, depth = 0) {
  if (depth > 35) return "[nested content omitted]";
  if (typeof value === "string") return redact(value, token);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, token, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
    /^(accessToken|refreshToken|authorization|password|secret|privateKey|token|protectionBypass)$/i.test(k) || (k === "value" && ["encrypted", "sensitive"].includes(value.type))
      ? "[hidden]" : sanitize(v, token, depth + 1)]));
  return value;
}
module.exports = { allowed, authorize, sanitize };
