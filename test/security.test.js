"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const https = require("node:https");
const dns = require("node:dns").promises;
const http = require("node:http");
const { handleHttp, extractToken, MAX_REQUEST_BYTES } = require("../lib/mcp");
const { vercelFetch, dashboardFetch, readLimited, MAX_RESPONSE_BYTES } = require("../lib/vercel-api");
const { publicText, publicIPv4, parsePublicUrl } = require("../lib/public-fetch");
const { createServer } = require("../server");
const { serveMcp, readBody } = require("../lib/http");
const token = "test-token-123";
const realFetch = global.fetch, realLookup = dns.lookup, realGet = https.get;
let calls;
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("VERCEL_MCP_") || key === "VERCEL_TOKEN") delete process.env[key];
  calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); throw Error("Network call not expected"); };
});
afterEach(() => { global.fetch = realFetch; dns.lookup = realLookup; https.get = realGet; });
async function rpc(method, args, headers = {}) {
  const r = await handleHttp({ method: "POST", headers: { "x-api-key": token, ...headers }, body: { jsonrpc: "2.0", id: 1, method, params: args } });
  return { ...r, json: JSON.parse(r.body) };
}
const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });

test("read-only defaults hide writes and enforce policy on direct calls", async () => {
  const r = await rpc("tools/list");
  assert.ok(r.json.result.tools.every((t) => t.annotations.readOnlyHint));
  for (const name of ["deploy_to_vercel", "promote_deployment", "create_env_var", "delete_env_var", "cancel_deployment"]) {
    const r = await call(name); assert.equal(r.json.result.isError, true); assert.match(r.json.result.content[0].text, /disabled/);
  }
  assert.equal(calls.length, 0);
});
test("CLI-backed APIs and external fetch are disabled independently", async () => {
  for (const name of ["list_agent_runs", "get_runtime_logs", "list_toolbar_threads", "web_fetch_vercel_url", "import-claude-design-from-url"]) assert.equal((await call(name)).json.result.isError, true);
  assert.equal(calls.length, 0);
});
test("tool allowlist is enforced even with all writes enabled", async () => {
  process.env.VERCEL_MCP_ALLOW_WRITES = "true"; process.env.VERCEL_MCP_TOOLS = "get_current_user";
  assert.deepEqual((await rpc("tools/list")).json.result.tools.map((t) => t.name), ["get_current_user"]);
  assert.equal((await call("cancel_deployment", { deploymentId: "dpl" })).json.result.isError, true);
  assert.equal(calls.length, 0);
});
test("flags must be exactly true; missing or typo flags fail closed", async () => {
  process.env.VERCEL_MCP_ALLOW_WRITES = "TRUE";
  assert.equal((await call("cancel_deployment", { deploymentId: "dpl" })).json.result.isError, true);
  process.env.VERCEL_MCP_TOOLS = "";
  assert.equal((await rpc("tools/list")).json.result.tools.length, 0);
});
test("production gate covers deployment, promotion and environment changes", async () => {
  process.env.VERCEL_MCP_ALLOW_WRITES = "true";
  for (const [name, args] of [
    ["deploy_to_vercel", { name: "site", target: "production", files: [{ file: "a", data: "x" }] }],
    ["promote_deployment", { projectId: "p", deploymentId: "d" }],
    ["create_env_var", { projectIdOrName: "p", key: "A", value: "x" }],
    ["delete_env_var", { projectIdOrName: "p", envVarId: "e" }],
  ]) { const r = await call(name, args); assert.match(r.json.result.content[0].text, /ALLOW_PRODUCTION/); }
  assert.equal(calls.length, 0);
});
test("environment fallback cannot grant unauthenticated access", () => {
  process.env.VERCEL_TOKEN = "server-secret"; assert.equal(extractToken({}), null);
});
test("authentication ambiguity is rejected without revealing values", async () => {
  assert.equal(extractToken({ authorization: "Bearer " + token, "x-api-key": token }), token);
  assert.throws(() => extractToken({ "x-api-key": "Bearer " + token }), /raw/);
  assert.throws(() => extractToken({ "x-api-key": [token, "other"] }), /Ambiguous/);
  const r = await rpc("ping", {}, { authorization: "Bearer other-secret" });
  assert.equal(r.status, 401); assert.ok(!r.body.includes("other-secret"));
});
test("arbitrary browser origins rejected; exact operator allowlist accepted", async () => {
  assert.equal((await rpc("ping", {}, { origin: "https://evil.example" })).status, 403);
  process.env.VERCEL_MCP_ALLOWED_ORIGINS = "https://trusted.example";
  assert.equal((await rpc("ping", {}, { origin: "https://trusted.example" })).status, 200);
  assert.equal((await rpc("ping", {}, { origin: "https://trusted.example.evil" })).status, 403);
});
test("mutating notifications cannot run", async () => {
  process.env.VERCEL_MCP_ALLOW_WRITES = "true";
  const r = await handleHttp({ method: "POST", headers: { "x-api-key": token }, body: { jsonrpc: "2.0", method: "tools/call", params: { name: "cancel_deployment", arguments: { deploymentId: "d" } } } });
  assert.equal(r.status, 202); assert.equal(calls.length, 0);
});
test("invalid JSON-RPC types and invalid arguments fail before network", async () => {
  for (const args of [null, [], "bad", { limit: -1 }, { limit: 1.2 }, { limit: 101 }, { ignored: true }]) assert.equal((await call("list_projects", args)).json.result.isError, true);
  const r = await handleHttp({ method: "POST", headers: {}, body: { jsonrpc: "2.0", id: {}, method: "ping" } });
  assert.equal(JSON.parse(r.body).error.code, -32600); assert.equal(calls.length, 0);
});
test("dot segments and dangerous property names rejected", async () => {
  assert.equal((await call("get_project", { projectIdOrName: ".." })).json.result.isError, true);
  assert.equal((await call("get_project", JSON.parse('{"projectIdOrName":"p","__proto__":{"x":1}}'))).json.result.isError, true);
  assert.equal(calls.length, 0);
});
test("oversized payloads and oversized/empty/tool-call batches rejected", async () => {
  const r = await handleHttp({ method: "POST", headers: {}, body: " ".repeat(MAX_REQUEST_BYTES + 1) }); assert.equal(r.status, 413);
  for (const body of [[], Array(11).fill({ jsonrpc: "2.0", id: 1, method: "ping" }), [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_current_user" } }]]) {
    assert.equal((await handleHttp({ method: "POST", headers: {}, body })).status, 400);
  }
});
test("redacts current token and known secret fields in output and errors", async () => {
  global.fetch = async () => new Response(JSON.stringify({ user: { id: "u", username: token, email: "a@b.test", name: "Test" } }));
  const r = await call("get_current_user"); assert.equal(r.json.result.isError, false); assert.ok(!r.body.includes(token));
  global.fetch = async () => new Response(JSON.stringify({ error: { message: "rejected " + token } }), { status: 403 });
  const e = await call("get_current_user"); assert.ok(!e.body.includes(token)); assert.match(e.body, /redacted/);
  const { sanitize } = require("../lib/policy");
  assert.deepEqual(sanitize({ password: "x", type: "encrypted", value: "secret", tokenUsage: 123 }, token), { password: "[hidden]", type: "encrypted", value: "[hidden]", tokenUsage: 123 });
});
test("successful oversized results return an explicit error, not truncated totals", async () => {
  process.env.VERCEL_MCP_ENABLE_CLI_APIS = "true";
  global.fetch = async () => new Response(JSON.stringify({ thread: "x".repeat(600000) }));
  const r = await call("list_toolbar_threads", { teamId: "team_test" });
  assert.equal(r.json.result.isError, true); assert.match(r.body, /524288/);
});
test("fixed API destinations, safe redirects and no automatic write retries", async () => {
  global.fetch = async (url, options) => { calls.push({ url, options }); throw new TypeError("fetch failed"); };
  await assert.rejects(vercelFetch(token, "POST", "/v13/deployments", {}, { name: "site" }), /outcome unknown/);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.redirect, "error");
  await assert.rejects(vercelFetch(token, "GET", "//evil.example"), /Invalid API path/);
  await assert.rejects(dashboardFetch(token, "/anything", {}), /Disallowed/);
  assert.equal(calls.length, 1);
});
test("upstream limits, non-JSON errors, and rate limits fail explicitly", async () => {
  await assert.rejects(readLimited(new Response("abcdef"), 5), /size limit/);
  await assert.rejects(readLimited(new Response("x", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } })), /size limit/);
  global.fetch = async () => new Response("<html>login</html>", { status: 200 });
  await assert.rejects(vercelFetch(token, "GET", "/v2/user"), /Non-JSON/);
  global.fetch = async () => new Response(JSON.stringify({ error: { message: "Too many" } }), { status: 429 });
  await assert.rejects(vercelFetch(token, "GET", "/v2/user"), /rate limited/);
});
test("API timeout aborts reads and warns about uncertain writes", async () => {
  const timer = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => ms === 20000 ? timer(fn, 5, ...args) : timer(fn, ms, ...args);
  global.fetch = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  try {
    await assert.rejects(vercelFetch(token, "GET", "/v2/user"), /timed out/);
    await assert.rejects(vercelFetch(token, "POST", "/v13/deployments", {}, {}), /outcome unknown/);
  } finally { global.setTimeout = timer; }
});
for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2", "172.16.0.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::ffff:127.0.0.1"]) test("reject nonpublic address " + address, () => assert.equal(publicIPv4(address), false));
for (const url of ["http://site.vercel.app", "https://user:password@site.vercel.app", "https://site.vercel.app:444", "https://127.0.0.1", "https://site.vercel.app/?token=x", "https://evil.example/"]) test("reject unsafe public URL " + url, () => assert.throws(() => parsePublicUrl(url, (h) => h === "site.vercel.app")));
test("private DNS resolution blocked before HTTPS", async () => {
  dns.lookup = async () => [{ address: "127.0.0.1", family: 4 }]; https.get = () => { throw Error("Must not connect"); };
  await assert.rejects(publicText("https://site.vercel.app", () => true), /public IPv4/);
});
test("public fetch pins DNS, sends no credentials, and bounds content", async () => {
  dns.lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  let size = 4;
  https.get = (_url, options, callback) => {
    assert.deepEqual(Object.keys(options.headers), ["Accept"]);
    options.lookup("site.vercel.app", {}, (_err, address, family) => { assert.equal(address, "8.8.8.8"); assert.equal(family, 4); });
    const request = new EventEmitter(); request.destroy = () => {};
    queueMicrotask(() => { const res = new PassThrough(); res.statusCode = 200; res.headers = { "content-type": "text/plain" }; callback(res); res.end("x".repeat(size)); });
    return request;
  };
  assert.equal((await publicText("https://site.vercel.app", () => true, 5)).text, "xxxx");
  size = 6; await assert.rejects(publicText("https://site.vercel.app", () => true, 5), /size limit/);
});
test("public fetch never follows redirects", async () => {
  dns.lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  let requests = 0;
  https.get = (_url, _options, callback) => {
    requests++; const req = new EventEmitter(); req.destroy = () => {};
    queueMicrotask(() => { const res = new PassThrough(); res.statusCode = 302; res.headers = { location: "http://169.254.169.254" }; callback(res); res.end(); });
    return req;
  };
  await assert.rejects(publicText("https://site.vercel.app", () => true), /redirects/); assert.equal(requests, 1);
});
test("aborted and oversized raw request streams settle promptly", async () => {
  const req = new EventEmitter(); req.resume = () => {};
  const p = readBody(req); req.emit("aborted"); await assert.rejects(p, /aborted/);
  const req2 = new EventEmitter(); req2.resume = () => {};
  const p2 = readBody(req2); req2.emit("data", Buffer.alloc(MAX_REQUEST_BYTES + 1)); await assert.rejects(p2, /large/);
});
function mockResponse() {
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } };
}
test("Vercel adapter accepts parsed JSON and rejects oversized parsed payloads", async () => {
  const adapter = require("../api/mcp");
  const res = mockResponse(); await adapter({ method: "POST", headers: {}, body: { jsonrpc: "2.0", id: 1, method: "ping" } }, res);
  assert.equal(res.statusCode, 200); assert.deepEqual(JSON.parse(res.body).result, {});
  const big = mockResponse(); await adapter({ method: "POST", headers: {}, body: { huge: "x".repeat(MAX_REQUEST_BYTES) } }, big);
  assert.equal(big.statusCode, 413);
});
test("per-instance concurrency guard fails closed and releases slots", async () => {
  const reqs = [], pending = [];
  for (let i = 0; i < 16; i++) { const req = new EventEmitter(); req.method = "POST"; req.headers = {}; req.resume = () => {}; reqs.push(req); pending.push(serveMcp(req, mockResponse())); }
  const busy = mockResponse(); await serveMcp({ resume() {} }, busy); assert.equal(busy.statusCode, 503);
  for (const req of reqs) req.emit("end"); await Promise.all(pending);
  const ready = mockResponse(); await serveMcp({ method: "POST", headers: {}, body: { jsonrpc: "2.0", id: 1, method: "ping" } }, ready); assert.equal(ready.statusCode, 200);
});
test("standalone host responds on an ephemeral port and closes cleanly", async () => {
  const server = createServer(); await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/mcp", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
        let body = ""; res.on("data", (c) => body += c); res.on("end", () => resolve({ status: res.statusCode, body }));
      }); req.on("error", reject); req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    });
    assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body).result, {});
  } finally { await new Promise((r) => server.close(r)); }
});

