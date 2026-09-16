"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
// Stub only public HTTP here. Real URL/DNS/TLS policy is exercised separately.
const publicModule = require("../lib/public-fetch");
let publicCalls = [], publicResponse = "", publicFailure;
publicModule.publicText = async (url, approve) => {
  assert.equal(approve(new URL(url).hostname), true);
  publicCalls.push(url);
  if (publicFailure) throw new Error("Public fetch failed");
  return { url, text: publicResponse, contentType: "text/html" };
};
const { handleHttp } = require("../lib/mcp");
const { TOOLS } = require("../lib/tools");
const token = "test-token-123";
const team = "team_test";
const scope = { teamId: team };
const deployed = { id: "dpl_new", url: "site.vercel.app", readyState: "BUILDING", target: null };
const step = (method, path, query, response, body) => ({ method, path, query, response, body });
const GET = (path, response, query = scope) => step("GET", path, query, response);
const POST = (path, body, response = deployed, query = scope) => step("POST", path, query, response, body);
const cases = [
  { name: "deploy_to_vercel", write: true, args: { name: "site", target: "preview", teamId: team, files: [{ file: "index.html", data: "<h1>Hello</h1>" }] },
    steps: [POST("/v13/deployments", { name: "site", files: [{ file: "index.html", data: "PGgxPkhlbGxvPC9oMT4=", encoding: "base64" }] })], check: (v) => { assert.equal(v.readyState, "BUILDING"); assert.match(v.message, /not verified/); } },
  { name: "deploy_from_git", write: true, args: { projectId: "prj/a?", teamId: team, ref: "feature/test", target: "preview" }, steps: [
    GET("/v10/projects/prj%2Fa%3F", { id: "prj_test", name: "site", link: { type: "github", org: "test", repo: "site" } }),
    POST("/v13/deployments", { project: "prj_test", name: "site", gitSource: { type: "github", org: "test", repo: "site", ref: "feature/test" } }),
  ], check: (v) => assert.equal(v.id, "dpl_new") },
  { name: "redeploy_deployment", write: true, args: { deploymentId: "dpl/old", teamId: team, target: "preview" }, steps: [
    GET("/v13/deployments/dpl%2Fold", { id: "dpl_old", name: "site", projectId: "prj_test", target: null }),
    POST("/v13/deployments", { deploymentId: "dpl_old", name: "site", project: "prj_test", withLatestCommit: false }),
  ], check: (v) => assert.equal(v.id, "dpl_new") },
  { name: "get_web_analytics", args: { projectId: "prj_test", teamId: team }, steps: [GET("/v1/query/web-analytics/visits/count", { data: { visitors: 123, pageviews: 456 } }, { projectId: "prj_test", teamId: team })], check: (v) => assert.equal(v.data.pageviews, 456) },
  { name: "check_domain_availability_and_price", args: { names: ["Example.com"], teamId: team, years: 2 }, steps: [
    GET("/v1/registrar/domains/example.com/availability", { available: true }),
    GET("/v1/registrar/domains/example.com/price", { years: 2, purchasePrice: 25.99, renewalPrice: 27.99, transferPrice: null }, { teamId: team, years: "2" }),
  ], check: (v) => { assert.equal(v[0].pricing.purchasePrice, 25.99); assert.equal(v[0].pricing.years, 2); } },
  { name: "get_domain_order", args: { orderId: "order/a", teamId: team }, steps: [GET("/v1/registrar/orders/order%2Fa", { orderId: "order/a", status: "purchasing", domains: [] })], check: (v) => assert.equal(v.status, "purchasing") },
  ...[
    ["list_agent_run_projects", { view: "team" }, {}],
    ["list_agent_runs", { project: "site", page: "1", pageSize: "20" }, { projectId: "site" }],
    ["get_agent_run", { project: "site", runId: "run_test" }, { projectId: "site", runId: "run_test" }],
    ["get_agent_run_trace", { project: "site", runId: "run_test", trace: "1" }, { projectId: "site", runId: "run_test", maxFieldLength: 4 }],
  ].map(([name, query, args]) => ({ name, cli: true, args: { teamId: team, from: "2026-09-14T00:00:00Z", to: "2026-09-15T00:00:00Z", ...args }, steps: [
    { ...GET("/api/observability/agent-runs", { message: "abcdefgh", tokens: 100 }, { teamSlug: team, environment: "production", from: "1789344000", to: "1789430400", ...query }), origin: "https://vercel.com" },
  ], check: (v) => { assert.equal(v.tokens, 100); assert.equal(v.message, name === "get_agent_run_trace" ? "abcd [truncated 4 characters]" : "abcdefgh"); } })),
  { name: "get_runtime_logs", cli: true, args: { projectId: "site", teamId: team, since: "2026-09-14T00:00:00Z", until: "2026-09-15T00:00:00Z", limit: 1, level: ["error", "fatal"], query: "test & failure" }, steps: [
    GET("/v10/projects/site", { id: "prj_test", accountId: team }),
    { ...GET("/api/logs/request-logs", { rows: [{ requestId: "r1" }, { requestId: "r2" }], hasMoreRows: true }, { projectId: "prj_test", ownerId: team, page: "0", startDate: "1789344000000", endDate: "1789430400000", level: "error,fatal", search: "test & failure" }), origin: "https://vercel.com" },
  ], check: (v) => { assert.equal(v.rows.length, 1); assert.equal(v.truncated, true); assert.equal(v.pagination.nextPage, 1); } },
  { name: "list_toolbar_threads", cli: true, args: { teamId: team, projectId: "site", cursor: "next&=?" }, steps: [GET("/toolbar/threads", { threads: [{ id: "t1" }], pagination: { nextCursor: "n2" } }, { teamId: team, projectId: "site", cursor: "next&=?", status: "unresolved", limit: "20" })], check: (v) => assert.equal(v.pagination.nextCursor, "n2") },
  { name: "get_toolbar_thread", cli: true, args: { teamId: team, threadId: "t/a" }, steps: [GET("/toolbar/threads/t%2Fa", { id: "t/a", messageCount: 2 }), GET("/toolbar/threads/t%2Fa/messages", { messages: [{ id: "m1" }], pagination: { nextCursor: "m2" } }, { teamId: team, limit: "100" })], check: (v) => assert.equal(v.pagination.nextCursor, "m2") },
  { name: "change_toolbar_thread_resolve_status", cli: true, write: true, args: { teamId: team, threadId: "t/a", resolved: false }, steps: [step("PATCH", "/toolbar/threads/t%2Fa", scope, { resolved: false }, { resolved: false })], check: (v) => assert.equal(v.resolved, false) },
  { name: "reply_to_toolbar_thread", cli: true, write: true, args: { teamId: team, threadId: "t/a", markdown: "Fixed" }, steps: [POST("/toolbar/threads/t%2Fa/messages", { markdown: "Fixed" }, { id: "m1" })], check: (v) => assert.equal(v.id, "m1") },
  { name: "edit_toolbar_message", cli: true, write: true, args: { teamId: team, threadId: "t/a", messageId: "m/?", markdown: "Correction" }, steps: [step("PATCH", "/toolbar/threads/t%2Fa/messages/m%2F%3F", scope, { id: "m/?" }, { markdown: "Correction" })], check: (v) => assert.equal(v.id, "m/?") },
  { name: "use_vercel_cli", local: true, args: { action: "Help me deploy", command: "deploy" }, steps: [], check: (v) => { assert.equal(v.executed, false); assert.equal(v.helpCommand, "vercel deploy --help"); } },
  { name: "search_vercel_documentation", args: { topic: "routing" }, steps: [], public: "[Routing](https://vercel.com/docs/routing)\n[Domains](https://vercel.com/docs/domains)", check: (v) => { assert.match(v.text, /Routing/); assert.equal(v.matchingEntries, 1); assert.equal(publicCalls.length, 1); } },
  { name: "web_fetch_vercel_url", external: true, args: { url: "https://site.vercel.app/about", teamId: team }, steps: [GET("/v13/deployments/site.vercel.app", { id: "dpl_x", url: "site.vercel.app" })], public: "Hello", check: (v) => { assert.equal(v.text, "Hello"); assert.equal(publicCalls[0], "https://site.vercel.app/about"); } },
  { name: "import-claude-design-from-url", external: true, write: true, args: { url: "https://claudeusercontent.com/design", name: "design", target: "preview", teamId: team }, steps: [POST("/v13/deployments", { name: "design", files: [{ file: "index.html", data: "PCFkb2N0eXBlIGh0bWw+PGgxPkhpPC9oMT4=", encoding: "base64" }] })], public: "<!doctype html><h1>Hi</h1>", check: (v) => assert.equal(v.id, "dpl_new") },
];
const realFetch = global.fetch;
let queue, calls, rejection, unexpected;
beforeEach(() => {
  for (const key of ["ALLOW_WRITES", "ALLOW_PRODUCTION", "ENABLE_CLI_APIS", "ALLOW_EXTERNAL_FETCH"]) process.env["VERCEL_MCP_" + key] = "true";
  delete process.env.VERCEL_MCP_TOOLS;
  process.env.VERCEL_MCP_FETCH_HOSTS = "site.vercel.app";
  queue = []; calls = []; publicCalls = []; publicFailure = false; rejection = false; unexpected = null;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const spec = queue.shift();
    if (!spec) { unexpected = "Unexpected request"; throw Error(unexpected); }
    try {
      const u = new URL(url);
      assert.equal(u.origin, spec.origin || "https://api.vercel.com"); assert.equal(u.pathname, spec.path);
      const actual = Object.fromEntries([...new Set(u.searchParams.keys())].map((key) => [key, u.searchParams.getAll(key).length > 1 ? u.searchParams.getAll(key) : u.searchParams.get(key)]));
      assert.deepEqual(actual, spec.query);
      assert.equal(options.method, spec.method); assert.equal(options.redirect, "error"); assert.ok(options.signal);
      assert.deepEqual(options.headers, { Authorization: "Bearer test-token-123", "Content-Type": "application/json" });
      assert.deepEqual(options.body ? JSON.parse(options.body) : undefined, spec.body);
    } catch (e) { unexpected = e; throw e; }
    return new Response(JSON.stringify(rejection ? { error: { message: "Not authorized" } } : spec.response), { status: rejection ? 403 : 200 });
  };
});
afterEach(() => { global.fetch = realFetch; if (unexpected) throw unexpected; });
async function call(name, args) {
  const r = await handleHttp({ method: "POST", headers: { "x-api-key": token }, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  assert.equal(r.status, 200);
  return JSON.parse(r.body).result;
}
for (const c of cases) {
  test(c.name + " exact request, response and annotation contract", async () => {
    queue = [...c.steps]; publicResponse = c.public;
    const r = await call(c.name, c.args);
    assert.equal(r.isError, false, r.content[0].text); assert.equal(queue.length, 0);
    c.check(JSON.parse(r.content[0].text));
    assert.deepEqual(TOOLS.find((t) => t.name === c.name).annotations, { readOnlyHint: !c.write, destructiveHint: !!c.write, idempotentHint: !c.write, openWorldHint: !c.local });
  });
  if (c.steps.length || c.public) test(c.name + " upstream failure is not hidden or retried", async () => {
    queue = [...c.steps]; rejection = true; publicResponse = c.public;
    if (c.name === "search_vercel_documentation" || c.name === "import-claude-design-from-url") publicFailure = true;
    const r = await call(c.name, c.args);
    assert.equal(r.isError, true); assert.match(r.content[0].text, /Not authorized|Public fetch failed/);
    assert.ok(calls.length <= (c.name === "check_domain_availability_and_price" ? 2 : 1));
  });
  test(c.name + " rejects unknown arguments before any network", async () => {
    const r = await call(c.name, { ...c.args, injected: "ignored?" });
    assert.equal(r.isError, true); assert.equal(calls.length, 0); assert.equal(publicCalls.length, 0);
  });
}

test("union of legacy and extended fixtures covers every registered tool", () => {
  const legacyText = fs.readFileSync(require.resolve("./tool-contracts"), "utf8");
  const legacy = [...legacyText.split("const HINTS")[0].matchAll(/^  ([a-z_]+): \[/gm)].map((m) => m[1]);
  const expected = [...legacy, ...cases.map((c) => c.name)].sort();
  assert.equal(expected.length, 33); assert.equal(new Set(expected).size, 33);
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), expected);
});
test("analytics aggregates encode both dimensions and preserve exact totals", async () => {
  queue = [GET("/v1/query/web-analytics/events/aggregate", { data: [{ count: 15 }] }, { teamId: team, projectId: "p", by: ["day", "eventName"], since: "1789344000000", until: "1789430400000", limit: "10" })];
  const r = await call("get_web_analytics", { projectId: "p", teamId: team, dataset: "events", mode: "aggregate", by: ["day", "eventName"], since: "2026-09-14", until: "2026-09-15" });
  assert.equal(r.isError, false, r.content[0].text); assert.equal(JSON.parse(r.content[0].text).data[0].count, 15);
});
for (const args of [{ projectId: "p", mode: "aggregate" }, { projectId: "p", since: "2026-09-14" }, { projectId: "p", by: ["day"] }]) test("analytics rejects incomplete or irrelevant options " + JSON.stringify(args), async () => {
  assert.equal((await call("get_web_analytics", args)).isError, true); assert.equal(calls.length, 0);
});
test("production file deployment sends explicit production target", async () => {
  const c = cases[0]; queue = [{ ...c.steps[0], body: { ...c.steps[0].body, target: "production" } }];
  assert.equal((await call(c.name, { ...c.args, target: "production" })).isError, false);
});
test("production deployment cannot accidentally inherit production on preview redeploy", async () => {
  const c = cases[2]; queue = [{ ...c.steps[0], response: { ...c.steps[0].response, target: "production" } }];
  const r = await call(c.name, c.args); assert.equal(r.isError, true); assert.match(r.content[0].text, /Cannot safely redeploy/); assert.equal(calls.length, 1);
});
test("Git deployment rejects a project without supported linked repository", async () => {
  const c = cases[1]; queue = [{ ...c.steps[0], response: { id: "p", name: "site" } }];
  assert.equal((await call(c.name, c.args)).isError, true); assert.equal(calls.length, 1);
});
for (const path of ["../secret", "/absolute", "a\\b", ".env", "dir/.env.local", ".git/config", "node_modules/a", "private.pem", "a/./b"]) test("deploy rejects unsafe source path " + path, async () => {
  const r = await call("deploy_to_vercel", { name: "site", target: "preview", files: [{ file: path, data: "x" }] });
  assert.equal(r.isError, true); assert.equal(calls.length, 0);
});
test("deployment requires explicit target, rejects duplicates, invalid base64, secrets and oversized decoded files", async () => {
  const base = { name: "site", target: "preview" };
  for (const files of [
    [{ file: "a", data: "x" }, { file: "a", data: "y" }], [{ file: "a", data: "!?==", encoding: "base64" }],
    [{ file: "a", data: "-----BEGIN PRIVATE KEY-----" }], [{ file: "a", data: "a".repeat(1048577) }],
  ]) assert.equal((await call("deploy_to_vercel", { ...base, files })).isError, true);
  assert.equal((await call("deploy_to_vercel", { name: "site", files: [{ file: "a", data: "x" }] })).isError, true);
  assert.equal(calls.length, 0);
});
test("unverified deployment host is never fetched", async () => {
  const c = cases.find((c) => c.name === "web_fetch_vercel_url"); queue = [{ ...c.steps[0], response: { id: "dpl", url: "other.vercel.app" } }];
  assert.equal((await call(c.name, c.args)).isError, true); assert.equal(publicCalls.length, 0);
});
test("public documentation and CLI helpers never send the Vercel credential", async () => {
  publicResponse = "[Routing](https://vercel.com/docs/routing)";
  await call("search_vercel_documentation", { topic: "routing" }); await call("use_vercel_cli", { action: "help" });
  assert.equal(calls.length, 0); assert.deepEqual(publicCalls, ["https://vercel.com/docs/sitemap.md"]);
});

test("legacy list pagination preserves continuation metadata and correct project cursor", async () => {
  queue = [GET("/v10/projects", { projects: [{ id: "p", name: "site" }], pagination: { next: "continuation" } }, { teamId: team, limit: "20", from: "cursor&next" })];
  const r = await call("list_projects", { teamId: team, from: "cursor&next", includePagination: true });
  assert.equal(r.isError, false, r.content[0].text); assert.equal(JSON.parse(r.content[0].text).pagination.next, "continuation");
});
test("REST team slugs use slug query while CLI-backed thread endpoints retain teamId", async () => {
  queue = [GET("/v1/query/web-analytics/visits/count", { data: { visitors: 1 } }, { projectId: "p", slug: "my-team" })];
  assert.equal((await call("get_web_analytics", { projectId: "p", teamId: "my-team" })).isError, false);
  queue = [GET("/toolbar/threads", { threads: [] }, { teamId: "my-team", limit: "20", status: "unresolved" })];
  assert.equal((await call("list_toolbar_threads", { teamId: "my-team" })).isError, false);
});
test("enhanced build logs send bounded backward query, filter errors and return scan metadata", async () => {
  queue = [GET("/v3/deployments/dpl%2Fx/events", [{ type: "stderr", created: 2, payload: { text: "Error" } }, { type: "stdout", created: 1, payload: { text: "Info" } }], { teamId: team, builds: "1", follow: "0", limit: "1000", direction: "backward", since: "1789344000000", until: "1789430400000", name: "bld_x" })];
  const r = await call("get_deployment_build_logs", { idOrUrl: "dpl/x", teamId: team, errorsOnly: true, includePagination: true, since: "2026-09-14", until: "2026-09-15", buildId: "bld_x" });
  assert.equal(r.isError, false, r.content[0].text);
  assert.deepEqual(JSON.parse(r.content[0].text), { lines: [{ type: "stderr", created: 2, text: "Error" }], possiblyMore: false, scannedEvents: 2 });
});
test("get_project accepts official projectId alias and rejects conflicting aliases", async () => {
  queue = [GET("/v10/projects/site", { id: "p", name: "site" })];
  assert.equal((await call("get_project", { projectId: "site", teamId: team })).isError, false);
  assert.equal((await call("get_project", { projectId: "one", projectIdOrName: "two" })).isError, true);
  assert.equal(calls.length, 1);
});
test("documentation index converts relative links to absolute Vercel URLs", async () => {
  publicResponse = "[Routing](/docs/routing) | routing docs";
  const r = await call("search_vercel_documentation", { topic: "routing" });
  assert.match(JSON.parse(r.content[0].text).text, /https:\/\/vercel.com\/docs\/routing/);
});
test("failed deployment response remains ERROR and never becomes successful completion", async () => {
  const c = cases[0]; queue = [{ ...c.steps[0], response: { ...deployed, readyState: "ERROR", errorMessage: "Build failed" } }];
  const r = await call(c.name, c.args); const d = JSON.parse(r.content[0].text);
  assert.equal(d.readyState, "ERROR"); assert.equal(d.errorMessage, "Build failed"); assert.match(d.message, /not verified/);
});

// PR review regression: both upload paths normalize their wire payload to
// base64, while keeping the caller-facing UTF-8/base64 interface unchanged.
for (const [label, source, encoded] of [
  ["default UTF-8", { file: "greeting.txt", data: "Hello" }, "SGVsbG8="],
  ["explicit UTF-8 Unicode", { file: "greeting.txt", data: "Grá — 世界 🌍", encoding: "utf-8" }, "R3LDoSDigJQg5LiW55WMIPCfjI0="],
  ["existing binary base64", { file: "asset.bin", data: "AP+AQQ==", encoding: "base64" }, "AP+AQQ=="],
  ["empty UTF-8", { file: "empty.txt", data: "", encoding: "utf-8" }, ""],
]) test("inline deployment normalizes " + label + " without changing bytes", async () => {
  queue = [POST("/v13/deployments", { name: "site", files: [{ file: source.file, data: encoded, encoding: "base64" }] })];
  const r = await call("deploy_to_vercel", { name: "site", target: "preview", teamId: team, files: [source] });
  assert.equal(r.isError, false, r.content[0].text); assert.equal(queue.length, 0);
});
test("design import normalizes Unicode HTML to base64 before the API write", async () => {
  publicResponse = "<!doctype html><h1>世界 🌍</h1>";
  queue = [POST("/v13/deployments", { name: "design", files: [{ file: "index.html", data: "PCFkb2N0eXBlIGh0bWw+PGgxPuS4lueVjCDwn4yNPC9oMT4=", encoding: "base64" }] })];
  const r = await call("import-claude-design-from-url", { url: "https://claudeusercontent.com/design", name: "design", target: "preview", teamId: team });
  assert.equal(r.isError, false, r.content[0].text); assert.equal(queue.length, 0);
});

test("trace redacts credentials before truncation can expose their prefixes", async () => {
  queue = [{ ...GET("/api/observability/agent-runs", { message: token, access_token: "sensitive-other-token", tokenUsage: 12 }, { teamSlug: team, project: "site", environment: "production", from: "1789344000", to: "1789430400", runId: "run_test", trace: "1" }), origin: "https://vercel.com" }];
  const r = await call("get_agent_run_trace", { teamId: team, projectId: "site", runId: "run_test", from: "2026-09-14", to: "2026-09-15", maxFieldLength: 5 });
  assert.equal(r.isError, false); assert.ok(!r.content[0].text.includes("test-")); assert.ok(!r.content[0].text.includes("sensi"));
  assert.equal(JSON.parse(r.content[0].text).tokenUsage, 12);
});
test("file normalization preserves callers and safely handles maximum-size canonical base64", () => {
  const { checkFiles } = require("../lib/extended-tools");
  const bytes = Buffer.alloc(1048576, 0x61);
  const files = [{ file: "asset.bin", data: bytes.toString("base64"), encoding: "base64" }];
  const original = JSON.stringify(files);
  const prepared = checkFiles(files);
  assert.equal(JSON.stringify(files), original); assert.notEqual(prepared[0], files[0]);
  assert.deepEqual(Buffer.from(prepared[0].data, "base64"), bytes);
  assert.throws(() => checkFiles([{ file: "a", data: "AB==", encoding: "base64" }]), /canonical/);
});

for (const [name, args] of [
  ["get_domain_order", { orderId: "order", teamId: "my-team" }],
  ["check_domain_availability_and_price", { names: ["example.com"], teamId: "my-team" }],
]) test(name + " rejects unsupported registrar slug scope before requests", async () => {
  const r = await call(name, args);
  assert.equal(r.isError, true); assert.equal(calls.length, 0);
});
