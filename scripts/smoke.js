"use strict";

// Opt-in remote read-only acceptance test. Never invoked by npm test or a tool.
// Credentials come from the operator's environment, never command-line flags.
const { readLimited } = require("../lib/vercel-api");
const EXPECTED_VERSION = require("../package.json").version;
const PROTOCOL = "2025-06-18";
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

function configuration(env = process.env) {
  let url;
  try { url = new URL(env.MCP_SMOKE_URL); } catch { throw new Error("Set MCP_SMOKE_URL to your approved HTTPS bridge endpoint"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !["/mcp", "/api/mcp"].includes(url.pathname)) throw new Error("MCP_SMOKE_URL must be a query-free HTTPS /mcp or /api/mcp endpoint");
  if (!env.MCP_SMOKE_APPROVED_HOST || url.hostname !== env.MCP_SMOKE_APPROVED_HOST) throw new Error("Set MCP_SMOKE_APPROVED_HOST to the exact trusted bridge hostname before sending credentials");
  const token = env.MCP_SMOKE_TOKEN;
  if (typeof token !== "string" || token.length < 1 || token.length > 4096 || /[\s,]/.test(token)) throw new Error("Set MCP_SMOKE_TOKEN securely to a raw Vercel access token, not a Bearer header");
  const project = env.MCP_SMOKE_PROJECT_ID;
  if (!project || !/^prj_[A-Za-z0-9]+$/.test(project)) throw new Error("Set MCP_SMOKE_PROJECT_ID to an existing test project's prj_ ID");
  const teamId = env.MCP_SMOKE_TEAM_ID;
  if (teamId && !/^team_[A-Za-z0-9]+$/.test(teamId)) throw new Error("MCP_SMOKE_TEAM_ID must be a team_ ID when provided");
  return { url: url.href, token, project, teamId };
}
async function runSmoke(config, transport = global.fetch) {
  // Revalidate caller-supplied configs, including when imported by automation.
  const c = configuration({ MCP_SMOKE_URL: config.url, MCP_SMOKE_APPROVED_HOST: config.approvedHost,
    MCP_SMOKE_TOKEN: config.token, MCP_SMOKE_PROJECT_ID: config.project, MCP_SMOKE_TEAM_ID: config.teamId });
  let nextId = 0;
  const stages = [];
  async function rpc(method, params, notification = false) {
    const id = notification ? undefined : ++nextId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await transport(c.url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-api-key": c.token, "MCP-Protocol-Version": PROTOCOL },
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }) });
      if (notification) {
        if (response.status !== 202) throw new Error("Unexpected notification acknowledgement");
        await response.body?.cancel();
        return;
      }
      if (response.status !== 200) { await response.body?.cancel(); throw new Error("Unexpected HTTP status"); }
      const payload = JSON.parse(await readLimited(response, 1024 * 1024));
      if (payload.jsonrpc !== "2.0" || payload.id !== id || payload.error || !payload.result) throw new Error("Unexpected JSON-RPC response");
      return payload.result;
    } catch {
      // Do not print URLs, request arguments, server error bodies or secrets.
      throw new Error(`Smoke check failed at ${method}; inspect the connection privately. No writes were sent.`);
    } finally { clearTimeout(timer); }
  }
  const initialized = await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "vercel-bridge-readonly-smoke", version: EXPECTED_VERSION } });
  if (initialized.protocolVersion !== PROTOCOL || initialized.serverInfo?.name !== "vercel-mcp" || initialized.serverInfo?.version !== EXPECTED_VERSION) throw new Error("Unexpected bridge identity/version or protocol; verify the deployed revision before continuing");
  stages.push("initialize");
  await rpc("notifications/initialized", undefined, true);
  await rpc("ping"); stages.push("ping");
  const listed = await rpc("tools/list");
  if (!Array.isArray(listed.tools) || !listed.tools.length || new Set(listed.tools.map((t) => t.name)).size !== listed.tools.length) throw new Error("Invalid tool inventory");
  for (const t of listed.tools) if (!t.inputSchema || HINTS.some((key) => typeof t.annotations?.[key] !== "boolean")) throw new Error("Tool metadata is missing required schema/annotations");
  for (const name of ["get_project", "list_deployments"]) {
    const tool = listed.tools.find((t) => t.name === name);
    if (!tool || tool.annotations.readOnlyHint !== true) throw new Error("Required read-only smoke tool unavailable");
  }
  stages.push("discovery");
  async function readTool(name, args) {
    const result = await rpc("tools/call", { name, arguments: args });
    if (result.isError !== false || result.content?.length !== 1 || result.content[0].type !== "text") throw new Error(`Read-only smoke tool failed: ${name}. Check permissions privately; no response data is logged.`);
    try { return JSON.parse(result.content[0].text); } catch { throw new Error(`Invalid structured result from ${name}`); }
  }
  const scope = c.teamId ? { teamId: c.teamId } : {};
  const project = await readTool("get_project", { projectIdOrName: c.project, ...scope });
  if (project.id !== c.project) throw new Error("Project result did not match the explicitly selected project");
  stages.push("get_project");
  const deployments = await readTool("list_deployments", { projectId: c.project, limit: 1, includePagination: true, ...scope });
  if (!Array.isArray(deployments.deployments) || deployments.deployments.length > 1) throw new Error("Unexpected deployment-list result");
  stages.push("list_deployments");
  return { status: "passed", version: EXPECTED_VERSION, toolCount: listed.tools.length, checks: stages,
    writeRequests: 0, note: "Core remote reads passed. This does not validate Copilot Studio orchestration, deployment writes, or optional CLI-backed APIs." };
}
async function main() {
  try {
    const config = configuration();
    const result = await runSmoke({ ...config, approvedHost: process.env.MCP_SMOKE_APPROVED_HOST });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { configuration, runSmoke };
