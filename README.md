# Vercel MCP Server for Microsoft Copilot Studio

Let your Copilot Studio agent inspect Vercel projects and deployments, read build logs, and perform the management actions listed below. This is an independent, **zero-dependency** Node.js server, not Vercel's official MCP server.

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

Copilot Studio [supports OAuth, including dynamic discovery](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent). Do not assume that OAuth is unsupported, or that protocol support alone guarantees compatibility with every provider. Check Vercel's supported-client guidance if you prefer its hosted service. The API-key instructions below apply to **this repository**, not `mcp.vercel.com`.

## What it can and cannot do

**Permissions and capabilities are different:** the token determines *which resources* the agent may access; this server's tools determine *which actions* it can perform.

The server currently exposes **13 tools**:

| Tool | Action | Access |
|---|---|---|
| `get_current_user` | View the token owner's profile; not a connection test for project-scoped tokens. | Read |
| `list_teams` | List team IDs and names; requests up to **100 teams**. | Read |
| `list_projects` | List projects, optionally by team or name; default **20 projects**. | Read |
| `get_project` | View a project's details and Git repository link. | Read |
| `list_deployments` | List deployments, optionally by project, state or target; default **10 deployments**. | Read |
| `get_deployment` | View a deployment's details and error information. | Read |
| `get_deployment_build_logs` | Read build logs; default last **100 matching log lines**. | Read |
| `list_project_domains` | List attached domains and verification status; does not add domains or edit DNS. | Read |
| `list_env_vars` | List environment variables; `encrypted` and `sensitive` values are hidden, other values may be returned. | Read |
| `cancel_deployment` | Cancel a building or queued deployment. | Write |
| `promote_deployment` | Promote an existing READY deployment to production. | Write |
| `create_env_var` | Create or update a variable; defaults to `encrypted` and **all 3 targets: production, preview, development**. | Write |
| `delete_env_var` | Delete a variable using its ID. | Write |

List tools do not automatically fetch every page. Project, deployment and log tools accept a `limit`; a response is not necessarily a complete account inventory. See [`lib/tools.js`](lib/tools.js) for the implemented arguments and handlers.

**This is not complete Vercel administration.** It does not implement creating/deleting projects, creating deployments, editing DNS, managing team membership, or billing administration. A Full Account token does not add those missing tools; additional actions require implementation.

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

   > Inspect Vercel projects, deployments, build logs, domains, account details, and teams. Manage environment variables, cancel deployments, and promote existing deployments to production.

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

See [Vercel's scope guidance](https://vercel.com/docs/accounts/access-tokens). Once a read-only test succeeds, try “Show the build logs for the latest failed deployment of my-site.” Before enabling writes, put human approval controls in your agent/workflow; **this server does not enforce confirmation**. In particular, specify environment-variable targets explicitly to avoid unintentionally changing all three targets.

## Troubleshooting

Start with the **tool name and raw error**, not an AI-generated guess. Do not paste credentials into chat or add request-header logging.

| Symptom | What to check |
|---|---|
| `no Vercel access token was provided` | Select the correct connection; confirm **API key → Header → `x-api-key`** and that it contains the raw token. |
| `Vercel API error: ... (HTTP 401)` or `(HTTP 403)` | Check the saved token's value, expiration, revocation and scope. Check team context and conflicting headers below. Do not assume the header conversion is missing. |
| `Vercel API error: User not found. (HTTP 404)` | The upstream API returned this error; it does not establish a single cause. Identify the failing tool, verify token scope and try the read-only project test. A token prefix alone does not prove validity. |
| Projects are missing or the list is empty | For Full Account tokens, provide the intended team's `teamId`. Check scope and the list limits above; no automatic cross-team enumeration or pagination is implemented. |
| Tools appear, but calls fail | Discovery does not validate credentials. Run the read-only test and inspect its result. |
| Browser shows HTTP 405 at `/mcp` | Expected for GET; use Copilot Studio to send an MCP POST request. |
| HTML login page, platform 404, or no MCP response | Check the deployment's readiness, exact `/mcp` URL, protection settings, and whether the connection is allowed by Power Platform data policies. |

**For maintainers:** token selection in [`lib/mcp.js`](lib/mcp.js) checks a Bearer `Authorization` header first, then `x-api-key`, then `x-vercel-token`, and finally `VERCEL_TOKEN`. An unrelated Bearer header can override the intended API key. Also, `Bearer` inside the `x-api-key` value is not stripped: the outbound request would contain `Bearer Bearer ...`. Send only the raw token in `x-api-key`.

If configuration checks do not resolve it, compare the **same read-only operation with the same token** directly against Vercel's API using a trusted local client. Direct failure points to the credential, scope, requested resource or Vercel; direct success with MCP failure narrows the investigation to the connection, header selection or deployed code. Never print authorization headers. Confirm the deployed revision rather than assuming it matches GitHub.

## Security

- Use HTTPS and a server deployment you own or trust. This bridge receives the Vercel token and can exercise its permissions.
- Restrict who can use the agent and its connection. A shared connection uses the token owner's access; it does not automatically give each chat user their own Vercel identity.
- Keep tokens out of Git, chat, screenshots, URLs and logs. If a full token is exposed, revoke it, create a replacement, and update the connection. Choose an expiration and plan for replacement.
- Require human approval for writes, especially production promotion and environment-variable changes. A description asking for confirmation is not an authorization control, and the server has no built-in approval gate.
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

Other clients can supply `Authorization: Bearer <token>` or a raw token in `x-vercel-token`. Token headers are read in the precedence order described in Troubleshooting. **Tokens in URL query parameters are not supported by this implementation.**

The optional `VERCEL_TOKEN` fallback is for deliberately secured, single-tenant hosting only. If it is set, requests without a caller token can use that server-side credential. The bridge does not authenticate those callers itself. **Never expose this fallback on an unprotected public endpoint; a hard-to-guess URL is not protection.** Leave it unset for the recommended per-connection setup.

### Implementation and tests

The transport is **Streamable HTTP**, with JSON responses and no sessions or server-initiated stream.

- [`api/mcp.js`](api/mcp.js): Vercel function entry point; [`vercel.json`](vercel.json) maps `/mcp` to `/api/mcp`.
- [`server.js`](server.js): standalone HTTP host.
- [`lib/mcp.js`](lib/mcp.js): stateless JSON-RPC 2.0 handling and token extraction; protocol versions **2024-11-05**, **2025-03-26**, **2025-06-18**.
- [`lib/tools.js`](lib/tools.js): the 13 tool definitions and handlers.
- [`lib/vercel-api.js`](lib/vercel-api.js): REST requests with Bearer authentication and upstream error handling.

Run the repository's test command:

```bash
node test/mcp.test.js
```

The tests start a local HTTP server around the MCP handler, **mock `api.vercel.com`**, and exercise initialization, notifications, discovery, tool calls and error paths. They do not validate a real token, the deployed function, or a live Copilot Studio connection.

## License

[MIT](LICENSE)
