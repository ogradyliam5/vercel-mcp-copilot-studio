"use strict";

const { vercelFetch } = require("./vercel-api");
const { segment, timestamp } = require("./validation");

/**
 * Tool registry for the Vercel MCP server.
 * Each tool: { name, description, annotations, inputSchema, handler(token, args) }
 * Handlers return plain JS values which are serialized to JSON text content.
 */

// ---------- helpers to trim Vercel's verbose payloads ----------

function slimProject(p) {
  return {
    id: p.id,
    name: p.name,
    framework: p.framework,
    nodeVersion: p.nodeVersion,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    latestProductionUrl:
      p.targets && p.targets.production && p.targets.production.alias
        ? p.targets.production.alias[0]
        : undefined,
    link: p.link ? { type: p.link.type, repo: p.link.repo, org: p.link.org } : undefined,
  };
}

function slimDeployment(d) {
  return {
    uid: d.uid || d.id,
    name: d.name,
    url: d.url,
    state: d.state || d.readyState,
    target: d.target,
    createdAt: d.createdAt || d.created,
    ready: d.ready,
    source: d.source,
    creator: d.creator ? { username: d.creator.username, email: d.creator.email } : undefined,
    meta: d.meta
      ? {
          githubCommitRef: d.meta.githubCommitRef,
          githubCommitMessage: d.meta.githubCommitMessage,
          githubCommitSha: d.meta.githubCommitSha,
        }
      : undefined,
    inspectorUrl: d.inspectorUrl,
  };
}

function slimDomain(d) {
  return {
    name: d.name,
    apexName: d.apexName,
    projectId: d.projectId,
    redirect: d.redirect,
    verified: d.verified,
    createdAt: d.createdAt,
  };
}

