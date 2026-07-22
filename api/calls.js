const { requireEnv, supabaseFetch } = require("./_supabase");
const { requireSecret } = require("./_auth");

const DEFAULT_USER_ID = "solo";

// Read + link calls for the CRM. GET lists a lead's calls (Calls section on the
// lead card); PATCH sets/clears a call's lead_id (fallback "Attach to lead" and
// its detach). Scoring/transcription live in analyze.js and are untouched here.

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

function getQuery(req, key) {
  if (req.query && req.query[key]) return String(req.query[key]);
  try {
    return new URL(req.url, "http://localhost").searchParams.get(key) || "";
  } catch (_) {
    return "";
  }
}

module.exports = async function handler(req, res) {
  if (!requireSecret(req, res)) return;

  const userId = process.env.PHASE1_USER_ID || DEFAULT_USER_ID;

  try {
    // Fail fast with a clear message if Supabase env is missing.
    requireEnv("SUPABASE_URL");

    if (req.method === "GET") {
      const leadId = getQuery(req, "lead_id");
      if (!leadId) return json(res, 400, { error: "Missing lead_id" });
      const rows = await supabaseFetch(
        `/rest/v1/calls?user_id=eq.${encodeURIComponent(userId)}` +
          `&lead_id=eq.${encodeURIComponent(leadId)}` +
          `&select=id,created_at,status,rubric_scores,transcript` +
          `&order=created_at.desc`
      );
      return json(res, 200, { calls: rows || [] });
    }

    if (req.method === "PATCH") {
      const id = getQuery(req, "id");
      if (!id) return json(res, 400, { error: "Missing call id" });

      const payload = await readJson(req);
      if (payload.lead_id === undefined) {
        return json(res, 400, { error: "Nothing to update" });
      }
      // A string links the call; null/"" detaches it.
      const leadId =
        payload.lead_id === null || payload.lead_id === "" ? null : String(payload.lead_id);

      const updated = await supabaseFetch(
        `/rest/v1/calls?id=eq.${encodeURIComponent(id)}` +
          `&user_id=eq.${encodeURIComponent(userId)}&select=id,lead_id`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            prefer: "return=representation",
          },
          body: JSON.stringify({ lead_id: leadId }),
        }
      );
      if (!updated || !updated.length) {
        return json(res, 404, { error: "Call not found" });
      }
      return json(res, 200, { call: updated[0] });
    }

    res.setHeader("allow", "GET, PATCH");
    return json(res, 405, { error: "Method not allowed" });
  } catch (err) {
    return json(res, 500, { error: err.message || "Calls request failed" });
  }
};
