"use strict";

const { handleHttp, MAX_REQUEST_BYTES } = require("./mcp");
let active = 0;
function readBody(req) {
  if (req.body !== undefined) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => { finish(Object.assign(new Error("Request timed out"), { status: 408 })); req.resume(); }, 15000);
    req.on("data", (chunk) => {
      if (done) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_REQUEST_BYTES) { finish(Object.assign(new Error("Request body too large"), { status: 413 })); return; }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
    req.on("aborted", () => finish(Object.assign(new Error("Request aborted"), { status: 400 })));
    req.on("error", () => finish(Object.assign(new Error("Request interrupted"), { status: 400 })));
  });
}
async function serveMcp(req, res) {
  const failure = (status, message) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify({ error: message })); };
  if (active >= 16) { req.resume(); return failure(503, "Server busy; retry later"); }
  active++;
  try {
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const result = await handleHttp({ method: req.method, headers: req.headers, body });
    res.statusCode = result.status;
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    res.end(result.body);
  } catch (e) { failure(e.status || 500, e.status ? e.message : "Internal server error"); }
  finally { active--; }
}
module.exports = { serveMcp, readBody };