function slimEnv(e) {
  return {
    id: e.id,
    key: e.key,
    target: e.target,
    type: e.type,
    // Never expose secret values; only plain/system values are returned by the API anyway.
    value: e.type === "encrypted" || e.type === "sensitive" ? "[hidden]" : e.value,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

const teamIdProp = {
  teamId: {
    type: "string",
    description:
      "Optional Vercel team ID (starts with 'team_'). Provide when the resource belongs to a team rather than your personal account.",
  },
};

// ---------- tool definitions ----------

// Advisory MCP hints, not approval or authorization controls. All tools contact
// the external Vercel API, so openWorldHint is true even for read-only tools.

const TOOLS = [
  {
    name: "get_current_user",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Get the authenticated Vercel user's profile (username, email, account id). Not a health check for project-scoped tokens.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (token) => {
      const data = await vercelFetch(token, "GET", "/v2/user");
      const u = data.user || data;
      return { id: u.id || u.uid, username: u.username, email: u.email, name: u.name };
    },
  },
  {
    name: "list_teams",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: "List Vercel teams the authenticated user belongs to. Returns team ids and names.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, until: { type: "integer", minimum: 0 }, includePagination: { type: "boolean" } }, additionalProperties: false },
    handler: async (token, a = {}) => {
      const data = await vercelFetch(token, "GET", "/v2/teams", { limit: a.limit ?? 100, until: a.until });
      const teams = (data.teams || []).map((t) => ({ id: t.id, slug: t.slug, name: t.name }));
      return a.includePagination ? { teams, pagination: data.pagination } : teams;
    },
  },
  {
    name: "list_projects",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "List Vercel projects. Returns project id, name, framework, and latest production URL. Optionally filter by team or search by name.",
    inputSchema: {
      type: "object",
      properties: {
        ...teamIdProp,
        from: { type: "string", minLength: 1, maxLength: 2048, description: "Continuation token or timestamp from the previous result" },
        includePagination: { type: "boolean", description: "Return pagination alongside results" },
        search: { type: "string", description: "Search projects by name." },
        limit: { type: "number", description: "Max projects to return (default 20)." },
      },
      additionalProperties: false,
    },
    handler: async (token, a = {}) => {
      const data = await vercelFetch(token, "GET", "/v10/projects", {
        teamId: a.teamId,
        from: a.from,
        search: a.search,
        limit: a.limit || 20,
      });
      const projects = (data.projects || []).map(slimProject);
      return a.includePagination ? { projects, pagination: data.pagination } : projects;
    },
  },
  {
    name: "get_project",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Get details of a single Vercel project by its name or id, including framework, git repository link, and production alias.",
    inputSchema: {
      type: "object",
      properties: {
        projectIdOrName: { type: "string", description: "The project id or project name." },
        ...teamIdProp,
        projectId: { type: "string", minLength: 1, maxLength: 256, description: "Alias for projectIdOrName" },
      },
      required: [],
      anyOf: [{ type: "object", required: ["projectIdOrName"] }, { type: "object", required: ["projectId"] }],
      additionalProperties: false,
    },
    handler: async (token, a) => {
      if (a.projectId && a.projectIdOrName && a.projectId !== a.projectIdOrName) throw new Error("Conflicting project identifiers");
      const p = await vercelFetch(
        token,
        "GET",
        `/v10/projects/${segment(a.projectIdOrName || a.projectId)}`,
        { teamId: a.teamId }
      );
      return slimProject(p);
    },
  },
  {
    name: "list_deployments",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "List recent deployments, optionally filtered by project, state (BUILDING, ERROR, READY, CANCELED, QUEUED) or target (production/preview). Returns deployment id, URL, state and git commit info.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Filter by project id or name." },
        state: {
          type: "string",
          description: "Comma-separated deployment states to filter by, e.g. 'ERROR' or 'READY,BUILDING'.",
        },
        target: { type: "string", description: "'production' or 'preview'." },
        limit: { type: "number", description: "Max deployments to return (default 10)." },
        ...teamIdProp,
        until: { type: "integer", minimum: 0, description: "Pagination timestamp from the previous result" },
        includePagination: { type: "boolean", description: "Return pagination alongside results" },
      },
      additionalProperties: false,
    },
    handler: async (token, a = {}) => {
      const data = await vercelFetch(token, "GET", "/v6/deployments", {
        projectId: a.projectId,
        state: a.state,
        target: a.target,
        limit: a.limit || 10,
        teamId: a.teamId,
        until: a.until,
      });
      const deployments = (data.deployments || []).map(slimDeployment);
      return a.includePagination ? { deployments, pagination: data.pagination } : deployments;
    },
  },
  {
    name: "get_deployment",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Get details of a single deployment by its id (uid) or URL, including state, target, aliases and error info if the build failed.",
    inputSchema: {
      type: "object",
      properties: {
        idOrUrl: { type: "string", description: "Deployment id (dpl_...) or deployment URL." },
        ...teamIdProp,
      },
      required: ["idOrUrl"],
      additionalProperties: false,
    },
    handler: async (token, a) => {
      const d = await vercelFetch(
        token,
        "GET",
        `/v13/deployments/${segment(a.idOrUrl)}`,
        { teamId: a.teamId }
      );
      return {
        ...slimDeployment(d),
        alias: d.alias,
        errorMessage: d.errorMessage,
        errorCode: d.errorCode,
        build: d.builds ? d.builds.map((b) => ({ src: b.src, use: b.use })) : undefined,
      };
    },
  },
  {
    name: "get_deployment_build_logs",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Get the build log output (events) for a deployment. Ideal for diagnosing failed builds. Returns the last N log lines.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentIdOrUrl: { type: "string", description: "Deployment id (dpl_...) or URL." },
        limit: { type: "number", description: "Max log lines to return from the end (default 100)." },
        ...teamIdProp,
      },
      required: ["deploymentIdOrUrl"],
      additionalProperties: false,
    },
    handler: async (token, a) => {
      const id = a.idOrUrl || a.deploymentIdOrUrl;
      if (!id || (a.idOrUrl && a.deploymentIdOrUrl && a.idOrUrl !== a.deploymentIdOrUrl)) throw new Error("Provide one unambiguous deployment identifier");
      const since = a.since === undefined ? undefined : timestamp(a.since);
      const until = a.until === undefined ? undefined : timestamp(a.until);
      if (since !== undefined && until !== undefined && since > until) throw new Error("since must not be after until");
      const data = await vercelFetch(token, "GET", `/v3/deployments/${segment(id)}/events`, {
        teamId: a.teamId, builds: 1, follow: 0, limit: 1000,
        direction: a.direction === "head" ? "forward" : "backward", since, until, name: a.buildId,
      });
      const events = Array.isArray(data) ? data : data.events || [];
      const lines = events.filter((e) => e.payload && (e.payload.text || e.payload.info))
        .map((e) => ({ type: e.type, created: e.created || e.payload.date, text: e.payload.text || JSON.stringify(e.payload.info) }))
        .sort((a, b) => (a.created || 0) - (b.created || 0))
        .filter((e) => !a.errorsOnly || /error|stderr|exit|fatal/i.test(e.type || ""));
      const limit = a.limit || 100;
      const result = a.direction === "head" ? lines.slice(0, limit) : lines.slice(-limit);
      return a.includePagination ? { lines: result, possiblyMore: events.length >= 1000, scannedEvents: events.length } : result;
    },
  },
  {
    name: "cancel_deployment",
    // The same deployment cannot be canceled again (the API rejects a retry).
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: "Cancel a deployment that is currently building or queued.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string", description: "Deployment id (dpl_...)." },
        ...teamIdProp,
      },
      required: ["deploymentId"],
      additionalProperties: false,
    },
    handler: async (token, a) => {
      const d = await vercelFetch(
        token,
        "PATCH",
        `/v12/deployments/${segment(a.deploymentId)}/cancel`,
        { teamId: a.teamId }
      );
      return slimDeployment(d);
    },
  },
  {
    name: "promote_deployment",
    // Repeated promotion requests are not guaranteed free of additional effects.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "Promote an existing (READY) deployment to production for its project. Use this to roll forward or roll back production to a known-good deployment.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id the deployment belongs to." },
        deploymentId: { type: "string", description: "Deployment id (dpl_...) to promote." },
        ...teamIdProp,
      },
      required: ["projectId", "deploymentId"],
      additionalProperties: false,
    },
    handler: async (token, a) => {
      await vercelFetch(
        token,
        "POST",
        `/v10/projects/${segment(a.projectId)}/promote/${segment(a.deploymentId)}`,
        { teamId: a.teamId }
      );
      return { ok: true, message: `Deployment ${a.deploymentId} promotion requested.` };
    },
  },
  {
    name: "list_project_domains",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: "List the custom domains attached to a Vercel project, including verification status.",
    inputSchema: {
      type: "object",
      properties: {
        projectIdOrName: { type: "string", description: "The project id or name." },
        ...teamIdProp,
      },
      required: ["projectIdOrName"],
      additionalProperties: false,
    },
    handler: async (token, a) => {
      const data = await vercelFetch(
        token,
        "GET",
        `/v9/projects/${segment(a.projectIdOrName)}/domains`,
        { teamId: a.teamId }
      );
      return (data.domains || []).map(slimDomain);
    },
  },
  {
    name: "list_env_vars",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "List environment variables for a project (keys, targets and types; secret values are hidden).",
    inputSchema: {
      type: "object",
      properties: {
        projectIdOrName: { type: "string", description: "The project id or name." },
        ...teamIdProp,
      },
      required: ["projectIdOrName"],
      additionalProperties: false,
    },
    handler: async (token, a) => {
      const data = await vercelFetch(
        token,
        "GET",
        `/v10/projects/${segment(a.projectIdOrName)}/env`,
        { teamId: a.teamId }
      );
      return (data.envs || []).map(slimEnv);
    },
  },
  {
    name: "create_env_var",
    // Upsert can overwrite a value; it does not guarantee side-effect-free retries.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "Create (or upsert) an environment variable on a project for the given targets (production, preview, development).",
    inputSchema: {
      type: "object",
      properties: {
        projectIdOrName: { type: "string", description: "The project id or name." },
        key: { type: "string", description: "Environment variable name, e.g. API_BASE_URL." },
        value: { type: "string", description: "Environment variable value." },
        target: {
          type: "array",
          items: { type: "string", enum: ["production", "preview", "development"] },
          description: "Deployment targets. Defaults to all three.",
        },
        type: {
          type: "string",
          enum: ["plain", "encrypted", "sensitive"],
          description: "Variable type. Defaults to 'encrypted'.",
        },
        ...teamIdProp,
      },
      required: ["projectIdOrName", "key", "value"],
      additionalProperties: false,
    },
    handler: async (token, a) => {
      const data = await vercelFetch(
        token,
        "POST",
        `/v10/projects/${segment(a.projectIdOrName)}/env`,
        { teamId: a.teamId, upsert: "true" },
        {
          key: a.key,
          value: a.value,
          target: a.target && a.target.length ? a.target : ["production", "preview", "development"],
          type: a.type || "encrypted",
        }
      );
      const created = data.created || data;
      return { ok: true, key: a.key, id: created.id, target: created.target };
    },
  },
  {
    name: "delete_env_var",
    // Repeating a delete of the same ID cannot delete another variable.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: "Delete an environment variable from a project by its env var id (get ids from list_env_vars).",
    inputSchema: {
      type: "object",
      properties: {
        projectIdOrName: { type: "string", description: "The project id or name." },
        envVarId: { type: "string", description: "The environment variable id." },
        ...teamIdProp,
      },
      required: ["projectIdOrName", "envVarId"],
      additionalProperties: false,
    },
    handler: async (token, a) => {
      await vercelFetch(
        token,
        "DELETE",
        `/v10/projects/${segment(a.projectIdOrName)}/env/${segment(a.envVarId)}`,
        { teamId: a.teamId }
      );
      return { ok: true, message: `Environment variable ${a.envVarId} deleted.` };
    },
  },
];

