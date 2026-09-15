"use strict";

const crypto = require("node:crypto");
const { publicText, parsePublicUrl } = require("./public-fetch");
const { vercelFetch } = require("./vercel-api");
const { segment } = require("./validation");
const { add, str, integer, enumeration, checkFiles, deployed } = require("./extended-tools");

add("search_vercel_documentation", "Keyword-search Vercel's public documentation index. Returns matching index entries and links, not Vercel's proprietary semantic search or full document contents.", {
  topic: str("Documentation topic", 256), tokens: integer(100, 10000, "Result budget hint; bounded as 4 characters per token, default 2500"),
}, ["topic"], async (_token, a) => {
  const result = await publicText("https://vercel.com/docs/sitemap.md", (host) => host === "vercel.com", 4 * 1024 * 1024);
  const words = [...new Set(a.topic.toLowerCase().match(/[a-z0-9-]+/g) || [])];
  if (!words.length) throw new Error("Use at least one searchable word");
  const matches = result.text.split("\n").filter((line) => /\]\(/.test(line))
    .map((line) => ({ line, score: words.filter((word) => line.toLowerCase().includes(word)).length }))
    .filter((entry) => entry.score).sort((a, b) => b.score - a.score);
  const budget = (a.tokens ?? 2500) * 4;
  const text = matches.slice(0, 20).map((entry) => entry.line.replace(/\]\((\/docs[^)]*)\)/g, "](https://vercel.com$1)")).join("\n");
  return { source: "https://vercel.com/docs/sitemap.md", searchType: "keyword index", text: text.slice(0, budget),
    truncated: matches.length > 20 || text.length > budget, matchingEntries: matches.length };
});

add("web_fetch_vercel_url", "Fetch a public, owned Vercel deployment's text. Operator must allow the exact hostname and external fetching. Does not create access links or bypass Deployment Protection.", {
  url: str("HTTPS deployment URL without credentials", 2048), teamId: str("Owning team ID or slug"),
}, ["url"], async (token, a) => {
  const hosts = (process.env.VERCEL_MCP_FETCH_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean);
  const u = parsePublicUrl(a.url, (host) => hosts.includes(host));
  // Validate ownership with the API before any request to the deployment host.
  const d = await vercelFetch(token, "GET", `/v13/deployments/${segment(u.hostname)}`, { teamId: a.teamId });
  if (!d.id || (d.url !== u.hostname && !(d.alias || []).includes(u.hostname))) throw new Error("URL was not verified as an owned deployment");
  return publicText(u.href, (host) => host === u.hostname, 512 * 1024);
}, { externalFetch: true });

add("import-claude-design-from-url", "Import a self-contained public Claude Design HTML bundle as index.html. Explicit name/target and external-fetch/write opt-ins required. Never executes content on this server.", {
  url: str("Public HTTPS claudeusercontent.com bundle URL", 2048), name: { ...str("Vercel project name", 100), pattern: "^[a-z0-9][a-z0-9._-]*$" },
  target: enumeration(["preview", "production"], "Explicit target"), teamId: str("Owning team"),
  title: str("Optional design title"), claude_design_project_id: str("Optional stable identifier; added as a deterministic name suffix"),
}, ["url", "name", "target"], async (token, a) => {
  const page = await publicText(a.url, (host) => host === "claudeusercontent.com", 1024 * 1024);
  if (!/<!doctype html|<html[\s>]/i.test(page.text)) throw new Error("Design must be a self-contained HTML document");
  const files = [{ file: "index.html", data: page.text, encoding: "utf-8" }];
  checkFiles(files);
  const suffix = a.claude_design_project_id ? "-" + crypto.createHash("sha256").update(a.claude_design_project_id).digest("hex").slice(0, 16) : "";
  if (a.name.length + suffix.length > 100) throw new Error("Project name plus stable suffix exceeds 100 characters");
  return deployed(await vercelFetch(token, "POST", "/v13/deployments", { teamId: a.teamId }, {
    name: a.name + suffix, files, ...(a.title ? { meta: { designTitle: a.title } } : {}), ...(a.target === "production" ? { target: "production" } : {}),
  }));
}, { write: true, externalFetch: true });
