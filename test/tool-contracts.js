"use strict";

const assert = require("assert");

// Independent expectations: adding a tool requires adding its behavior here.
const EXPECTED_ANNOTATIONS = {
  get_current_user: [true, false, true, true],
  list_teams: [true, false, true, true],
  list_projects: [true, false, true, true],
  get_project: [true, false, true, true],
  list_deployments: [true, false, true, true],
  get_deployment: [true, false, true, true],
  get_deployment_build_logs: [true, false, true, true],
  cancel_deployment: [false, true, true, true],
  promote_deployment: [false, true, false, true],
  list_project_domains: [true, false, true, true],
  list_env_vars: [true, false, true, true],
  create_env_var: [false, true, false, true],
  delete_env_var: [false, true, true, true],
};
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

// Literal expected URLs catch encoding regressions; do not compute them using
// the implementation's URL-building code. All IDs and values are test fixtures.
const CASES = [
  {
    name: "get_current_user", args: {}, method: "GET", path: "/v2/user", query: {},
    response: { user: { uid: "usr_test", username: "tester", email: "test@example.com", name: "Test", billing: "omit" } },
    expected: { id: "usr_test", username: "tester", email: "test@example.com", name: "Test" },
  },
  {
    name: "list_teams", args: {}, method: "GET", path: "/v2/teams", query: { limit: "100" },
    response: { teams: [{ id: "team_test", slug: "test-team", name: "Test Team", billing: "omit" }] },
    expected: [{ id: "team_test", slug: "test-team", name: "Test Team" }],
  },
  {
    name: "list_projects", args: { teamId: "team_test", search: "site & docs", limit: 2 },
    method: "GET", path: "/v10/projects", query: { teamId: "team_test", search: "site & docs", limit: "2" },
    response: { projects: [{ id: "prj_test", name: "site", targets: { production: { alias: ["site.example.com"] } }, internal: "omit" }] },
    expected: [{ id: "prj_test", name: "site", latestProductionUrl: "site.example.com" }],
  },
  {
    name: "get_project", args: { projectIdOrName: "site/name ?", teamId: "team_test" },
    method: "GET", path: "/v10/projects/site%2Fname%20%3F", query: { teamId: "team_test" },
    response: { id: "prj_test", name: "site", framework: "nextjs", nodeVersion: "22.x", createdAt: 1, updatedAt: 2,
      targets: { production: { alias: ["site.example.com", "other.example.com"] } },
      link: { type: "github", repo: "site", org: "test", internal: "omit" } },
    expected: { id: "prj_test", name: "site", framework: "nextjs", nodeVersion: "22.x", createdAt: 1, updatedAt: 2,
      latestProductionUrl: "site.example.com", link: { type: "github", repo: "site", org: "test" } },
  },
  {
    name: "list_deployments", args: { projectId: "prj_test", state: "READY,ERROR", target: "preview", limit: 2, teamId: "team_test" },
    method: "GET", path: "/v6/deployments",
    query: { projectId: "prj_test", state: "READY,ERROR", target: "preview", limit: "2", teamId: "team_test" },
    response: { deployments: [{ uid: "dpl_test", state: "READY", created: 3, internal: "omit" }] },
    expected: [{ uid: "dpl_test", state: "READY", createdAt: 3 }],
  },
  {
    name: "get_deployment", args: { idOrUrl: "site.example.com/a?b", teamId: "team_test" },
    method: "GET", path: "/v13/deployments/site.example.com%2Fa%3Fb", query: { teamId: "team_test" },
    response: { id: "dpl_test", readyState: "ERROR", created: 3, alias: ["site.example.com"],
      errorMessage: "Build failed", errorCode: "BUILD_ERROR", builds: [{ src: "index.js", use: "@vercel/node", internal: "omit" }] },
    expected: { uid: "dpl_test", state: "ERROR", createdAt: 3, alias: ["site.example.com"],
      errorMessage: "Build failed", errorCode: "BUILD_ERROR", build: [{ src: "index.js", use: "@vercel/node" }] },
  },
  {
    name: "get_deployment_build_logs", args: { deploymentIdOrUrl: "dpl/test", teamId: "team_test", limit: 1 },
    method: "GET", path: "/v3/deployments/dpl%2Ftest/events", query: { teamId: "team_test", builds: "1", follow: "0", limit: "1000", direction: "backward" },
    response: { events: [{ type: "stdout", created: 1, payload: { text: "First line" } },
      { type: "status" }, { type: "stderr", payload: { date: 2, info: { message: "Last line" } } }] },
    expected: [{ type: "stderr", created: 2, text: '{"message":"Last line"}' }],
  },
  {
    name: "cancel_deployment", args: { deploymentId: "dpl/test", teamId: "team_test" },
    method: "PATCH", path: "/v12/deployments/dpl%2Ftest/cancel", query: { teamId: "team_test" },
    response: { id: "dpl_test", readyState: "CANCELED", internal: "omit" },
    expected: { uid: "dpl_test", state: "CANCELED" },
  },
  {
    name: "promote_deployment", args: { projectId: "prj/test", deploymentId: "dpl/test", teamId: "team_test" },
    method: "POST", path: "/v10/projects/prj%2Ftest/promote/dpl%2Ftest", query: { teamId: "team_test" },
    status: 204,
    expected: { ok: true, message: "Deployment dpl/test promotion requested." },
  },
  {
    name: "list_project_domains", args: { projectIdOrName: "site/name", teamId: "team_test" },
    method: "GET", path: "/v9/projects/site%2Fname/domains", query: { teamId: "team_test" },
    response: { domains: [{ name: "site.example.com", apexName: "example.com", projectId: "prj_test",
      redirect: null, verified: false, createdAt: 4, verification: [{ type: "omit" }] }] },
    expected: [{ name: "site.example.com", apexName: "example.com", projectId: "prj_test", redirect: null, verified: false, createdAt: 4 }],
  },
  {
    name: "list_env_vars", args: { projectIdOrName: "site/name", teamId: "team_test" },
    method: "GET", path: "/v10/projects/site%2Fname/env", query: { teamId: "team_test" },
    response: { envs: [
      { id: "env_a", key: "ENCRYPTED", type: "encrypted", value: "dummy-encrypted-value", target: ["production"] },
      { id: "env_b", key: "SENSITIVE", type: "sensitive", value: "dummy-sensitive-value", target: ["preview"] },
      { id: "env_c", key: "PLAIN", type: "plain", value: "public", target: ["development"] },
    ] },
    expected: [
      { id: "env_a", key: "ENCRYPTED", type: "encrypted", value: "[hidden]", target: ["production"] },
      { id: "env_b", key: "SENSITIVE", type: "sensitive", value: "[hidden]", target: ["preview"] },
      { id: "env_c", key: "PLAIN", type: "plain", value: "public", target: ["development"] },
    ],
  },
  {
    name: "create_env_var", args: { projectIdOrName: "site/name", key: "EXAMPLE", value: "dummy-value", teamId: "team_test" },
    method: "POST", path: "/v10/projects/site%2Fname/env", query: { teamId: "team_test", upsert: "true" },
    body: { key: "EXAMPLE", value: "dummy-value", target: ["production", "preview", "development"], type: "encrypted" },
    response: { created: { id: "env_test", target: ["production", "preview", "development"], value: "dummy-value" } },
    expected: { ok: true, key: "EXAMPLE", id: "env_test", target: ["production", "preview", "development"] },
  },
  {
    name: "delete_env_var", args: { projectIdOrName: "site/name", envVarId: "env/test", teamId: "team_test" },
    method: "DELETE", path: "/v10/projects/site%2Fname/env/env%2Ftest", query: { teamId: "team_test" },
    status: 204,
    expected: { ok: true, message: "Environment variable env/test deleted." },
  },
];