test("public DNS resolution has a deadline", async () => {
  const originalTimer = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => ms === 5000 ? originalTimer(fn, 5, ...args) : originalTimer(fn, ms, ...args);
  dns.lookup = async () => new Promise(() => {});
  try { await assert.rejects(publicText("https://site.vercel.app", () => true), /DNS lookup timed out/); }
  finally { global.setTimeout = originalTimer; }
});

test("coverage inventory is complete, unique and never advertises blocked tools", () => {
  const coverage = require("../docs/coverage.json").coverage;
  const { TOOLS } = require("../lib/tools");
  assert.equal(coverage.length, 32); assert.equal(new Set(coverage.map((c) => c.name)).size, 32);
  assert.equal(coverage.filter((c) => c.implemented).length, 24);
  for (const item of coverage) assert.equal(TOOLS.some((t) => t.name === item.name), item.implemented, item.name);
});

test("production read filters do not require production-write permission", async () => {
  global.fetch = async () => new Response(JSON.stringify({ deployments: [] }));
  const r = await call("list_deployments", { target: "production" });
  assert.equal(r.json.result.isError, false, r.json.result.content[0].text);
});

test("result size limit includes pretty-print formatting", async () => {
  process.env.VERCEL_MCP_ENABLE_CLI_APIS = "true";
  const data = { rows: Array.from({ length: 30000 }, () => ({ a: 1 })) };
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 524288);
  assert.ok(Buffer.byteLength(JSON.stringify(data, null, 2)) > 524288);
  global.fetch = async () => new Response(JSON.stringify(data));
  const r = await call("list_toolbar_threads", { teamId: "team_test" });
  assert.equal(r.json.result.isError, true); assert.match(r.body, /524288/);
});

for (const query of ["api_key=test-secret", "apikey=test-secret", "API-KEY=test-secret", "auth=test-secret", "access_token=test-secret", "%61pi%5fkey=test-secret", "key=test-secret", "code=test-secret", "page=2", "unknown=test-secret"]) {
  test("public URLs reject query strings before DNS/HTTPS: " + query.split("=")[0], async () => {
    let dnsCalls = 0, httpCalls = 0;
    dns.lookup = async () => { dnsCalls++; return [{ address: "8.8.8.8", family: 4 }]; };
    https.get = () => { httpCalls++; throw new Error("Must never send a query-bearing URL"); };
    await assert.rejects(publicText("https://site.vercel.app/?" + query, () => true), /query|Query/);
    assert.equal(dnsCalls, 0); assert.equal(httpCalls, 0);
  });
}
