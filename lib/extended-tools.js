"use strict";

const { vercelFetch, dashboardFetch } = require("./vercel-api");
const { segment, range, timestamp } = require("./validation");
const str = (description, maxLength = 256) => ({ type: "string", minLength: 1, maxLength, description });
const integer = (minimum, maximum, description) => ({ type: "integer", minimum, maximum, description });
const enumeration = (values, description) => ({ type: "string", enum: values, description });
const teamId = str("Vercel team ID or slug; required when targeting a team.");
const projectId = str("Vercel project ID or name.");
const time = { anyOf: [str("ISO timestamp, relative duration (1h/1d), or now."), { type: "number", minimum: 0 }] };
const tools = [];
function add(name, description, properties, required, handler, options = {}) {
  tools.push({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: !options.write, destructiveHint: !!options.write,
      idempotentHint: !options.write, openWorldHint: !options.local },
    ...options, handler });
}
const scoped = (a) => ({ teamId: a.teamId });
const fields = (a, names) => Object.fromEntries(names.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
const target = enumeration(["preview", "production"], "Required deployment environment. Production needs operator opt-in.");
const settings = { type: "object", additionalProperties: false, properties: {
  framework: str("Framework identifier", 80), buildCommand: str("Build command executed by Vercel, not this server", 1024),
  installCommand: str("Install command executed by Vercel", 1024), outputDirectory: str("Output directory"), rootDirectory: str("Project root directory"),
} };
function deployed(d) {
  if (!d || typeof d.id !== "string" || typeof d.readyState !== "string") throw new Error("Unexpected deployment response; inspect project state before retrying");
  return { id: d.id, url: d.url, readyState: d.readyState, target: d.target, errorCode: d.errorCode, errorMessage: d.errorMessage,
    message: "Deployment requested, not verified live. Poll get_deployment until READY or ERROR, then verify the deployment URL." };
}
function checkFiles(files) {
  let total = 0;
  const seen = new Set();
  for (const f of files) {
    const parts = f.file.split("/");
    if (/[\\\x00-\x1f\x7f:]/.test(f.file) || parts.some((p) => !p || p === "." || p === ".." || [".git", "node_modules", ".vercel"].includes(p)) || parts.some((p) => /^\.env(?:\.|$)/.test(p)) || /\.(?:pem|key|p12|pfx)$/i.test(f.file)) throw new Error("Unsafe source path or credential file; send source files only");
    if (seen.has(f.file)) throw new Error("Duplicate source path");
    seen.add(f.file);
    if (f.encoding === "base64" && (f.data.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data))) throw new Error("Invalid base64 source file");
    const bytes = Buffer.from(f.data, f.encoding === "base64" ? "base64" : "utf8");
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:vcp|vca|vcr)_[A-Za-z0-9_-]{10,}/.test(bytes.toString("utf8"))) throw new Error("Potential credential in source; remove it before deploying");
    total += bytes.length;
  }
  if (total > 1024 * 1024) throw new Error("Source files exceed 1048576 decoded bytes; use Git deployment");
}
add("deploy_to_vercel", "Deploy inline source files to Vercel. Starts a build and can create a project. Requires operator-enabled writes. Returns pending state, not verified success.", {
  name: { ...str("Project name", 100), pattern: "^[a-z0-9][a-z0-9._-]*$" }, target, teamId, projectSettings: settings,
  files: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["file", "data"], properties: {
    file: str("Root-relative POSIX source path", 512), data: { type: "string", maxLength: 1400000 }, encoding: enumeration(["utf-8", "base64"], "Defaults to utf-8"),
  } } },
}, ["name", "target", "files"], async (token, a) => {
  checkFiles(a.files);
  return deployed(await vercelFetch(token, "POST", "/v13/deployments", scoped(a), {
    name: a.name, files: a.files, ...fields(a, ["projectSettings"]), ...(a.target === "production" ? { target: "production" } : {}),
  }));
}, { write: true });

