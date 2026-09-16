"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { configuration, runSmoke } = require("../scripts/smoke");
const { handleHttp } = require("../lib/mcp");
const c = { url: "https://trusted.example/mcp", approvedHost: "trusted.example", token: "test-token-123", project: "prj_test", teamId: "team_test" };
const hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const tool = (name) => ({ name, inputSchema: { type: "object" }, annotations: hints });
function simulatedBridge(override = () => undefined) {
  const requests = [];
  return { requests, transport: async (url, options) => {
    assert.equal(url, c.url); assert.equal(options.method, "POST"); assert.equal(options.redirect, "error"); assert.ok(options.signal);
    assert.equal(options.headers["x-api-key"], c.token);
    const msg = JSON.parse(options.body); requests.push(msg);
    const modified = override(msg);
    if (modified) return modified;
    let result;
    switch (msg.method) {
      case "initialize": result = { protocolVersion: "2025-06-18", serverInfo: { name: "vercel-mcp", version: "2.0.0" } }; break;
      case "notifications/initialized": return new Response(null, { status: 202 });
      case "ping": result = {}; break;
      case "tools/list": result = { tools: [tool("get_project"), tool("list_deployments")] }; break;
      case "tools/call": {
        assert.ok(["get_project", "list_deployments"].includes(msg.params.name));
        const value = msg.params.name === "get_project" ? { id: c.project, name: "private-name" } : { deployments: [], pagination: { next: null } };
        result = { isError: false, content: [{ type: "text", text: JSON.stringify(value) }] }; break;
      }
      default: throw Error("Unexpected smoke request");
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  } };
}
test("remote smoke sends only the fixed read-only sequence and redacts summary data", async () => {
  const b = simulatedBridge(); const result = await runSmoke(c, b.transport);
  assert.equal(result.status, "passed"); assert.equal(result.writeRequests, 0); assert.equal(result.toolCount, 2);
  assert.deepEqual(b.requests.map((r) => r.method), ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call", "tools/call"]);
  assert.deepEqual(b.requests[4].params, { name: "get_project", arguments: { projectIdOrName: c.project, teamId: c.teamId } });
  assert.deepEqual(b.requests[5].params.arguments, { projectId: c.project, limit: 1, includePagination: true, teamId: c.teamId });
  for (const secret of [c.token, c.project, c.teamId, "private-name", "trusted.example"]) assert.equal(JSON.stringify(result).includes(secret), false);
});
test("smoke config is explicit and never uses server token fallback", () => {
  assert.throws(() => configuration({ VERCEL_TOKEN: c.token }), /MCP_SMOKE_URL/);
});
for (const bad of [{ url: "http://trusted.example/mcp" }, { url: "https://trusted.example/mcp?api_key=secret" }, { approvedHost: "other.example" }, { token: "Bearer abc" }, { project: "site" }, { teamId: "test-team" }]) test("smoke rejects unsafe/incomplete config " + Object.keys(bad)[0] + JSON.stringify(Object.keys(bad)), async () => {
  let calls = 0;
  await assert.rejects(runSmoke({ ...c, ...bad }, async () => { calls++; throw Error("No request allowed"); }));
  assert.equal(calls, 0);
});
test("smoke cannot mistake discovery alone for authenticated success", async () => {
  const b = simulatedBridge((msg) => msg.method === "tools/call" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "Sensitive upstream message test-token-123" }] } })) : undefined);
  await assert.rejects(runSmoke(c, b.transport), (e) => e.message.includes("get_project") && !e.message.includes(c.token) && !e.message.includes("Sensitive"));
  assert.equal(b.requests.filter((r) => r.method === "tools/call").length, 1);
});
test("smoke detects wrong project rather than accepting unrelated access", async () => {
  const b = simulatedBridge((msg) => msg.method === "tools/call" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { isError: false, content: [{ type: "text", text: '{"id":"prj_wrong"}' }] } })) : undefined);
  await assert.rejects(runSmoke(c, b.transport), /Project result did not match/);
});
test("smoke rejects redirects and login responses without logging body or URL", async () => {
  let calls = 0;
  await assert.rejects(runSmoke(c, async (_url, options) => {
    calls++; assert.equal(options.redirect, "error"); return new Response("private login data", { status: 302, headers: { location: "https://other.example/?api_key=secret" } });
  }), (e) => e.message.includes("initialize") && !/secret|private login data|https:/.test(e.message));
  assert.equal(calls, 1);
});
test("smoke rejects wrong version and mismatched JSON-RPC responses", async () => {
  for (const response of [
    { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "vercel-mcp", version: "1.0.0" } } },
    { jsonrpc: "2.0", id: 99, result: {} },
  ]) await assert.rejects(runSmoke(c, async () => new Response(JSON.stringify(response))));
});
test("smoke harness works end to end through the real MCP handler with only upstream reads mocked", async () => {
  const fetch = global.fetch;
  const selected = process.env.VERCEL_MCP_TOOLS;
  delete process.env.VERCEL_MCP_TOOLS;
  let count = 0;
  global.fetch = async (url, options) => {
    assert.equal(options.method, "GET"); count++;
    const u = new URL(url); assert.equal(u.origin, "https://api.vercel.com");
    if (u.pathname === "/v10/projects/prj_test") return new Response(JSON.stringify({ id: c.project }));
    assert.equal(u.pathname, "/v6/deployments"); return new Response('{"deployments":[],"pagination":{}}');
  };
  try {
    const result = await runSmoke(c, async (_url, options) => {
      const r = await handleHttp({ method: options.method, headers: options.headers, body: options.body });
      return new Response(r.body || null, { status: r.status, headers: r.headers });
    });
    assert.equal(result.status, "passed"); assert.equal(count, 2);
  } finally { global.fetch = fetch; if (selected === undefined) delete process.env.VERCEL_MCP_TOOLS; else process.env.VERCEL_MCP_TOOLS = selected; }
});
