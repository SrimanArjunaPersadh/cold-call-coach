const DEFAULT_BUCKET = "recordings";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function getBucket() {
  return process.env.SUPABASE_RECORDINGS_BUCKET || DEFAULT_BUCKET;
}

async function supabaseFetch(path, options = {}) {
  const url = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = body && (body.message || body.error || body.msg);
    throw new Error(message || `Supabase request failed: ${res.status}`);
  }
  return body;
}

function encodeStoragePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

module.exports = { encodeStoragePath, getBucket, requireEnv, supabaseFetch };
