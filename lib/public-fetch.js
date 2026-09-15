"use strict";

const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");

function publicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 2, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
}
function parsePublicUrl(input, approved) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || net.isIP(url.hostname) || !approved(url.hostname)) throw new Error("URL is not an approved HTTPS host");
  if ([...url.searchParams.keys()].some((k) => /token|secret|password|signature|authorization|bypass|^sig$/i.test(k))) throw new Error("Credential-bearing URLs are not accepted");
  return url;
}
// DNS is checked and then pinned into the TLS request. Never send Vercel tokens,
// cookies or proxy headers to a deployment/design/documentation host. No redirects.
async function publicText(input, approved, maxBytes = 1024 * 1024) {
  const url = parsePublicUrl(input, approved);
  let dnsTimer;
  let addresses;
  try {
    addresses = await Promise.race([dns.lookup(url.hostname, { all: true, family: 4 }),
      new Promise((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error("DNS lookup timed out")), 5000); })]);
  } finally { clearTimeout(dnsTimer); }
  if (!addresses.length || addresses.some((a) => !publicIPv4(a.address))) throw new Error("Host does not resolve exclusively to public IPv4 addresses");
  const address = addresses[0].address;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const req = https.get(url, {
      headers: { Accept: "text/markdown, text/plain, text/html, application/json" },
      lookup: (_host, options, callback) => callback(null, options.all ? [{ address, family: 4 }] : address, options.all ? undefined : 4),
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); finish(new Error(`Public fetch rejected (HTTP ${res.statusCode}); redirects and protected pages are not followed`)); req.destroy(); return; }
      const type = String(res.headers["content-type"] || "");
      if (!/^(text\/|application\/json)/i.test(type)) { res.resume(); finish(new Error("Public fetch requires text content")); req.destroy(); return; }
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { finish(new Error("Public content exceeds size limit")); req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on("end", () => finish(null, { url: url.href, contentType: type, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", () => finish(new Error("Public response interrupted")));
    });
    const timer = setTimeout(() => { finish(new Error("Public fetch timed out")); req.destroy(); }, 15000);
    req.on("error", () => finish(new Error("Public fetch failed")));
  });
}
module.exports = { publicText, parsePublicUrl, publicIPv4 };
