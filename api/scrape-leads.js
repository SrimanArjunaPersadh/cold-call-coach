const { requireEnv, supabaseFetch } = require("./_supabase");
const { requireSecret } = require("./_auth");

const DEFAULT_USER_ID = "solo";
const DEFAULT_LOCATION = "Durban, South Africa";
// compass/crawler-google-places, run synchronously and return the dataset rows
// in one call. The token goes in the Authorization header — never in this URL.
const APIFY_ENDPOINT =
  "https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items";
// Abort before Vercel's 60s function ceiling so a hung actor returns a clean
// timeout instead of a platform 504 with no JSON body.
const TIMEOUT_MS = 55000;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  // Vercel's Node runtime pre-parses JSON into req.body; only read the raw
  // stream when it hasn't (matches api/leads.js).
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// Phone → digits only, keep the last 9 significant digits so SA numbers written
// as +27 31…, 031…, or 31… all collapse to the same dedupe key. Empty when the
// value has no digits at all.
function normPhone(v) {
  const digits = String(v || "").replace(/\D/g, "");
  return digits.length > 9 ? digits.slice(-9) : digits;
}

// Loose text key for the no-phone fallback identity.
function normText(v) {
  return String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// A lead's dedupe key: normalized phone first; with no phone, fall back to
// (name || business) + address. Returns "" for a lead with no usable identity.
function dedupeKey(lead) {
  const phone = normPhone(lead.phone);
  if (phone) return "p:" + phone;
  const id = normText(lead.name || lead.business) + "|" + normText(lead.address);
  return id === "|" ? "" : "n:" + id;
}

module.exports = async function handler(req, res) {
  if (!requireSecret(req, res)) return;

  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return json(res, 405, { error: "Method not allowed" });
  }

  // No token → refuse before touching Apify. Token is read here only; it is
  // never logged and never placed in a URL.
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    return json(res, 503, {
      error: "Lead search isn't configured (missing Apify token).",
      code: "no_token",
    });
  }

  const userId = process.env.PHASE1_USER_ID || DEFAULT_USER_ID;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    requireEnv("SUPABASE_URL");

    const payload = await readJson(req);
    const keyword = typeof payload.keyword === "string" ? payload.keyword.trim() : "";
    if (!keyword) return json(res, 400, { error: "A search keyword is required" });
    const location =
      typeof payload.location === "string" && payload.location.trim()
        ? payload.location.trim()
        : DEFAULT_LOCATION;
    // Server-side clamp regardless of what the client sends.
    const maxResults = Math.min(Math.max(1, Number(payload.maxResults) || 10), 25);
    // Minimum review count. Defaults to 5 when missing/invalid; 0 disables the
    // filter. The actor has no reliable native reviews-count input (only
    // placeMinimumStars / skipClosedPlaces), so we filter in the mapper below.
    const rawMin = Number(payload.minReviews);
    const minReviews = Number.isFinite(rawMin) && rawMin >= 0 ? Math.floor(rawMin) : 5;

    let apifyRes;
    try {
      apifyRes = await fetch(APIFY_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          searchStringsArray: [keyword],
          locationQuery: location,
          maxCrawledPlacesPerSearch: maxResults,
          language: "en",
        }),
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        return json(res, 504, {
          error: "Search timed out. Try a narrower search or fewer results.",
          code: "timeout",
        });
      }
      throw err;
    }

    if (!apifyRes.ok) {
      // Drain the body so the socket frees, but don't surface Apify internals.
      await apifyRes.text().catch(() => {});
      return json(res, 502, {
        error: "Google Maps search failed. Please try again.",
        code: "apify_error",
      });
    }

    const items = await apifyRes.json().catch(() => []);
    const scraped = Array.isArray(items) ? items.length : 0;

    // Map to our columns. business ← title. NO email is read or stored (POPIA).
    // maps_rating is coerced to a real number or null here — never a raw value.
    // maps_url ← the actor's `url` (absolute Google Maps link). A missing website
    // is NOT a drop reason — no-website businesses are wanted (badge on the card).
    const candidates = [];
    let belowMin = 0;
    for (const it of Array.isArray(items) ? items : []) {
      const business = it && typeof it.title === "string" ? it.title.trim() : "";
      if (!business) continue; // a place with no name is unusable
      // reviewsCount missing → treat as 0, so a below-minimum place is dropped.
      const reviews = Number.isFinite(Number(it.reviewsCount)) ? Number(it.reviewsCount) : 0;
      if (reviews < minReviews) {
        belowMin++;
        continue;
      }
      candidates.push({
        business,
        phone: it.phone ? String(it.phone).trim() : null,
        website: it.website ? String(it.website).trim() : null,
        address: it.address ? String(it.address).trim() : null,
        maps_rating: Number.isFinite(Number(it.totalScore)) ? Number(it.totalScore) : null,
        maps_url: it.url ? String(it.url).trim() : null,
      });
    }

    // Dedupe against everything already on the board, then within this batch.
    const existing = await supabaseFetch(
      `/rest/v1/leads?user_id=eq.${encodeURIComponent(userId)}` +
        `&select=phone,name,business,address`
    );
    const seen = new Set();
    for (const l of existing || []) {
      const k = dedupeKey(l);
      if (k) seen.add(k);
    }

    const now = Date.now();
    const rows = [];
    let skipped = 0;
    for (const c of candidates) {
      const k = dedupeKey(c);
      if (k && seen.has(k)) {
        skipped++;
        continue;
      }
      if (k) seen.add(k); // also dedupe within this same batch
      rows.push({
        user_id: userId,
        position: now + rows.length, // large gaps → midpoint reordering later
        name: c.business, // leads.name is NOT NULL; use the Maps title (same as business)
        business: c.business,
        phone: c.phone,
        email: null,
        website: c.website,
        industry: null,
        notes: null,
        address: c.address,
        maps_rating: c.maps_rating,
        maps_url: c.maps_url,
        stage: "new",
      });
    }

    let inserted = [];
    if (rows.length) {
      inserted = await supabaseFetch("/rest/v1/leads?select=*", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          prefer: "return=representation",
        },
        body: JSON.stringify(rows),
      });
    }

    const added = (inserted || []).length;
    // Counts only — never any lead data.
    console.log(
      `scrape-leads: scraped=${scraped} added=${added} skipped=${skipped} belowMin=${belowMin}`
    );
    return json(res, 200, { leads: inserted || [], added, skipped, scraped, belowMin });
  } catch (err) {
    return json(res, 500, { error: err.message || "Lead search failed" });
  } finally {
    clearTimeout(timer);
  }
};
