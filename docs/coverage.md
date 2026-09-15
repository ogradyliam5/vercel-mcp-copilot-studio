# Official MCP coverage and provenance

Checked **2026-09-15** against the [complete official tools reference](https://vercel.com/docs/agent-resources/vercel-mcp/tools).

**33 implemented tools**: **24 of the 32 official tool names** have implementations (with differences below), plus **9 extras** retained/added for this bridge. **8 official tools are not implemented**, not advertised in discovery, and cannot be enabled with a flag. This is not a 100% parity or live-production-certification claim.

All implemented tools have schema/annotation checks and behavioral tests. API tests use mocks. CLI-backed endpoints are opt-in because they are evidenced in Vercel's public CLI, not promised by its public OpenAPI contract. They require a successful live read-only smoke test before use.

| Official tool | Status | Scope, limits and differences |
|---|---|---|
| `search_vercel_documentation` | Implemented; see limits | Keyword search of the public documentation sitemap, not the official semantic search. Maximum 20 matching index entries; default 2500 budget units converted to a 10000-character cap. Returns links/index text, not full pages. |
| `list_teams` | Implemented; see limits | Original array output retained. Default 100, maximum 100 per page. includePagination returns metadata; until accepts continuation timestamp. No automatic whole-account scan. |
| `list_projects` | Implemented; see limits | Original array output retained. Default 20, maximum 100. includePagination returns metadata; use from for the continuation token. No automatic whole-account scan. |
| `get_project` | Implemented; see limits | Accepts projectId or legacy projectIdOrName. Keeps trimmed existing result, not the full official response schema. |
| `list_deployments` | Implemented; see limits | Original array output retained. Default 10, maximum 100. includePagination and until support continuation. The original state/target filters remain; not an exact official input schema. |
| `get_deployment` | Implemented; see limits | Existing trimmed deployment response, aliases and build errors. Not an exact official response schema. |
| `get_deployment_build_logs` | Implemented; see limits | Supports idOrUrl or legacy deploymentIdOrUrl, head/tail, errorsOnly, since/until and buildId. Scans at most 1000 events; default 100 returned lines, maximum 1000. includePagination shows possiblyMore and scannedEvents. Filtered errors apply to the scanned window only. |
| `get_runtime_logs` | Implemented; see limits | CLI-backed and opt-in. Resolves project owner before fetching one bounded page. Default 50, maximum 1000 returned rows. since/until default last 24 hours, maximum 90-day interval. No group_by emulation; page, hasMore, nextPage and truncated are explicit. Increase limit on the same page before advancing if truncated. |
| `get_runtime_errors` | **Not implemented** | No verified grouped-error-cluster API contract found in the public OpenAPI or the inspected CLI. get_runtime_logs is available, but sampled logs are not equivalent to global error counts. Needs an authenticated supported contract and fixtures. |
| `deploy_to_vercel` | Implemented; see limits | Inline source deployment. Requires name, files and explicit preview/production target. Maximum 100 files and 1048576 decoded bytes total. No local filesystem access. Production requires a separate operator flag. Build state is returned; success is not assumed. |
| `get_web_analytics` | Implemented; see limits | Count and aggregate for visits/events. Aggregate requires since/until and 1–2 dimensions; default 10, maximum 100 groups. Preserves upstream totals and Others. Analytics must be enabled; plan reporting windows are enforced upstream. |
| `list_agent_run_projects` | Implemented; see limits | CLI-backed and opt-in. Requires teamId. Default production and last 1d; explicit from/to overrides period; maximum 90-day interval. Returns upstream team view. |
| `list_agent_runs` | Implemented; see limits | CLI-backed and opt-in. Requires teamId/projectId; default page 1, pageSize 20, maximum 100. Time scope as list_agent_run_projects; retains upstream pagination. |
| `get_agent_run` | Implemented; see limits | CLI-backed and opt-in. Requires teamId/projectId/runId. Time scope as list_agent_run_projects. |
| `get_agent_run_trace` | Implemented; see limits | CLI-backed and opt-in. Default per-string cap 8000 characters; range 0–50000. 0 disables per-field truncation, not the total output limit. Trace data can contain private conversations. |
| `check_domain_availability_and_price` | Implemented; see limits | Read-only availability and exact price responses for 1–5 domains. Optional years 1–10; omitted uses the TLD minimum. Does not quote a binding purchase or reserve a domain. |
| `get_purchase_quote` | **Not implemented** | The official MCP issues signed, parameter-bound quotes with a 5-minute expiry and replay protection. Its issuer contract is not provided in the inspected public API. Do not invent compatible signing keys or return fake idempotency tokens. |
| `buy_pro` | **Not implemented** | No verified public contract for reproducing the official quote/confirm Pro upgrade flow. Requires billing authorization, genuine consent and recurring-charge validation. |
| `buy_credits` | **Not implemented** | A public credit-purchase API exists, but matching the official signed quote/confirm and no-double-charge guarantees requires additional verified semantics and durable replay/approval handling. Not exposed by this stateless bridge. |
| `buy_addon` | **Not implemented** | No verified public contract for the official add-on quote/confirm flow. Requires pricing/plan/quantity validation and billing consent. |
| `buy_domain` | **Not implemented** | A public domain-buy API exists, but its contract is not the official signed MCP quote flow. Requires verified durable replay/approval handling, term/price matching and safe WHOIS contact handling before implementation. |
| `get_domain_order` | Implemented; see limits | Read-only order status. purchasing is not completed. No purchase is performed. |
| `get_access_to_vercel_url` | **Not implemented** | A public protection-bypass endpoint exists, but a verified share-link response/credential-delivery contract and recipient/expiry/revocation controls have not been established here. Not exposed; existing deployment protection is never weakened. |
| `web_fetch_vercel_url` | Implemented; see limits | PUBLIC content only, not authenticated protected-page parity. Requires external-fetch opt-in, exact operator hostname allowlist, and API verification that the token can access that deployment. No credentials forwarded, no redirects, public IPv4 DNS pinning. Maximum 524288 response bytes. |
| `import-claude-design-from-url` | Implemented; see limits | Limited HTML importer. Requires explicit project name and target, writes and external-fetch opt-ins. Exact public claudeusercontent.com HTTPS host, maximum 1048576 bytes; self-contained HTML only, no asset crawling. Optional stable design ID adds a deterministic 16-hex-character suffix. Not the official project-mapping service. |
| `list_toolbar_threads` | Implemented; see limits | CLI-backed and opt-in. Default unresolved, limit 20, maximum 100; cursor instead of official offset. Retains upstream pagination. |
| `get_toolbar_thread` | Implemented; see limits | CLI-backed and opt-in. Reads thread plus one message page, default/maximum 100. messageCursor follows pagination rather than claiming all messages were retrieved. |
| `change_toolbar_thread_resolve_status` | Implemented; see limits | CLI-backed and opt-in; requires writes enabled. Uses PATCH with explicit resolved boolean. |
| `reply_to_toolbar_thread` | Implemented; see limits | CLI-backed and opt-in; requires writes enabled. Maximum 10000 Markdown characters; no retry on uncertain outcomes. |
| `edit_toolbar_message` | Implemented; see limits | CLI-backed and opt-in; requires writes enabled. Maximum 10000 Markdown characters; ownership enforced by Vercel. |
| `add_toolbar_reaction` | **Not implemented** | The inspected CLI defines reaction response data but no reaction mutation contract. Needs a verified supported endpoint and request/response fixtures; no guessed mutation is exposed. |
| `use_vercel_cli` | Implemented; see limits | Help guidance only: returns a CLI --help command and documentation link. Never executes a command, reads local files, or deploys anything. |

## Additional tools preserved or added

The 7 original extras remain: get_current_user, cancel_deployment, promote_deployment, list_project_domains, list_env_vars, create_env_var, delete_env_var.

Two additional deployment helpers:
- **deploy_from_git**: requires an existing GitHub-linked project, explicit ref and preview/production target; optional exact 40-character SHA. Uses the project's verified repository link, not arbitrary Git tokens. GitLab/Bitbucket/other providers are not implemented by this helper.
- **redeploy_deployment**: reads the original deployment, then requests a new build in that project. Explicit target required; withLatestCommit defaults false. A non-preview original cannot be redeployed as preview because the verified API inherits its target/settings; use deploy_from_git instead. This avoids silently redeploying production when preview was requested.

## Sources

- Public OpenAPI: https://openapi.vercel.sh/ ; SHA-256 of the inspected snapshot: 34dd27fa7b766c0f63221a24995390644d6363eeb46b5406782083f86a3d26bd. It was read for contracts, not blindly converted into tools.
- REST API: https://vercel.com/docs/rest-api
- Deployment creation: https://vercel.com/docs/rest-api/deployments/create-a-new-deployment
- Analytics: https://vercel.com/docs/analytics/web-analytics-api
- Vercel CLI source pinned to c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb:
  - https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/commands/comments/api.ts
  - https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/commands/comments/types.ts
  - https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/commands/agent-runs/agent-runs-api.ts
  - https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/util/logs-v2.ts
- Public documentation sitemap: https://vercel.com/docs/sitemap.md

These implementations call api.vercel.com and, for opt-in Agent Runs/runtime logs, two fixed vercel.com API paths. They never proxy requests to mcp.vercel.com, borrow another client's OAuth identity, or circumvent its redirect approval policy. Public content fetches send no Vercel credential.

## Closing the remaining gaps

Obtain supported contracts from Vercel for the blocked operations, define durable purchase approval/replay storage and protected-link delivery where required, then implement request/response and failure tests plus an explicitly authorized integration test. Existing tokens in Copilot Studio are not a substitute for a verified API contract. Do not add placeholder tools that always fail.
