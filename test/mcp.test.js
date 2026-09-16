"use strict";

/**
 * End-to-end protocol tests for the Vercel MCP server.
 * Starts the real HTTP server, mocks the Vercel REST API via fetch interception,
 * and drives the full MCP Streamable HTTP handshake exactly like Copilot Studio does.
 *
 * Run: node test/mcp.test.js
 */

process.env.VERCEL_MCP_ALLOW_WRITES = "true";
process.env.VERCEL_MCP_ALLOW_PRODUCTION = "true";
process.env.VERCEL_MCP_ENABLE_CLI_APIS = "true";
process.env.VERCEL_MCP_ALLOW_EXTERNAL_FETCH = "true";
delete process.env.VERCEL_MCP_TOOLS;
const assert = require("assert");
const http = require("http");

// ---- Mock the Vercel REST API before loading the server ----
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = typeof url === "string" ? new URL(url) : url;
  const auth = (opts.headers && opts.headers.Authorization) || "";
  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  if (u.hostname !== "api.vercel.com") return realFetch(url, opts);
  if (auth !== "Bearer test-token-123") {
    return json(403, { error: { code: "forbidden", message: "Not authorized" } });
  }
  if (u.pathname === "/v2/user") {
    return json(200, { user: { id: "usr_1", username: "liam", email: "liam@liamogrady.dev", name: "Liam" } });
  }
  if (u.pathname === "/v10/projects") {
    return json(200, {
      projects: [
        { id: "prj_1", name: "my-site", framework: "nextjs", createdAt: 1, updatedAt: 2,
          targets: { production: { alias: ["my-site.vercel.app"] } },
          link: { type: "github", repo: "my-site", org: "liam" } },
      ],
    });
  }
  if (u.pathname === "/v6/deployments") {
    return json(200, {
      deployments: [
        { uid: "dpl_1", name: "my-site", url: "my-site-abc.vercel.app", state: "READY",
          target: "production", createdAt: 3,
          meta: { githubCommitRef: "main", githubCommitMessage: "fix bug", githubCommitSha: "abc123" } },
      ],
    });
  }
  if (u.pathname === "/v3/deployments/dpl_1/events") {
    return json(200, [
      { type: "stdout", created: 10, payload: { text: "Installing dependencies..." } },
      { type: "stderr", created: 11, payload: { text: "Error: Module not found" } },
    ]);
  }
  if (u.pathname === "/v10/projects/my-site/env" && opts.method === "POST") {
    const body = JSON.parse(opts.body);
    return json(200, { created: { id: "env_1", target: body.target } });
  }
  return json(404, { error: { code: "not_found", message: `No mock for ${u.pathname}` } });
};

const { handleHttp } = require("../lib/mcp");
const PORT = 34567;

// Minimal HTTP client
function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