add("deploy_from_git", "Build a GitHub branch/commit for an existing GitHub-linked Vercel project. Vercel must already have repository access. No source files or Git token in chat.", {
  projectId, teamId, ref: str("Branch or Git reference to deploy"), sha: { ...str("Optional exact commit SHA", 40), pattern: "^[a-fA-F0-9]{40}$" }, target,
}, ["projectId", "ref", "target"], async (token, a) => {
  const p = await vercelFetch(token, "GET", `/v10/projects/${segment(a.projectId)}`, scoped(a));
  if (!p.id || !p.name || p.link?.type !== "github" || !p.link.org || !p.link.repo) throw new Error("Project must already be linked to a GitHub repository");
  return deployed(await vercelFetch(token, "POST", "/v13/deployments", scoped(a), {
    name: p.name, project: p.id, gitSource: { type: "github", org: p.link.org, repo: p.link.repo, ref: a.ref, ...fields(a, ["sha"]) },
    ...(a.target === "production" ? { target: "production" } : {}),
  }));
}, { write: true });
add("redeploy_deployment", "Rebuild an existing deployment in its original project. Explicit target prevents inheriting production accidentally. Inspect returned deployment status before retrying.", {
  deploymentId: str("Deployment ID"), teamId, target, withLatestCommit: { type: "boolean", description: "Use the latest Git commit rather than original source; defaults to false." },
}, ["deploymentId", "target"], async (token, a) => {
  const d = await vercelFetch(token, "GET", `/v13/deployments/${segment(a.deploymentId)}`, scoped(a));
  if (!d.id || !d.name || !d.projectId) throw new Error("Deployment project could not be resolved");
  // The API inherits settings. Refuse a downgrade unless the source is already preview.
  if (a.target !== "production" && d.target != null && d.target !== "preview") throw new Error("Cannot safely redeploy a production deployment as preview using this contract; deploy_from_git instead");
  return deployed(await vercelFetch(token, "POST", "/v13/deployments", scoped(a), {
    deploymentId: d.id, name: d.name, project: d.projectId, withLatestCommit: a.withLatestCommit ?? false,
    ...(a.target === "production" ? { target: "production" } : {}),
  }));
}, { write: true });

add("get_web_analytics", "Query Vercel Web Analytics counts or aggregates. Requires enabled analytics and a plan supporting the requested reporting window. Returns upstream totals without approximation.", {
  projectId, teamId, dataset: enumeration(["visits", "events"], "Defaults to visits"), mode: enumeration(["count", "aggregate"], "Defaults to count"), since: time, until: time,
  by: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: str("Grouping dimension", 120) },
  filter: str("OData filter", 2048), limit: integer(1, 100, "Aggregate rows; default 10; remaining values in Others"),
}, ["projectId"], async (token, a) => {
  const mode = a.mode || "count";
  if ((a.since === undefined) !== (a.until === undefined)) throw new Error("since and until must be provided together");
  if (mode === "aggregate" && (!a.by || a.since === undefined)) throw new Error("aggregate requires by, since, and until");
  if (mode === "count" && (a.by || a.limit !== undefined)) throw new Error("by and limit apply only to aggregate mode");
  const query = { projectId: a.projectId, teamId: a.teamId, filter: a.filter };
  if (a.since !== undefined) {
    const from = timestamp(a.since), to = timestamp(a.until);
    if (from > to) throw new Error("since must not be after until");
    Object.assign(query, { since: from, until: to });
  }
  if (mode === "aggregate") Object.assign(query, { by: a.by, limit: a.limit ?? 10 });
  return vercelFetch(token, "GET", `/v1/query/web-analytics/${a.dataset || "visits"}/${mode}`, query);
});
add("check_domain_availability_and_price", "Check domain availability and quoted registration/renewal prices. Does not purchase or reserve anything. Up to 5 domains per call.", {
  names: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { ...str("ASCII/punycode domain", 253), pattern: "^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,63}$" } }, teamId,
  years: integer(1, 10, "Registration term; omitted uses TLD minimum"),
}, ["names"], async (token, a) => {
  return Promise.all(a.names.map(async (domain) => {
    const [availability, pricing] = await Promise.all([
      vercelFetch(token, "GET", `/v1/registrar/domains/${segment(domain.toLowerCase())}/availability`, scoped(a)),
      vercelFetch(token, "GET", `/v1/registrar/domains/${segment(domain.toLowerCase())}/price`, { ...scoped(a), years: a.years }),
    ]);
    return { domain, availability, pricing };
  }));
});
add("get_domain_order", "Read domain registration order status. A purchasing order is not yet completed. Does not buy anything.", {
  orderId: str("Domain order ID"), teamId,
}, ["orderId"], (token, a) => vercelFetch(token, "GET", `/v1/registrar/orders/${segment(a.orderId)}`, scoped(a)));

