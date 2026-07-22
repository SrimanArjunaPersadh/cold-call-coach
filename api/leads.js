const { requireEnv, supabaseFetch } = require("./_supabase");
const { requireSecret } = require("./_auth");

const DEFAULT_USER_ID = "solo";

// Kanban columns = pipeline stages. The five call outcomes plus a "new" intake
// lane. Dragging a card between columns just PATCHes `stage`.
const STAGES = [
  "new",
  "no_answer",
  "callback",
  "interested",
  "booked",
  "not_interested",
];

// Whitelist of lead columns the client may write. Everything else (id,
// user_id, created_at, position, call_id) is server-controlled.
const LEAD_FIELDS = [
  "name",
  "business",
  "phone",
  "email",
  "website",
  "industry",
  "notes",
  "stage",
  "address",
  "maps_rating",
  "maps_url",
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  // Vercel's Node runtime pre-parses JSON into req.body; only read the raw
  // stream when it hasn't (matches api/analyze.js).
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function getId(req) {
  if (req.query && req.query.id) return String(req.query.id);
  try {
    return new URL(req.url, "http://localhost").searchParams.get("id") || "";
  } catch (_) {
    return "";
  }
}

// Keep only whitelisted fields, coerce to string|null, drop invalid stages.
function pickFields(payload) {
  const out = {};
  for (const key of LEAD_FIELDS) {
    if (payload[key] === undefined) continue;
    if (payload[key] === null || payload[key] === "") {
      out[key] = null;
    } else {
      out[key] = String(payload[key]);
    }
  }
  if (out.stage !== undefined && !STAGES.includes(out.stage)) delete out.stage;
  return out;
}

module.exports = async function handler(req, res) {
  if (!requireSecret(req, res)) return;

  const userId = process.env.PHASE1_USER_ID || DEFAULT_USER_ID;

  try {
    // Fail fast with a clear message if Supabase env is missing.
    requireEnv("SUPABASE_URL");

    if (req.method === "GET") {
      const rows = await supabaseFetch(
        `/rest/v1/leads?user_id=eq.${encodeURIComponent(userId)}` +
          `&order=stage.asc,position.asc,created_at.asc`
      );
      return json(res, 200, { leads: rows || [] });
    }

    if (req.method === "POST") {
      const payload = await readJson(req);

      // Bulk import: { leads: [...] } → one array insert. Rows are normalised
      // to identical columns so PostgREST accepts the heterogeneous batch.
      if (Array.isArray(payload.leads)) {
        if (payload.leads.length > 500) {
          return json(res, 400, { error: "Import is capped at 500 leads at a time" });
        }
        const now = Date.now();
        const rows = [];
        let skipped = 0;
        payload.leads.forEach((raw, i) => {
          const f = pickFields(raw || {});
          if (!f.business || !f.business.trim() || !f.phone || !f.phone.trim()) {
            skipped++;
            return;
          }
          const row = { user_id: userId, position: now + i };
          for (const key of LEAD_FIELDS) row[key] = f[key] !== undefined ? f[key] : null;
          if (!row.stage) row.stage = "new";
          rows.push(row);
        });
        if (!rows.length) {
          return json(res, 400, {
            error: "No valid leads to import (each row needs a name)",
          });
        }
        const inserted = await supabaseFetch("/rest/v1/leads?select=*", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            prefer: "return=representation",
          },
          body: JSON.stringify(rows),
        });
        return json(res, 200, {
          leads: inserted || [],
          imported: (inserted || []).length,
          skipped,
        });
      }

      const fields = pickFields(payload);
      if (!fields.business || !fields.business.trim() || !fields.phone || !fields.phone.trim()) {
        return json(res, 400, { error: "Business and phone are required" });
      }
      if (!fields.stage) fields.stage = "new";

      const inserted = await supabaseFetch("/rest/v1/leads?select=*", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          prefer: "return=representation",
        },
        body: JSON.stringify({
          ...fields,
          user_id: userId,
          position: Date.now(), // large gaps → midpoint reordering never collides
        }),
      });
      return json(res, 200, { lead: inserted[0] });
    }

    if (req.method === "PATCH") {
      const id = getId(req);
      if (!id) return json(res, 400, { error: "Missing lead id" });

      const payload = await readJson(req);
      const fields = pickFields(payload);
      if (
        payload.position !== undefined &&
        Number.isFinite(Number(payload.position))
      ) {
        fields.position = Number(payload.position);
      }
      if (!Object.keys(fields).length) {
        return json(res, 400, { error: "Nothing to update" });
      }
      fields.updated_at = new Date().toISOString();

      const updated = await supabaseFetch(
        `/rest/v1/leads?id=eq.${encodeURIComponent(id)}` +
          `&user_id=eq.${encodeURIComponent(userId)}&select=*`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            prefer: "return=representation",
          },
          body: JSON.stringify(fields),
        }
      );
      if (!updated || !updated.length) {
        return json(res, 404, { error: "Lead not found" });
      }
      return json(res, 200, { lead: updated[0] });
    }

    if (req.method === "DELETE") {
      const id = getId(req);
      if (!id) return json(res, 400, { error: "Missing lead id" });
      await supabaseFetch(
        `/rest/v1/leads?id=eq.${encodeURIComponent(id)}` +
          `&user_id=eq.${encodeURIComponent(userId)}`,
        { method: "DELETE", headers: { prefer: "return=minimal" } }
      );
      return json(res, 200, { ok: true });
    }

    res.setHeader("allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: "Method not allowed" });
  } catch (err) {
    return json(res, 500, { error: err.message || "Leads request failed" });
  }
};
