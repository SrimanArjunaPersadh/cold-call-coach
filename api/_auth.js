const crypto = require("crypto");

// Shared-secret gate for a single-user tool on a public URL. Every API route
// calls requireSecret() before doing any work. Fails CLOSED: if APP_SECRET is
// not configured we refuse all requests rather than serving open. The secret
// and the incoming header value are never logged.

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

// Constant-time compare. crypto.timingSafeEqual requires equal-length buffers,
// so a length mismatch is a definite fail (checked before the compare).
function secretsMatch(provided, expected) {
  const a = Buffer.from(String(provided), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Returns true if the request may proceed. On failure it writes the response
// (503 when unconfigured, 401 otherwise) and returns false — callers do:
//   if (!requireSecret(req, res)) return;
function requireSecret(req, res) {
  const expected = process.env.APP_SECRET;
  if (!expected) {
    json(res, 503, { error: "APP_SECRET not configured" });
    return false;
  }
  const provided = req.headers["x-app-secret"];
  if (typeof provided !== "string" || !secretsMatch(provided, expected)) {
    json(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

module.exports = { requireSecret };
