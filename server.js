"use strict";

/**
 * Standalone Node.js HTTP server (zero dependencies).
 * Use this to self-host the MCP server anywhere Node 18+ runs
 * (container, VM, Azure App Service, etc.).
 *
 *   node server.js            # listens on PORT (default 3000), endpoint /mcp
 */

const http = require("http");
const { handleHttp } = require("./lib/mcp");

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "vercel-mcp", endpoint: "/mcp" }));
    return;
  }

  if (url.pathname !== "/mcp" && url.pathname !== "/api/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. MCP endpoint is POST /mcp" }));
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const result = await handleHttp({ method: req.method, headers: req.headers, body });
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: e.message } }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`vercel-mcp listening on http://localhost:${PORT}/mcp`);
});