// These endpoints are used by Vercel's public CLI, not present in its stable
// OpenAPI contract. Explicit operator opt-in, provenance in docs/coverage.md.
const runProps = { teamId, projectId, environment: enumeration(["production", "preview"], "Defaults to production"),
  period: enumeration(["5m", "15m", "1h", "6h", "12h", "1d", "3d", "7d", "14d", "30d", "90d"], "Default 1d; ignored when from/to provided"), from: time, to: time };
function runQuery(a) {
  if ((a.from === undefined) !== (a.to === undefined)) throw new Error("from and to must be provided together");
  const window = range(a.from ?? a.period ?? "1d", a.to);
  return { teamSlug: a.teamId, project: a.projectId, environment: a.environment || "production", from: Math.floor(window.from / 1000), to: Math.floor(window.to / 1000) };
}
function trimTrace(value, limit) {
  if (typeof value === "string") return limit && value.length > limit ? value.slice(0, limit) + ` [truncated ${value.length - limit} characters]` : value;
  if (Array.isArray(value)) return value.map((v) => trimTrace(v, limit));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimTrace(v, limit)]));
  return value;
}
add("list_agent_run_projects", "List team projects with eve Agent Runs. CLI-backed API, requires operator opt-in. Default window 1d.",
  fields(runProps, ["teamId", "environment", "period", "from", "to"]), ["teamId"], (token, a) => dashboardFetch(token, "/api/observability/agent-runs", { ...runQuery(a), view: "team" }), { cliBacked: true });
add("list_agent_runs", "List eve Agent Runs with upstream pagination. CLI-backed API, requires operator opt-in.", {
  ...runProps, page: integer(1, 10000, "Page, default 1"), pageSize: integer(1, 100, "Runs per page, default 20"), search: str("Title search", 256),
}, ["teamId", "projectId"], (token, a) => dashboardFetch(token, "/api/observability/agent-runs", {
  ...runQuery(a), page: a.page ?? 1, pageSize: a.pageSize ?? 20, search: a.search,
}), { cliBacked: true });
add("get_agent_run", "Read one eve Agent Run. CLI-backed API, requires operator opt-in.", { ...runProps, runId: str("Agent Run ID") },
  ["teamId", "projectId", "runId"], (token, a) => dashboardFetch(token, "/api/observability/agent-runs", { ...runQuery(a), runId: a.runId }), { cliBacked: true });
add("get_agent_run_trace", "Read eve run traces. Sensitive conversation data may be returned. Strings capped at 8000 characters by default; 0 disables per-field truncation, not total response limits.", {
  ...runProps, runId: str("Agent Run ID"), maxFieldLength: integer(0, 50000, "Per-string cap, default 8000"),
}, ["teamId", "projectId", "runId"], async (token, a) => trimTrace(await dashboardFetch(token, "/api/observability/agent-runs", { ...runQuery(a), runId: a.runId, trace: 1 }), a.maxFieldLength ?? 8000), { cliBacked: true });

add("get_runtime_logs", "Read a bounded page of runtime request logs using Vercel's CLI-backed API. Returns continuation and truncation metadata, not an exhaustive inventory. Operator opt-in required.", {
  projectId, teamId, deploymentId: str("Optional deployment ID"), environment: enumeration(["production", "preview"], "Environment"),
  level: { type: "array", minItems: 1, maxItems: 4, items: enumeration(["error", "warning", "info", "fatal"], "Level") },
  source: { type: "array", minItems: 1, maxItems: 4, items: enumeration(["serverless", "edge-function", "edge-middleware", "static"], "Source") },
  statusCode: { ...str("HTTP status or class", 3), pattern: "^[1-5](?:[0-9]{2}|xx)$" }, since: time, until: time,
  limit: integer(1, 1000, "Maximum returned rows, default 50"), page: integer(0, 10000, "Upstream page, default 0"), query: str("Full-text query", 1024), requestId: str("Request ID"),
}, ["projectId", "teamId"], async (token, a) => {
  const window = range(a.since, a.until);
  const p = await vercelFetch(token, "GET", `/v10/projects/${segment(a.projectId)}`, scoped(a));
  if (!p.id || !p.accountId) throw new Error("Could not resolve project owner for logs");
  const data = await dashboardFetch(token, "/api/logs/request-logs", {
    projectId: p.id, ownerId: p.accountId, page: a.page ?? 0, startDate: window.from, endDate: window.to,
    ...fields(a, ["deploymentId", "environment", "statusCode", "requestId"]),
    level: a.level?.join(","), source: a.source?.join(","), search: a.query,
  });
  if (!Array.isArray(data.rows)) throw new Error("Unexpected runtime logs response");
  const limit = a.limit ?? 50;
  return { rows: data.rows.slice(0, limit), pagination: { page: a.page ?? 0, hasMore: !!data.hasMoreRows,
    nextPage: data.hasMoreRows ? (a.page ?? 0) + 1 : null }, truncated: data.rows.length > limit,
    message: data.rows.length > limit ? "Increase limit and repeat this page to see omitted rows before advancing." : undefined };
}, { cliBacked: true });

