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

      // No lead_id → Dashboard list of every call for this user. Lean select
      // (no transcript — the dashboard never needs it, and rows can be large):
      // just what the deterministic metrics compute over (§ dashboard).
      if (!leadId) {
        const rows = await supabaseFetch(
          `/rest/v1/calls?user_id=eq.${encodeURIComponent(userId)}` +
            `&select=id,created_at,status,duration_seconds,rubric_scores,lead_id` +
            `&order=created_at.desc`
        );
        // Counts-only logging — never transcripts, scores, or lead identifiers.
        console.log(`[calls] dashboard list: ${(rows || []).length} calls`);
        return json(res, 200, { calls: rows || [] });
      }

      const rows = await supabaseFetch(
        `/rest/v1/calls?user_id=eq.${encodeURIComponent(userId)}` +
          `&lead_id=eq.${encodeURIComponent(leadId)}` +
          `&select=id,created_at,status,rubric_scores,transcript,rep_speaker` +
          `&order=created_at.desc`
      );
      return json(res, 200, { calls: rows || [] });
    }

    if (req.method === "PATCH") {
      const id = getQuery(req, "id");
      if (!id) return json(res, 400, { error: "Missing call id" });

      const payload = await readJson(req);

      // Two independent writers share this route: the CRM's attach/detach
      // (lead_id) and the Coach panel's rep-speaker + metrics save — the design
      // doc's "save-analysis" step, folded in here rather than a fourth
      // function. Only fields actually present in the body are written, so
      // neither writer clobbers the other's columns.
      const patch = {};

      if (payload.lead_id !== undefined) {
        // A string links the call; null/"" detaches it.
        patch.lead_id =
          payload.lead_id === null || payload.lead_id === "" ? null : String(payload.lead_id);
      }

      if (payload.rep_speaker !== undefined) {
        const rep = payload.rep_speaker === null ? null : Number(payload.rep_speaker);
        if (rep !== null && !Number.isInteger(rep)) {
          return json(res, 400, { error: "rep_speaker must be an integer" });
        }
        patch.rep_speaker = rep;
      }

      if (payload.metrics !== undefined) {
        // Computed in the browser from the diarized turns (the model never does
        // this arithmetic). null when diarization returned under 2 speakers.
        const metrics = payload.metrics;
        if (metrics !== null && (typeof metrics !== "object" || Array.isArray(metrics))) {
          return json(res, 400, { error: "metrics must be an object or null" });
        }
        patch.metrics = metrics;
      }

      if (!Object.keys(patch).length) {
        return json(res, 400, { error: "Nothing to update" });
      }

      const updated = await supabaseFetch(
        `/rest/v1/calls?id=eq.${encodeURIComponent(id)}` +
          `&user_id=eq.${encodeURIComponent(userId)}&select=id,lead_id,rep_speaker`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            prefer: "return=representation",
          },
          body: JSON.stringify(patch),
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
