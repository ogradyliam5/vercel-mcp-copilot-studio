"use strict";

const API = "https://api.vercel.com";
const CLI_PATHS = new Set(["/api/logs/request-logs", "/api/observability/agent-runs"]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20000;

function redact(text, token) {
  let result = String(text);
  if (token) result = result.split(token).join("[redacted]");
  return result.replace(/\b(?:vcp|vca|vcr)_[A-Za-z0-9_-]+\b/g, "[redacted]");
}
async function readLimited(response, limit = MAX_RESPONSE_BYTES) {
  if (Number(response.headers.get("content-length")) > limit) {
    if (response.body) await response.body.cancel();
    throw new Error("Upstream response exceeds the size limit; narrow the query");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("Upstream response exceeds the size limit; narrow the query");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}

// The origin is selected by code, never by a tool argument. No redirects and no
// automatic retries: a timed-out write may already have committed upstream.
async function request(token, method, path, query, body, origin = API) {
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\\]/.test(path)) throw new Error("Invalid API path");
  const url = new URL(origin + path);
  if (url.origin !== API && !(url.origin === "https://vercel.com" && CLI_PATHS.has(url.pathname) && method === "GET")) throw new Error("Disallowed API endpoint");
  if (typeof token !== "string" || !token || /\s/.test(token)) throw new Error("Invalid Vercel access token format");
  if (origin === API && path.startsWith("/v") && query?.teamId && !query.teamId.startsWith("team_")) {
    query = { ...query, slug: query.teamId, teamId: undefined };
  }
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error", signal: controller.signal,
    });
    const text = await readLimited(response);
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Non-JSON response from Vercel (HTTP ${response.status})`); }
    if (!response.ok) {
      const error = new Error(redact(data?.error?.message || data?.error?.code || `Request failed`, token).slice(0, 1000));
      error.status = response.status;
      if (response.status === 429) error.message += "; rate limited: wait before retrying";
      throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(method === "GET" ? "Vercel request timed out" : "Vercel request timed out; outcome unknown. Inspect state before retrying the write.");
    if (error instanceof TypeError) throw new Error(method === "GET" ? "Vercel connection failed" : "Vercel connection failed; outcome unknown. Inspect state before retrying the write.");
    throw error;
  } finally { clearTimeout(timer); }
}
const vercelFetch = (token, method, path, query, body) => request(token, method, path, query, body);
const dashboardFetch = (token, path, query) => request(token, "GET", path, query, undefined, "https://vercel.com");
module.exports = { vercelFetch, dashboardFetch, readLimited, redact, TIMEOUT_MS, MAX_RESPONSE_BYTES };
