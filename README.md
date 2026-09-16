# Vercel MCP Server for Microsoft Copilot Studio

Let your Copilot Studio agent inspect Vercel, deploy source files or GitHub code, query analytics, and use the optional tools listed below. Writes require explicit operator enablement. This is an independent, **zero-dependency** Node.js server, not Vercel's official MCP server.

**Version 2 safety change:** writes are disabled by default and the server-owned token fallback is removed. Read the [migration and rollout guide](docs/production.md) before upgrading. **33 implemented tools is not full official parity**: [24 official names have implementations with limits; 8 remain blocked](docs/coverage.md).

**In short:** deploy this repository to Vercel, create a Vercel access token, and add your deployed `/mcp` URL to Copilot Studio using **API key → Header → `x-api-key`**. Paste the **raw token** into the connection's API key field.

- [Why this server exists](#why-this-server-exists)
- [What it can and cannot do](#what-it-can-and-cannot-do)
- [Set up in Copilot Studio](#set-up-in-copilot-studio)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [For developers and self-hosters](#for-developers-and-self-hosters)

## Why this server exists

**MCP (Model Context Protocol)** lets an agent discover and call named tools. For an MCP connection, Copilot Studio needs a running server that presents those tools. Vercel's REST API is a different interface. An API key grants access, but does not translate between those interfaces. This server does the translation.

There are three parts:

| Part | What it does |
|---|---|
| Copilot Studio | Runs your agent and keeps the Vercel token in its connection. |
| This MCP server | Runs at your deployed URL and translates tool calls into Vercel API requests. |
| Vercel REST API | Checks the token's permissions and reads or changes your Vercel resources. |

The two requests use **different authentication headers**:

```text
Copilot Studio
    |
    | POST https://<your-deployment>.vercel.app/mcp
    | x-api-key: <raw Vercel access token>
    v
Your hosted MCP server
    |
    | Request to https://api.vercel.com/...
    | Authorization: Bearer <same Vercel access token>
    v
Vercel REST API
```

The conversion is already implemented in [`lib/mcp.js`](lib/mcp.js) and [`lib/vercel-api.js`](lib/vercel-api.js). **The server does not forward `x-api-key` to Vercel's REST API.** You do not generate a separate MCP API key.

### Does anything need to be hosted?

**Yes: this repository must be deployed, not just stored on GitHub.** Vercel can host it as a serverless function, so you do not need a separate VM, database, or always-on laptop. You need one deployment of this bridge, not one per Vercel project. Your token determines which resources it can access.

For the recommended setup, no `VERCEL_TOKEN` environment variable is needed on the server. Copilot Studio sends the connection's token with each request; the server processes it without persisting it. Only use a deployment you own or trust, since it receives that credential.

### Why not use Vercel's official MCP server?

[Vercel's official hosted MCP server](https://vercel.com/docs/agent-resources/vercel-mcp) is at `https://mcp.vercel.com` and uses OAuth sign-in with approved clients. This project is an alternative for an **API-key-based connection that you host and control**; it calls the REST API directly and does not depend on the official MCP server.

Copilot Studio [supports OAuth, including dynamic discovery](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent). The issue is provider approval, not a general lack of OAuth support. As checked on **2026-09-15**, Vercel's documented supported-client list includes **VS Code with Copilot**, but not **Microsoft Copilot Studio**; these are different products.

#### Observed Copilot Studio connection failure

On **2026-09-15**, a maintainer reported this error when connecting Copilot Studio to `https://mcp.vercel.com` using **OAuth 2.0 → Dynamic discovery**:

```text
Failed to login. GetDynamicClientRegistrationResultAsync failed. Status Code: BadRequest, Response: {"error":"invalid_redirect_uri","error_description":"The provided redirect URIs are not approved for use by this authorization server."}
```

A **redirect URI (callback address)** is where the authorization service sends the user back after sign-in. This error means the authorization server rejected the callback addresses submitted during client registration, before the connection could be authorized. It confirms that this connection attempt was blocked; it does not prove that every Copilot Studio configuration will always be unsupported.

- Keep a working API-key bridge connection while asking Vercel for a supported Copilot Studio OAuth configuration or approval of its callback URI.
- Regenerating a Vercel REST token, changing `x-api-key`, or editing this bridge cannot fix the official service's callback approval policy. Switching to Manual OAuth alone is not a fix either: it still needs an appropriate OAuth client and an approved callback.
- Share the error and the failing setup step with support; provide any requested callback details through an approved private channel. Never share access tokens, cookies, or full sign-in URLs containing authorization codes.

Both options are remote once hosted: this bridge runs at **your** URL; the official service is hosted and maintained by **Vercel**. If the official connection becomes supported and its tools meet your needs, it can remove the need to host and maintain this bridge. Check [Vercel's current supported-client guidance](https://vercel.com/docs/agent-resources/vercel-mcp) rather than treating this dated observation as a permanent limitation.

The API-key instructions below apply to **this repository**, not `mcp.vercel.com`.

## What it can and cannot do

**Permissions and capabilities are different:** the token determines which resources the agent may access; the implemented tools and operator policy determine which actions it can perform. Broad token permissions do not add missing tools.

The registry contains **33 implemented tools**. **14 read-only tools** are visible by default. The complete per-tool limits, differences, source contracts and the **8 unimplemented official tools** are in [the coverage table](docs/coverage.md). Do not infer capability from a similar tool name alone.

| Tool | Action | Access | Additional gate |
|---|---|---|---|
| `get_current_user` | Get the authenticated Vercel user's profile (username, email, account id). Not a health check for project-scoped tokens. | Read |  |
| `list_teams` | List Vercel teams the authenticated user belongs to. Returns team ids and names. | Read |  |
| `list_projects` | List Vercel projects. Returns project id, name, framework, and latest production URL. Optionally filter by team or search by name. | Read |  |
| `get_project` | Get details of a single Vercel project by its name or id, including framework, git repository link, and production alias. | Read |  |
| `list_deployments` | List recent deployments, optionally filtered by project, state (BUILDING, ERROR, READY, CANCELED, QUEUED) or target (production/preview). Returns deployment id, URL, state and git commit info. | Read |  |
| `get_deployment` | Get details of a single deployment by its id (uid) or URL, including state, target, aliases and error info if the build failed. | Read |  |
| `get_deployment_build_logs` | Get the build log output (events) for a deployment. Ideal for diagnosing failed builds. Returns the last N log lines. | Read |  |
| `cancel_deployment` | Cancel a deployment that is currently building or queued. | Write | Writes opt-in |
| `promote_deployment` | Promote an existing (READY) deployment to production for its project. Use this to roll forward or roll back production to a known-good deployment. | Write | Writes opt-in |
| `list_project_domains` | List the custom domains attached to a Vercel project, including verification status. | Read |  |
| `list_env_vars` | List environment variables for a project (keys, targets and types; secret values are hidden). | Read |  |
| `create_env_var` | Create (or upsert) an environment variable on a project for the given targets (production, preview, development). | Write | Writes opt-in |
| `delete_env_var` | Delete an environment variable from a project by its env var id (get ids from list_env_vars). | Write | Writes opt-in |
| `deploy_to_vercel` | Deploy inline source files to Vercel. Starts a build and can create a project. Requires operator-enabled writes. Returns pending state, not verified success. | Write | Writes opt-in |
| `deploy_from_git` | Build a GitHub branch/commit for an existing GitHub-linked Vercel project. Vercel must already have repository access. No source files or Git token in chat. | Write | Writes opt-in |
| `redeploy_deployment` | Rebuild an existing deployment in its original project. Explicit target prevents inheriting production accidentally. Inspect returned deployment status before retrying. | Write | Writes opt-in |
| `get_web_analytics` | Query Vercel Web Analytics counts or aggregates. Requires enabled analytics and a plan supporting the requested reporting window. Returns upstream totals without approximation. | Read |  |
| `check_domain_availability_and_price` | Check domain availability and quoted registration/renewal prices. Does not purchase or reserve anything. Up to 5 domains per call. | Read |  |
| `get_domain_order` | Read domain registration order status. A purchasing order is not yet completed. Does not buy anything. | Read |  |
| `list_agent_run_projects` | List team projects with eve Agent Runs. CLI-backed API, requires operator opt-in. Default window 1d. | Read | CLI API opt-in |
| `list_agent_runs` | List eve Agent Runs with upstream pagination. CLI-backed API, requires operator opt-in. | Read | CLI API opt-in |
| `get_agent_run` | Read one eve Agent Run. CLI-backed API, requires operator opt-in. | Read | CLI API opt-in |
| `get_agent_run_trace` | Read eve run traces. Sensitive conversation data may be returned. Strings capped at 8000 characters by default; 0 disables per-field truncation, not total response limits. | Read | CLI API opt-in |
| `get_runtime_logs` | Read a bounded page of runtime request logs using Vercel's CLI-backed API. Returns continuation and truncation metadata, not an exhaustive inventory. Operator opt-in required. | Read | CLI API opt-in |
| `list_toolbar_threads` | List Toolbar comment threads; unresolved by default. CLI-backed API uses cursor pagination, not offset. | Read | CLI API opt-in |
| `get_toolbar_thread` | Read a Toolbar thread and one page of messages. Follow nextCursor with messageCursor; does not silently drop pagination. | Read | CLI API opt-in |
| `change_toolbar_thread_resolve_status` | Resolve or reopen a Toolbar thread. Requires writes and CLI-backed API opt-in. | Write | CLI API opt-in; Writes opt-in |
| `reply_to_toolbar_thread` | Post a reply to a Toolbar thread. No automatic retries: a repeated request can duplicate a message. | Write | CLI API opt-in; Writes opt-in |
| `edit_toolbar_message` | Edit a Toolbar message. Vercel enforces ownership. Requires writes and CLI-backed API opt-in. | Write | CLI API opt-in; Writes opt-in |
| `use_vercel_cli` | Return Vercel CLI help guidance only. This server never runs shell commands or accesses the user's local filesystem. | Read |  |
| `search_vercel_documentation` | Keyword-search Vercel's public documentation index. Returns matching index entries and links, not Vercel's proprietary semantic search or full document contents. | Read |  |
| `web_fetch_vercel_url` | Fetch a public, owned Vercel deployment's text. Operator must allow the exact hostname and external fetching. Does not create access links or bypass Deployment Protection. | Read | External-fetch opt-in |
| `import-claude-design-from-url` | Import a self-contained public Claude Design HTML bundle as index.html. Explicit name/target and external-fetch/write opt-ins required. Never executes content on this server. | Write | External-fetch opt-in; Writes opt-in |

### Deploying applications

You can now deploy **inline source files**, deploy a branch/commit of an **existing GitHub-linked project**, and **redeploy an existing deployment**. These use [Vercel's deployment API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment), not a local shell or the official MCP endpoint. Vercel must have access to the Git repository; a token does not supply local source files.

All 3 deployment tools require an explicit **preview or production target**. Enable writes for a reviewed test project first; production requires a separate operator flag. UTF-8 and base64 inputs are normalized to base64 on the API wire. File deployment supports **100 files / 1048576 decoded bytes**; use Git for larger projects. A production/custom-target original cannot be safely redeployed as preview by this implementation: use deploy_from_git to create a fresh preview instead.

**A requested build is not a successful deployment.** Check the returned ID with get_deployment until READY or ERROR, inspect build logs, and verify the actual page. No automatic retries are made: a timeout can leave the write outcome unknown.

The original promote_deployment still promotes an existing build rather than building new code. Environment-variable writes still default to encrypted values and **all 3 targets: production, preview, development**; specify targets explicitly. These defaults now require production opt-in when applicable.

### Pagination and bounded results

List tools return a page, not a complete account inventory. list_teams defaults to **100**, list_projects to **20**, and list_deployments to **10** (maximum **100** each). Set includePagination to true to receive metadata; use from for project continuation and until for teams/deployments. No automatic cross-team traversal is performed.

Build logs scan at most **1000 upstream events** and return **100 lines by default**, maximum **1000**. Use includePagination for scan metadata and narrower since/until windows. Runtime logs, Agent Runs and comments expose their own pagination and explicit truncation metadata; see [coverage](docs/coverage.md). Oversized aggregate results fail rather than silently dropping totals.

### Policy and annotations

Every tool declares all **4 MCP hints**. Read tools are read-only/non-destructive/idempotent. Original cancellation and environment deletion remain idempotent by effect; other writes are conservatively non-idempotent. All tools are open-world except use_vercel_cli, which only returns local guidance. **Annotations are advisory, not permissions or evidence of human approval.**

Server-side policy is enforced on discovery **and execution**. The [operator flags and production checklist](docs/production.md) describe write/production gates, tool allowlists, opt-in CLI-backed APIs and safe public fetching. Enabling a flag is not approval of a particular tool call: configure host-level human approval and restrict who can use the connection.

Purchases and protected-link creation are not implemented and cannot be enabled with flags. No raw arbitrary-API or shell-execution tool is exposed. This remains a focused bridge, not unrestricted account administration.

## Set up in Copilot Studio

You need a Vercel account, permission to deploy this repository, and access to add tools and connections to your Copilot Studio agent. Your organization's Power Platform data policies must also allow the connection; see [Microsoft's MCP setup guide](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent).

### 1. Deploy the bridge and copy its URL

**Why:** Copilot Studio calls a running HTTPS endpoint; it cannot run the GitHub repository itself.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fogradyliam5%2Fvercel-mcp-copilot-studio)

1. Select **Deploy with Vercel**, sign in, and follow the prompts to create and deploy your copy.
2. Wait for the deployment to become ready.
3. Copy the project's production domain from Vercel and append `/mcp`.

Your **Server URL** will look like `https://<your-deployment>.vercel.app/mcp`. Replace the placeholder with your actual domain. Do not use the GitHub URL, the Vercel dashboard URL, `api.vercel.com`, or `mcp.vercel.com`.

If you already have a working deployment, reuse it. You do not need to redeploy simply to change the token stored in Copilot Studio.

Opening `/mcp` in a browser normally returns **HTTP 405 (Method Not Allowed)**: browsers make GET requests, while MCP uses POST. This alone is not a failure. If [Deployment Protection](https://vercel.com/docs/deployment-protection) is enabled, the connection must also satisfy that protection; a Vercel API token is not a deployment-protection credential. Do not disable organizational protections to complete setup.

### 2. Create a Vercel access token

**Why:** this tells Vercel whose permissions to use and which resources the agent may access.

1. Open your personal account's [Account Tokens page](https://vercel.com/account/tokens).
2. Give the token a recognizable name, such as `Copilot Studio`.
3. Choose its **Scope** using the table below.
4. Choose an expiration, select **Create**, and copy the token securely. Its value is shown only once.

| Scope | Choose it when | Access |
|---|---|---|
| **Project** | The agent only needs one project. | That single project's resources; user-level and team-level requests are denied. |
| **Team / All Projects** | The agent needs projects within one team. | That team's resources across all its projects. |
| **Full Account** | You deliberately want access across your personal account and teams. | Your personal account and every team you belong to, subject to your permissions. |

Choose the narrowest scope that meets your needs. **Full Account is broad access, not a prerequisite for setup.** It still only enables the tools implemented by this server. See [Vercel's token-scope documentation](https://vercel.com/docs/accounts/access-tokens).

### 3. Add the server and create the connection

**Why:** the server definition tells Copilot Studio *where to connect*; the connection holds *the credential to use*.

1. Open your agent → **Tools → Add a tool → New tool → Model Context Protocol**.
2. Enter these server settings:

   | Field | Value |
   |---|---|
   | Server name | `Vercel` |
   | Server description | Use the text below. |
   | Server URL | `https://<your-deployment>.vercel.app/mcp` |
   | Authentication | **API key** |
   | Type / location | **Header** |
   | Header name | `x-api-key` |

   **Copyable server description:**

   > Inspect Vercel projects, deployments, logs, domains and analytics. When explicitly enabled, deploy source files or GitHub code, redeploy, manage environment variables and use optional Agent Runs and comment tools. Follow server policy and verify build status before reporting success.

3. Select **Create**, then **Create a new connection** in the Add tool dialog.
4. When prompted for the **API key**, paste **only your Vercel access token**. Do not add `Bearer`, quotation marks, or `x-api-key:`. Do not paste it into the description, URL, agent instructions, or chat.
5. Select the new connection and **Add to agent**. If you replaced an old token, make sure the tool is using the new/updated connection rather than the old one.

**Leave `VERCEL_TOKEN` unset on the deployed server for this setup.** The connection supplies the token. Keep **API key** authentication selected, not **None** or **OAuth 2.0**. These steps follow [Microsoft's MCP onboarding wizard](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent).

### 4. Verify with a read-only action

**Why:** discovering tools proves the server can respond, but does not prove that Vercel accepts the token. This implementation allows initialization and tool discovery without validating a Vercel credential.

In the agent's test pane, ask:

> Use the Vercel list_projects tool with limit 1. Do not make any changes.

Check the actual tool result for success (`isError: false`), not just the agent's explanation. An empty project list can be a successful request with no projects in the selected account context.

- **Full Account token:** for team projects, ask the agent to use `list_teams`, identify your intended team, then call `list_projects` with that team's `teamId`. The server does not automatically loop through every team.
- **Team or Project token:** Vercel infers the team/project from the scope, so `teamId` can be omitted.
- **Project token:** do not use `get_current_user` or `list_teams` as the health check. Vercel denies those user/team requests even when access to the project works.

See [Vercel's scope guidance](https://vercel.com/docs/accounts/access-tokens). Once a read-only test succeeds, try “Show the build logs for the latest failed deployment of my-site.” Before enabling writes, put human approval controls in your agent/workflow; **operator flags are not per-request human approval**. In particular, specify environment-variable targets explicitly to avoid unintentionally changing all three targets.

## Troubleshooting

Start with the **tool name and raw error**, not an AI-generated guess. Do not paste credentials into chat or add request-header logging.

| Symptom | What to check |
|---|---|
| Official `mcp.vercel.com` login fails with `GetDynamicClientRegistrationResultAsync` / `invalid_redirect_uri` | The authorization server rejected the submitted OAuth callback addresses during registration. See the [observed connection failure](#observed-copilot-studio-connection-failure); this is separate from this bridge's REST-token errors. |
| `no Vercel access token was provided` | Select the correct connection; confirm **API key → Header → `x-api-key`** and that it contains the raw token. |
| `Vercel API error: ... (HTTP 401)` or `(HTTP 403)` | Check the saved token's value, expiration, revocation and scope. Check team context and conflicting headers below. Do not assume the header conversion is missing. |
| `Vercel API error: User not found. (HTTP 404)` | The upstream API returned this error; it does not establish a single cause. Identify the failing tool, verify token scope and try the read-only project test. A token prefix alone does not prove validity. |
| Projects are missing or the list is empty | For Full Account tokens, provide the intended team's `teamId`. Check scope and the list limits above; no automatic cross-team enumeration or pagination is implemented. |
| Tools appear, but calls fail | Discovery does not validate credentials. Run the read-only test and inspect its result. |
| Browser shows HTTP 405 at `/mcp` | Expected for GET; use Copilot Studio to send an MCP POST request. |
| HTML login page, platform 404, or no MCP response | Check the deployment's readiness, exact `/mcp` URL, protection settings, and whether the connection is allowed by Power Platform data policies. |

**For maintainers:** this version accepts a Bearer Authorization header or a raw token in x-api-key / x-vercel-token. Matching credentials in multiple headers are allowed; conflicting or malformed values fail with HTTP 401. There is **no VERCEL_TOKEN fallback**. Changing the token never requires rebuilding the server.

A tool missing from discovery may be disabled by policy, not missing from the code. A direct call to a disabled tool also fails. Refresh the connector tool list after upgrading or changing operator flags.

If configuration checks do not resolve it, compare the **same read-only operation with the same token** directly against Vercel's API using a trusted local client. Direct failure points to the credential, scope, requested resource or Vercel; direct success with MCP failure narrows the investigation to the connection, header selection or deployed code. Never print authorization headers. Confirm the deployed revision rather than assuming it matches GitHub.

## Security

- Use HTTPS and a server deployment you own or trust. This bridge receives the Vercel token and can exercise its permissions.
- Restrict who can use the agent and its connection. A shared connection uses the token owner's access; it does not automatically give each chat user their own Vercel identity.
- Keep tokens out of Git, chat, screenshots, URLs and logs. If a full token is exposed, revoke it, create a replacement, and update the connection. Choose an expiration and plan for replacement.
- Require host-level human approval for writes, especially production promotion and environment-variable changes. Server flags/allowlists enforce operator policy but do not establish per-request human consent. Do not replace approval with an AI-populated boolean.
- `list_env_vars` masks `encrypted` and `sensitive` values, not every value or every tool response. Logs and plain variables can contain private data. Use Vercel's dashboard or your approved secret-management process for secret values rather than entering them in agent chat.

## For developers and self-hosters

The main setup above needs no local terminal. The alternatives below are for maintainers.

### Deploy with the CLI

From a local checkout, with the Vercel CLI installed and authenticated to the intended account/team:

```bash
vercel deploy --prod
```

This creates a production deployment of the **bridge**. Use its HTTPS URL ending in `/mcp` in Copilot Studio.

### Run on another Node.js host

From a local checkout:

```bash
node server.js
```

The package declares Node.js **>=18**; use a supported Node.js release meeting that requirement. The standalone server listens on `PORT` (default **3000**) at `/mcp` or `/api/mcp`. Copilot Studio needs a reachable HTTPS address; `localhost:3000` is only for local development. The standalone `/health` endpoint is not supplied by the Vercel function deployment.

No `npm install` is needed: there are no npm dependencies, database, or session store.

### Advanced authentication

Other clients can supply `Authorization: Bearer <token>` or a raw token in `x-vercel-token`. Conflicting token headers are rejected as described in Troubleshooting. **Tokens in URL query parameters are not supported by this implementation.**

The old `VERCEL_TOKEN` fallback is **not supported in version 2**. Keep it unset. Supply a per-connection credential instead; see [migration](docs/production.md).

### Implementation and tests

The transport is **Streamable HTTP**, with JSON responses and no sessions or server-initiated stream.

- [`api/mcp.js`](api/mcp.js): Vercel function entry point; [`vercel.json`](vercel.json) maps `/mcp` to `/api/mcp`.
- [`server.js`](server.js): standalone HTTP host.
- [`lib/mcp.js`](lib/mcp.js): stateless JSON-RPC 2.0 handling and token extraction; protocol versions **2024-11-05**, **2025-03-26**, **2025-06-18**.
- [`lib/tools.js`](lib/tools.js): original tools plus registration of [`lib/extended-tools.js`](lib/extended-tools.js) and [`lib/web-tools.js`](lib/web-tools.js).
- [`lib/policy.js`](lib/policy.js), [`lib/validation.js`](lib/validation.js): execution policy, input checks and response masking.
- [`lib/http.js`](lib/http.js), [`lib/public-fetch.js`](lib/public-fetch.js): bounded request handling and credential-free, DNS-pinned public fetching.
- [`lib/vercel-api.js`](lib/vercel-api.js): REST requests with Bearer authentication and upstream error handling.

Run the repository's test command:

```bash
npm test
```

The test command runs the original 46 protocol/contract tests, then the extended-tool and security suites. All **33 implemented tools** are covered by behavioral fixtures; an inventory check detects untested additions. Tests cover request methods/paths/query/body, all 4 annotations, upstream failures, disabled writes, production gates, malformed input, redaction, size/deadline limits, pagination, DNS pinning, and both HTTP adapters. APIs are mocked: this is not a claim of 100% branch coverage or live authentication/deployment verification. See [production rollout](docs/production.md) for the required real-connection checks and the credential-safe, read-only `npm run smoke` command. Public content URLs must be query-free; known credential fields in traces are masked before truncation.

## License

[MIT](LICENSE)