// Tighten legacy inputs without changing existing names or default result shapes.
for (const tool of TOOLS) {
  for (const [key, property] of Object.entries(tool.inputSchema.properties || {})) {
    if (property.type === "string") Object.assign(property, { minLength: key === "value" ? 0 : 1, maxLength: key === "value" ? 16384 : 2048 });
    if (key === "limit") Object.assign(property, { type: "integer", minimum: 1, maximum: tool.name === "get_deployment_build_logs" ? 1000 : 100 });
  }
}
const logs = TOOLS.find((t) => t.name === "get_deployment_build_logs");
Object.assign(logs.inputSchema.properties, {
  idOrUrl: { type: "string", minLength: 1, maxLength: 2048, description: "Alias for deploymentIdOrUrl" },
  direction: { type: "string", enum: ["head", "tail"], description: "Default tail; at most 1000 upstream events scanned" },
  errorsOnly: { type: "boolean" }, since: { type: "string", maxLength: 100 }, until: { type: "string", maxLength: 100 },
  buildId: { type: "string", minLength: 1, maxLength: 256 }, includePagination: { type: "boolean", description: "Return scan metadata alongside lines" },
});
logs.inputSchema.required = [];
logs.inputSchema.anyOf = [{ required: ["idOrUrl"], type: "object" }, { required: ["deploymentIdOrUrl"], type: "object" }];
require("./web-tools");
TOOLS.push(...require("./extended-tools").tools);
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

module.exports = { TOOLS, TOOL_MAP };
