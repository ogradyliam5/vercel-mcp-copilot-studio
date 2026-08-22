"use strict";

/**
 * Zero-dependency MCP (Model Context Protocol) server core.
 * Implements the Streamable HTTP transport (stateless mode) with JSON-RPC 2.0,
 * as required by Microsoft Copilot Studio.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http
 */

const { TOOLS, TOOL_MAP } = require("./tools");

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "vercel-mcp", version: "1.0.0" };

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: err };
}

/**
 * Extract the Vercel access token from request headers.
 * Copilot Studio sends the API key in a configurable header; we accept:
 *   - Authorization: Bearer <token>
 *   - x-api-key: <token>
 *   - x-vercel-token: <token>
 * Falls back to the VERCEL_TOKEN env var (single-tenant deployments).
 */
function extractToken(headers) {
  const auth = headers["authorization"];
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  if (headers["x-api-key"]) return String(headers["x-api-key"]).trim();
  if (headers["x-vercel-token"]) return String(headers["x-vercel-token"]).trim();
  return process.env.VERCEL_TOKEN || null;
}

/**
 * Handle a single JSON-RPC message. Returns a response object,
 * or null for notifications (no response required).
 */
async function handleMessage(msg, token) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && msg.id, -32600, "Invalid Request");
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case "initialize": {
        const requested = params && params.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Vercel MCP server. Use these tools to inspect and manage Vercel projects, deployments, build logs, domains and environment variables. Authenticate with a Vercel access token.",
        });
      }

      case "notifications/initialized":
      case "notifications/cancelled":
        return null; // notifications: no response

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case "tools/call": {
        const name = params && params.name;
        const tool = TOOL_MAP.get(name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
        if (!token) {
          return rpcResult(id, {
            content: [
              {
                type: "text",
                text: "Authentication error: no Vercel access token was provided. Configure the connection with a Vercel access token (https://vercel.com/account/settings/tokens).",
              },
            ],
            isError: true,
          });
        }
        try {
          const result = await tool.handler(token, (params && params.arguments) || {});
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: false,
          });
        } catch (e) {
          return rpcResult(id, {
            content: [
              {
                type: "text",
                text: `Vercel API error: ${e.message}${e.status ? ` (HTTP ${e.status})` : ""}`,
              },
            ],
            isError: true,
          });
        }
      }

      case "resources/list":
        return rpcResult(id, { resources: [] });

      case "prompts/list":
        return rpcResult(id, { prompts: [] });

      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (isNotification) return null;
    return rpcError(id, -32603, `Internal error: ${e.message}`);
  }
}

/**
 * Transport-agnostic HTTP handler for the Streamable HTTP transport.
 *
 * @param {object} req { method, headers (lowercased keys), body (string|object) }
 * @returns {Promise<{status:number, headers:object, body:string}>}
 */
async function handleHttp(req) {
  const jsonHeaders = { "Content-Type": "application/json" };

  if (req.method === "GET") {
    // No server-initiated stream support in stateless mode.
    return {
      status: 405,
      headers: { ...jsonHeaders, Allow: "POST" },
      body: JSON.stringify(rpcError(null, -32000, "Method Not Allowed: use POST for MCP requests")),
    };
  }
  if (req.method === "DELETE") {
    return { status: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true }) };
  }
  if (req.method !== "POST") {
    return {
      status: 405,
      headers: { ...jsonHeaders, Allow: "POST" },
      body: JSON.stringify(rpcError(null, -32000, "Method Not Allowed")),
    };
  }

  let parsed;
  try {
    parsed = typeof req.body === "string" ? JSON.parse(req.body || "null") : req.body;
  } catch {
    return {
      status: 400,
      headers: jsonHeaders,
      body: JSON.stringify(rpcError(null, -32700, "Parse error: invalid JSON")),
    };
  }
  if (!parsed) {
    return {
      status: 400,
      headers: jsonHeaders,
      body: JSON.stringify(rpcError(null, -32600, "Invalid Request: empty body")),
    };
  }

  const token = extractToken(req.headers || {});
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const responses = [];
  for (const m of messages) {
    const r = await handleMessage(m, token);
    if (r) responses.push(r);
  }

  if (responses.length === 0) {
    // Only notifications: 202 Accepted with no body per spec.
    return { status: 202, headers: {}, body: "" };
  }

  const body = Array.isArray(parsed) ? JSON.stringify(responses) : JSON.stringify(responses[0]);
  return { status: 200, headers: jsonHeaders, body };
}

module.exports = { handleHttp, handleMessage, extractToken, SERVER_INFO };