async function main() {
  // Start standalone server on test port
  process.env.PORT = String(PORT);
  const server = http.createServer(async (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const result = await handleHttp({ method: req.method, headers: req.headers, body });
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    });
  });
  await new Promise((r) => server.listen(PORT, r));

  const authHeaders = { "x-api-key": "test-token-123" };
  let passed = 0;
  const test = async (name, fn) => {
    await fn();
    passed++;
    console.log(`  \u2714 ${name}`);
  };

  console.log("MCP protocol tests:");

  await test("initialize handshake", async () => {
    const r = await post("/mcp", {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "copilot-studio", version: "1.0" } },
    }, authHeaders);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.result.protocolVersion, "2025-06-18");
    assert.strictEqual(r.body.result.serverInfo.name, "vercel-mcp");
    assert.ok(r.body.result.capabilities.tools);
  });

  await test("notifications/initialized returns 202", async () => {
    const r = await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, authHeaders);
    assert.strictEqual(r.status, 202);
  });

  await test("tools/list returns all tools with schemas", async () => {
    const r = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, authHeaders);
    assert.strictEqual(r.status, 200);
    const tools = r.body.result.tools;
    assert.ok(tools.length >= 12, `expected >=12 tools, got ${tools.length}`);
    for (const t of tools) {
      assert.ok(t.name && t.description && t.inputSchema, `tool ${t.name} missing fields`);
      assert.strictEqual(t.inputSchema.type, "object");
    }
  });

  await test("tools/call get_current_user", async () => {
    const r = await post("/mcp", {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "get_current_user", arguments: {} },
    }, authHeaders);
    assert.strictEqual(r.body.result.isError, false);
    const user = JSON.parse(r.body.result.content[0].text);
    assert.strictEqual(user.username, "liam");
  });

  await test("tools/call list_projects", async () => {
    const r = await post("/mcp", {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "list_projects", arguments: { limit: 5 } },
    }, authHeaders);
    const projects = JSON.parse(r.body.result.content[0].text);
    assert.strictEqual(projects[0].name, "my-site");
    assert.strictEqual(projects[0].latestProductionUrl, "my-site.vercel.app");
  });

  await test("tools/call list_deployments", async () => {
    const r = await post("/mcp", {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "list_deployments", arguments: { projectId: "prj_1" } },
    }, authHeaders);
    const deps = JSON.parse(r.body.result.content[0].text);
    assert.strictEqual(deps[0].uid, "dpl_1");
    assert.strictEqual(deps[0].state, "READY");
  });

  await test("tools/call get_deployment_build_logs", async () => {
    const r = await post("/mcp", {
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "get_deployment_build_logs", arguments: { deploymentIdOrUrl: "dpl_1" } },
    }, authHeaders);
    const logs = JSON.parse(r.body.result.content[0].text);
    assert.strictEqual(logs.length, 2);
    assert.ok(logs[1].text.includes("Module not found"));
  });

  await test("tools/call create_env_var (write path)", async () => {
    const r = await post("/mcp", {
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "create_env_var", arguments: { projectIdOrName: "my-site", key: "FOO", value: "bar" } },
    }, authHeaders);
    const out = JSON.parse(r.body.result.content[0].text);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.id, "env_1");
  });

  await test("Authorization: Bearer header also works", async () => {
    const r = await post("/mcp", {
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "get_current_user", arguments: {} },
    }, { Authorization: "Bearer test-token-123" });
    assert.strictEqual(r.body.result.isError, false);
  });

  await test("missing token returns friendly isError", async () => {
    const r = await post("/mcp", {
      jsonrpc: "2.0", id: 9, method: "tools/call",
      params: { name: "get_current_user", arguments: {} },
    });
    assert.strictEqual(r.body.result.isError, true);
    assert.ok(r.body.result.content[0].text.includes("no Vercel access token"));
  });

  await test("invalid token surfaces Vercel API error", async () => {
    const r = await post("/mcp", {
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "get_current_user", arguments: {} },
    }, { "x-api-key": "wrong" });
    assert.strictEqual(r.body.result.isError, true);
    assert.ok(r.body.result.content[0].text.includes("Not authorized"));
  });

  await test("unknown tool returns JSON-RPC error", async () => {
    const r = await post("/mcp", {
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "nope", arguments: {} },
    }, authHeaders);
    assert.strictEqual(r.body.error.code, -32602);
  });

  await test("unknown method returns -32601", async () => {
    const r = await post("/mcp", { jsonrpc: "2.0", id: 12, method: "bogus/method" }, authHeaders);
    assert.strictEqual(r.body.error.code, -32601);
  });

  await test("malformed JSON returns -32700", async () => {
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: PORT, path: "/mcp", method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => { let o = ""; res.on("data", (c) => (o += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(o) })); }
      );
      req.on("error", reject);
      req.end("{not json");
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error.code, -32700);
  });

  await test("GET returns 405 (stateless mode)", async () => {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: PORT, path: "/mcp" }, (res) => {
        let o = ""; res.on("data", (c) => (o += c)); res.on("end", () => resolve({ status: res.statusCode }));
      }).on("error", reject);
    });
    assert.strictEqual(r.status, 405);
  });

  await test("batch requests supported", async () => {
    const r = await post("/mcp", [
      { jsonrpc: "2.0", id: 20, method: "ping" },
      { jsonrpc: "2.0", id: 21, method: "tools/list" },
    ], authHeaders);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.length, 2);
  });

  await require("./tool-contracts")({ test, post, authHeaders });

  await new Promise((resolve) => server.close(resolve));
  // Keep the existing CI entry point: run every new suite, propagating failure.
  const extra = require("node:child_process").spawnSync(process.execPath, ["--test", "test/extended.test.js", "test/security.test.js", "test/smoke.test.js"], {
    cwd: require("node:path").resolve(__dirname, ".."), stdio: "inherit",
  });
  assert.strictEqual(extra.status, 0, "Extended/security test suites failed");
  console.log(`\nAll ${passed} legacy tests and the extended/security suites passed.`);
}

main().catch((e) => {
  console.error("TEST FAILURE:", e);
  process.exit(1);
});