add("list_toolbar_threads", "List Toolbar comment threads; unresolved by default. CLI-backed API uses cursor pagination, not offset.", {
  teamId, projectId, branch: str("Branch"), status: enumeration(["resolved", "unresolved"], "Default unresolved"), page: str("Page path or glob"), search: str("Comment search", 1024),
  limit: integer(1, 100, "Default 20"), cursor: str("Continuation cursor", 2048),
}, ["teamId"], (token, a) => vercelFetch(token, "GET", "/toolbar/threads", { ...fields(a, ["teamId", "projectId", "branch", "page", "search", "cursor"]), status: a.status ?? "unresolved", limit: a.limit ?? 20 }), { cliBacked: true });
add("get_toolbar_thread", "Read a Toolbar thread and one page of messages. Follow nextCursor with messageCursor; does not silently drop pagination.", {
  teamId, threadId: str("Thread ID"), messageCursor: str("Message cursor", 2048), limit: integer(1, 100, "Messages per page; default 100"),
}, ["teamId", "threadId"], async (token, a) => {
  const path = `/toolbar/threads/${segment(a.threadId)}`;
  const thread = await vercelFetch(token, "GET", path, scoped(a));
  const messages = await vercelFetch(token, "GET", path + "/messages", { ...scoped(a), cursor: a.messageCursor, limit: a.limit ?? 100 });
  return { thread, messages: messages.messages, pagination: messages.pagination };
}, { cliBacked: true });
add("change_toolbar_thread_resolve_status", "Resolve or reopen a Toolbar thread. Requires writes and CLI-backed API opt-in.", {
  teamId, threadId: str("Thread ID"), resolved: { type: "boolean" },
}, ["teamId", "threadId", "resolved"], (token, a) => vercelFetch(token, "PATCH", `/toolbar/threads/${segment(a.threadId)}`, scoped(a), { resolved: a.resolved }), { write: true, cliBacked: true });
add("reply_to_toolbar_thread", "Post a reply to a Toolbar thread. No automatic retries: a repeated request can duplicate a message.", {
  teamId, threadId: str("Thread ID"), markdown: str("Reply Markdown", 10000),
}, ["teamId", "threadId", "markdown"], (token, a) => vercelFetch(token, "POST", `/toolbar/threads/${segment(a.threadId)}/messages`, scoped(a), { markdown: a.markdown }), { write: true, cliBacked: true });
add("edit_toolbar_message", "Edit a Toolbar message. Vercel enforces ownership. Requires writes and CLI-backed API opt-in.", {
  teamId, threadId: str("Thread ID"), messageId: str("Message ID"), markdown: str("Updated Markdown", 10000),
}, ["teamId", "threadId", "messageId", "markdown"], (token, a) => vercelFetch(token, "PATCH", `/toolbar/threads/${segment(a.threadId)}/messages/${segment(a.messageId)}`, scoped(a), { markdown: a.markdown }), { write: true, cliBacked: true });

add("use_vercel_cli", "Return Vercel CLI help guidance only. This server never runs shell commands or accesses the user's local filesystem.", {
  action: str("Desired task", 1000), command: { ...str("Optional single CLI subcommand", 40), pattern: "^[a-z][a-z-]*$" },
}, ["action"], async (_token, a) => ({ executed: false, helpCommand: `vercel${a.command ? " " + a.command : ""} --help`,
  documentation: "https://vercel.com/docs/cli", message: "Run help in your own trusted terminal. This MCP tool does not execute commands, deploy, or obtain local source files." }), { local: true });

module.exports = { tools, add, str, integer, enumeration, checkFiles, deployed };
