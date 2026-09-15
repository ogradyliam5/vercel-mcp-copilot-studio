"use strict";

// Only the JSON Schema subset used by our hand-authored tool schemas.
// Values are checked at execution time, not just advertised to an MCP host.
function validate(schema, value, path = "arguments", depth = 0) {
  const fail = (message) => { throw new Error(`Invalid ${path}: ${message}`); };
  if (depth > 30) fail("too deeply nested");
  if (schema.anyOf || schema.oneOf) {
    const matches = (schema.anyOf || schema.oneOf).filter((s) => {
      try { validate(s, value, path, depth + 1); return true; } catch { return false; }
    }).length;
    if (!matches || (schema.oneOf && matches !== 1)) fail("does not match an allowed schema");
  }
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, entry] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) fail("unsafe property");
      if (Object.hasOwn(schema.properties || {}, key)) validate(schema.properties[key], entry, `${path}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) fail(`unknown property ${key}`);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) fail("expected an array");
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? 1000)) fail("invalid array length");
    if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) fail("duplicate items");
    for (const entry of value) validate(schema.items || {}, entry, `${path}[]`, depth + 1);
  } else if (type === "string") {
    if (typeof value !== "string") fail("expected a string");
    if (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? 16384)) fail("invalid string length");
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail("invalid format");
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) fail(`expected a finite ${type}`);
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail("outside allowed range");
  } else if (type === "boolean" && typeof value !== "boolean") fail("expected a boolean");
  if (schema.enum && !schema.enum.includes(value)) fail("unsupported value");
}

function segment(value) {
  if (typeof value !== "string" || !value.trim() || value === "." || value === ".." || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid resource identifier");
  return encodeURIComponent(value);
}
function timestamp(value, now = Date.now()) {
  if (value === "now") return now;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid timestamp");
    return value;
  }
  const relative = /^(\d+)(m|h|d)$/.exec(value);
  const result = relative ? now - Number(relative[1]) * { m: 60000, h: 3600000, d: 86400000 }[relative[2]]
    : /^\d{10}$/.test(value) ? Number(value) * 1000
    : /^\d{13}$/.test(value) ? Number(value) : /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(result) || result < 0) throw new Error("Invalid time: use an ISO date, timestamp, or duration such as 1h");
  return result;
}
function range(since, until, defaultDuration = 86400000, maxDuration = 90 * 86400000) {
  const now = Date.now();
  const from = since === undefined ? now - defaultDuration : timestamp(since, now);
  const to = until === undefined ? now : timestamp(until, now);
  if (from > to || to > now + 60000 || to - from > maxDuration) throw new Error("Invalid or excessive time range");
  return { from, to };
}
module.exports = { validate, segment, timestamp, range };
