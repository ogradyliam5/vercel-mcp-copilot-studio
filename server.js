"use strict";

const http = require("node:http");
const { serveMcp } = require("./lib/http");
function createServer() {
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/" || path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, service: "vercel-mcp", endpoint: "/mcp" }));
    } else if (path === "/mcp" || path === "/api/mcp") {
      serveMcp(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. MCP endpoint is POST /mcp" }));
    }
  });
  server.maxConnections = 128;
  return server;
}
if (require.main === module) {
  const server = createServer();
  server.listen(process.env.PORT || 3000, () => console.log(`vercel-mcp listening on port ${server.address().port}`));
}
module.exports = { createServer };
