"use strict";

/**
 * Vercel Serverless Function entry point.
 * Exposes the MCP server at POST /api/mcp (also routed from /mcp via vercel.json).
 */

const { handleHttp } = require("../lib/mcp");

module.exports = async function handler(req, res) {
  // Read raw body (Vercel may have already parsed JSON bodies).
  let body = req.body;
  if (body === undefined) {
    body = await new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
    });
  }

  const result = await handleHttp({
    method: req.method,
    headers: req.headers,
    body,
  });

  res.statusCode = result.status;
  for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  res.end(result.body);
};
