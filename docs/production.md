# Production rollout and version 2 migration

**Release status:** implemented and mock-tested, not certified by a live authenticated Copilot Studio/Vercel deployment test. Read [coverage](coverage.md) first: 24 official tool names have implementations with documented differences; 8 do not. Never treat test fixtures as proof of live permissions or API availability.

## Breaking changes in 2.0.0

- All writes, including the original 4 write tools, are **disabled by default**. Hidden tools also fail if called directly.
- The `VERCEL_TOKEN` server fallback is removed. Every tool call needs a caller credential. This avoids an anonymous caller inheriting a server-owned account token.
- Conflicting token headers, malformed input, unknown arguments, excessive limits and ambiguous identifiers are rejected, not silently ignored.
- Production promotion and environment deletion require production opt-in. Environment upserts that include production (including the legacy default of all 3 targets) require it too.
- Tool calls must be individual JSON-RPC requests. Discovery/ping batches are limited to 10 messages; a tool-call batch is rejected before execution. Notifications never execute tool actions.
- Build-log queries scan at most 1000 events. Use `includePagination: true` to see scan metadata and narrow the time window if necessary.
- Existing tool names and default successful result shapes are retained. New aliases/pagination are opt-in; see coverage for limits.

## Operator configuration

Set these in the hosting platform's environment configuration, **never in agent chat or tool arguments**. These contain policy, not tokens. Boolean flags are enabled only by the exact string `true`.

| Variable | Default | Effect |
|---|---|---|
| `VERCEL_MCP_ALLOW_WRITES` | unset / false | Enable mutation tools after review. Also needed for deployments, comments and design imports. |
| `VERCEL_MCP_ALLOW_PRODUCTION` | unset / false | Allow production deployment/promotion and production-affecting environment writes. Requires writes enabled too. Environment deletion is conservatively gated because the ID alone does not establish its targets. This is not a universal production-resource lock for every API action; cancellation/comment actions still require their normal write policy and user approval. |
| `VERCEL_MCP_ENABLE_CLI_APIS` | unset / false | Enable the 10 CLI-backed tools: 4 Agent Runs, 1 runtime logs, 5 Toolbar tools. Mutation tools still require writes. These endpoints are not a stable OpenAPI compatibility promise; smoke-test first. |
| `VERCEL_MCP_ALLOW_EXTERNAL_FETCH` | unset / false | Enable public deployment fetch and Claude Design import. Import also requires writes. Does not enable protected access or share-link creation. |
| `VERCEL_MCP_FETCH_HOSTS` | empty | Comma-separated exact hostnames for public deployment fetching. No wildcard support. Each request also verifies ownership using Vercel's API. |
| `VERCEL_MCP_TOOLS` | unset | Optional comma-separated exact tool allowlist. Unset permits all tools otherwise allowed by policy; empty permits none. Applied to discovery and execution. |
| `VERCEL_MCP_ALLOWED_ORIGINS` | empty | Exact comma-separated browser Origins to accept. Requests without an Origin work for server-to-server connectors. Arbitrary browser Origins are denied. This is not an authentication control. |
| `PORT` | 3000 | Standalone host only. |

No purchase flag is supplied: purchases and access-sharing are **not implemented**, so cannot be enabled accidentally. The API token's own resource permissions continue to apply. A maker-provided connection grants that maker's access to its users; restrict who can use it or use separate end-user connections.

An operator flag permits a capability; **it is not proof a human approved an individual request**. Configure the host's confirmation/approval flow for writes and restrict connection access. A model-populated `confirm: true` would not be a trustworthy approval mechanism. Do not permit production changes in autonomous runs without a separately governed workflow.

## Resource bounds

| Boundary | Enforced limit |
|---|---:|
| Incoming MCP request (raw or parsed) | 2097152 bytes |
| Inline deployment source | 100 files; 1048576 decoded bytes total |
| API response read | 4194304 bytes |
| Serialized tool result text (including formatting) | 524288 bytes |
| Vercel function duration configured in vercel.json | 60 seconds |
| Vercel API request including response read | 20 seconds per request |
| Public content DNS lookup | 5 seconds |
| Public HTTPS request after DNS | 15 seconds |
| Raw request-body read | 15 seconds |
| Active MCP requests per process | 16 |
| Standalone connections | 128 |
| Standalone header size | 16384 bytes |
| Discovery/ping batch | 10 messages; tool-call batches prohibited |