module.exports = async function runToolContracts({ test, post, authHeaders }) {
  await test("tools/list publishes all four boolean hints for every tool", async () => {
    const r = await post("/mcp", { jsonrpc: "2.0", id: 30, method: "tools/list" }, authHeaders);
    assert.strictEqual(r.status, 200);
    const tools = r.body.result.tools.filter((t) => Object.hasOwn(EXPECTED_ANNOTATIONS, t.name));
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), Object.keys(EXPECTED_ANNOTATIONS).sort());
    assert.deepStrictEqual(CASES.map((c) => c.name).sort(), tools.map((t) => t.name).sort());
    for (const t of tools) {
      assert.ok(t.annotations, `${t.name}: missing annotations in tools/list`);
      assert.deepStrictEqual(Object.keys(t.annotations).sort(), [...HINTS].sort());
      for (const hint of HINTS) assert.strictEqual(typeof t.annotations[hint], "boolean", `${t.name}.${hint}`);
      assert.deepStrictEqual(HINTS.map((hint) => t.annotations[hint]), EXPECTED_ANNOTATIONS[t.name], t.name);
    }
  });

  // Intercept every fetch for this suite: no network access, no real credentials.
  // The HTTP client uses node:http, not fetch, to reach the test server.
  const previousFetch = global.fetch;
  let activeCase;
  let failure;
  let requests;
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    requests.push({ origin: u.origin, path: u.pathname, query: Object.fromEntries(u.searchParams),
      method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (failure) return new Response(JSON.stringify({ error: { code: "forbidden", message: "Not authorized" } }), { status: 403 });
    return new Response(activeCase.status === 204 ? null : JSON.stringify(activeCase.response), { status: activeCase.status || 200 });
  };

  async function call(c, fail = false) {
    activeCase = c;
    failure = fail;
    requests = [];
    const r = await post("/mcp", { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: c.name, arguments: c.args } }, authHeaders);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.id, 31);
    assert.strictEqual(r.body.jsonrpc, "2.0");
    assert.strictEqual(r.body.error, undefined);
    assert.strictEqual(requests.length, 1, `${c.name}: must issue exactly one API request`);
    const request = requests[0];
    assert.strictEqual(request.origin, "https://api.vercel.com");
    assert.strictEqual(request.method, c.method);
    assert.strictEqual(request.path, c.path);
    assert.deepStrictEqual(request.query, c.query);
    assert.deepStrictEqual(request.body, c.body);
    assert.deepStrictEqual(request.headers, { Authorization: "Bearer test-token-123", "Content-Type": "application/json" });
    const result = r.body.result;
    assert.strictEqual(result.isError, fail, c.name);
    assert.strictEqual(result.content.length, 1);
    assert.strictEqual(result.content[0].type, "text");
    return result;
  }

  try {
    for (const c of CASES) {
      await test(`tools/call ${c.name} request and response contract`, async () => {
        const result = await call(c);
        assert.deepStrictEqual(JSON.parse(result.content[0].text), c.expected);
        // The advertised read-only classification must match the actual method.
        assert.strictEqual(EXPECTED_ANNOTATIONS[c.name][0], requests[0].method === "GET");
      });
      await test(`tools/call ${c.name} surfaces an upstream rejection`, async () => {
        const result = await call(c, true);
        assert.strictEqual(result.content[0].text, "Vercel API error: Not authorized (HTTP 403)");
      });
    }

    await test("create_env_var preserves explicit preview-only target and type", async () => {
      const base = CASES.find((c) => c.name === "create_env_var");
      const c = { ...base, args: { ...base.args, target: ["preview"], type: "plain" },
        body: { ...base.body, target: ["preview"], type: "plain" },
        response: { id: "env_test", target: ["preview"] },
        expected: { ok: true, key: "EXAMPLE", id: "env_test", target: ["preview"] } };
      assert.deepStrictEqual(JSON.parse((await call(c)).content[0].text), c.expected);
    });

    for (const [name, limit] of [["list_projects", "20"], ["list_deployments", "10"]]) {
      await test(`${name} omits absent filters and uses its default limit`, async () => {
        const base = CASES.find((c) => c.name === name);
        const c = { ...base, args: {}, query: { limit } };
        assert.deepStrictEqual(JSON.parse((await call(c)).content[0].text), c.expected);
      });
    }
  } finally {
    global.fetch = previousFetch;
  }
};
