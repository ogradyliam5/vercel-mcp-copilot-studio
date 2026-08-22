"use strict";

/**
 * Minimal Vercel REST API client (zero dependencies).
 * Docs: https://vercel.com/docs/rest-api
 */

const VERCEL_API_BASE = "https://api.vercel.com";

/**
 * Perform a request against the Vercel REST API.
 * @param {string} token   Vercel access token
 * @param {string} method  HTTP method
 * @param {string} path    API path beginning with /
 * @param {object} [query] Optional query string params (null/undefined skipped)
 * @param {object} [body]  Optional JSON body
 */
async function vercelFetch(token, method, path, query, body) {
  const url = new URL(VERCEL_API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      (data && data.error && (data.error.message || data.error.code)) ||
      `Vercel API error (HTTP ${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

module.exports = { vercelFetch };