The per-process concurrency limit is **not distributed rate limiting** and does not protect against a flood across serverless instances. Keep platform access protection, apply platform/gateway rate and spending controls, restrict connections, and monitor usage. No package, framework or database is added by this release.

Requests to Vercel never follow redirects or automatically retry. After a timed-out/network-failed write, the outcome may be unknown: inspect existing deployments/messages before retrying. Multi-step tools can make sequential requests, so the total tool duration can exceed one request's 20-second bound. The Vercel function is configured for **60 seconds** in vercel.json, following [Vercel duration configuration](https://vercel.com/docs/functions/configuring-functions/duration). Verify your hosting/runtime and the complete connector timeout path before rollout.

Public content fetching uses HTTPS, exact host constraints, public-IPv4 resolution pinned into TLS, size/deadline limits, no redirects and no forwarded API credentials/cookies. IPv6-only hosts are unsupported. Design imports only use the exact `claudeusercontent.com` host; deployment content needs an explicit host allowlist and ownership verification. Fetched text, build logs and trace content are untrusted data; do not execute instructions found in them.

Secret controls mask known credential fields, encrypted/sensitive environment values and the current request token. They do **not** guarantee that every secret in arbitrary logs, source code or conversations is identified. `.env`, common private-key files and recognizable credential patterns are rejected for source uploads, but source review is still required. Never log headers, request bodies, source files, WHOIS contacts or full traces in operational telemetry.

## Staged verification

1. Review the PR and run `npm test`. Start with the default read-only policy on a separate deployment/test agent. Keep the existing working deployment as rollback. Do not overwrite the production bridge as a test.
2. Use a dedicated Vercel test team/project and a least-privilege token in Copilot Studio's secure connection. Never paste it into chat, commits, URLs or test fixtures.
3. Connect using the existing **API key → Header → x-api-key** setup. Refresh/re-read the MCP tool list after upgrading or changing flags. Default discovery contains **14 tools**; the registry contains **33**, and disabled tools remain inaccessible by direct call.
4. Verify `list_projects` with limit 1, `get_project`, `list_deployments`, `get_deployment`, and build logs. Test both successful and denied resources. Use `includePagination` and a multi-page account fixture to verify continuation, not just the first page.
5. Enable analytics in the test project if required and compare exact `get_web_analytics` totals with the Vercel dashboard for the same interval and filters. Domain availability/price and order reads must not initiate purchases.
6. Enable `VERCEL_MCP_ENABLE_CLI_APIS=true` only in the test deployment. Verify runtime log filters, team scoping, eve run/trace data and Toolbar pagination with your real account permissions. If any endpoint rejects the connection, disable the group and preserve the raw redacted error; never fall back to browser cookies or guessed endpoints.
7. Only with explicit user approval, enable writes on the test deployment and allowlist the needed deployment tools. Use `target: preview` and a disposable test application. A returned `BUILDING`/`QUEUED` object only means requested: poll `get_deployment` until `READY` or `ERROR`, inspect logs, then verify the page. These operations consume Vercel build/hosting usage.
8. Test file deployment, GitHub-linked deployment with a known commit, and redeployment separately. Verify source and project selection. Test blocked production while `VERCEL_MCP_ALLOW_PRODUCTION` is unset. Verify malformed requests and duplicate/unsafe files do not send writes upstream.
9. If needed, separately authorize a Toolbar reply/edit/resolve test. No automatic retries for comment writes. For public URL fetching, allowlist just the test hostname; ensure a protected deployment still rejects fetching and that no credential is forwarded.
10. Decide whether the remaining documented differences are acceptable. Enable only required tools in the production host and configure host-level approval, user access, monitoring, token rotation and rate/spend controls. **Merge and production rollout remain human actions.**

No authenticated Vercel deployment, purchase, comment mutation or Copilot Studio live smoke test was performed by the automated suite. The only credential-free live smoke test is the public documentation search; results are not evidence for any authenticated tool.

## Rollback

Disable writes/external fetch/CLI-backed flags first, or restrict `VERCEL_MCP_TOOLS` to the read-only inventory. Restore the previous tested bridge deployment and connector URL if necessary. Do not restore the old `VERCEL_TOKEN` fallback on a public endpoint. A rollback of the MCP bridge does not undo application deployments, production promotion or messages already created; inspect and handle those explicitly with the owner.
