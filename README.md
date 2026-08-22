# Vercel MCP Server for Microsoft Copilot Studio

A **zero-dependency** [Model Context Protocol](https://modelcontextprotocol.io) server for the **Vercel platform**, built specifically to work with **Microsoft Copilot Studio** (which requires the Streamable HTTP transport and supports API-key authentication).

> **Why this exists:** Vercel's official MCP server (`https://mcp.vercel.com`) uses OAuth with dynamic client registration, which Copilot Studio's MCP onboarding cannot complete. This server bridges the gap: the **API key you enter in Copilot Studio is your Vercel access token**, forwarded per-request to the Vercel REST API. The server itself is stateless and stores nothing.

## Tools

| Tool | Description |
|---|---|
| `get_current_user` | Verify the connection / identify the token owner |
| `list_teams` | List Vercel teams |
| `list_projects` | List projects (id, framework, production URL) |
| `get_project` | Project details incl. git repo link |
| `list_deployments` | Recent deployments, filter by project/state/target |
| `get_deployment` | Deployment details incl. error info |
| `get_deployment_build_logs` | Build log output — great for diagnosing failed builds |
| `cancel_deployment` | Cancel a building/queued deployment |
| `promote_deployment` | Promote (roll forward/back) a deployment to production |
| `list_project_domains` | Custom domains + verification status |
| `list_env_vars` | Env vars (secret values hidden) |
| `create_env_var` | Create/upsert an env var |
| `delete_env_var` | Delete an env var |

## Deploy

### Option A — Deploy to Vercel (recommended, ~1 minute)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fogradyliam5%2Fvercel-mcp-copilot-studio)

Or with the CLI:

```bash
vercel deploy --prod
```

Your MCP endpoint will be: `https://<your-deployment>.vercel.app/mcp`

### Option B — Self-host (any Node 18+ host)

```bash
node server.js        # listens on PORT (default 3000), endpoint /mcp
```

No `npm install` needed — there are no dependencies.

## Connect from Copilot Studio

1. Create a Vercel access token at **https://vercel.com/account/settings/tokens** (scope it to the team/projects you want the agent to manage).
2. In Copilot Studio, open your agent → **Tools** → **Add a tool** → **Model Context Protocol (MCP)**.
3. Fill in:
   - **Name:** `Vercel`
   - **Description:** `Manage Vercel projects, deployments, build logs, domains and environment variables.`
   - **Server URL:** `https://<your-deployment>.vercel.app/mcp`
   - **Authentication:** **API key**
     - **Header name / location:** `x-api-key` (header)
     - **Value:** your Vercel access token
4. Click **Add** → Copilot Studio performs the MCP handshake and lists all 13 tools.
5. **Create connection**, enable it in the connection manager, then test in the Preview pane, e.g.:
   - *"List my Vercel projects"*
   - *"Show me the build logs for the latest failed deployment of my-site"*
   - *"Add an env var API_URL=https://api.example.com to my-site for preview only"*

The server also accepts the token via `Authorization: Bearer <token>` or `x-vercel-token` headers, and falls back to a `VERCEL_TOKEN` environment variable for single-tenant self-hosted deployments (in that case choose **No authentication** in Copilot Studio — only do this if the server URL itself is protected/private).

## Architecture

```
Copilot Studio ──POST /mcp (JSON-RPC, Streamable HTTP)──▶ this server ──REST──▶ api.vercel.com
                     x-api-key: <vercel access token>          (stateless, no storage)
```

- **Transport:** MCP Streamable HTTP, stateless mode (protocol versions 2024-11-05 → 2025-06-18). No sessions, no SSE required — ideal for serverless.
- **Auth:** pass-through. The server never stores tokens; every request carries the caller's own Vercel token.
- **Zero dependencies:** plain Node.js ≥18. Nothing to install, no supply chain.

## Development & tests

```bash
node test/mcp.test.js
```

The test suite boots the real HTTP server, mocks `api.vercel.com`, and drives the full MCP handshake (initialize → initialized → tools/list → tools/call), plus error paths (bad token, unknown tool/method, malformed JSON, batching).

## Security notes

- Use a **scoped** Vercel token, ideally on a dedicated team with least privilege.
- Secret env var values are never returned by `list_env_vars`.
- Deploy under HTTPS only (automatic on Vercel). Copilot Studio requires HTTPS.
- Consider Vercel [Deployment Protection](https://vercel.com/docs/deployment-protection) bypass headers if you protect the deployment.

## License

MIT
