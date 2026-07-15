const DEFAULT_BUCKET = "recordings";
const DEFAULT_USER_ID = "solo";
const { encodeStoragePath, requireEnv, supabaseFetch } = require("./_supabase");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    let payload;
    if (req.body !== undefined && req.body !== null) {
      // Vercel's Node runtime already parsed the JSON body for us.
      payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    }

    const bucket = process.env.SUPABASE_RECORDINGS_BUCKET || DEFAULT_BUCKET;
    const userId = process.env.PHASE1_USER_ID || DEFAULT_USER_ID;
    const durationSeconds = Number.isFinite(Number(payload.duration_seconds))
      ? Number(payload.duration_seconds)
      : null;
    const offerContext = typeof payload.offer_context === "string" ? payload.offer_context : "";

    const inserted = await supabaseFetch("/rest/v1/calls?select=id,audio_path", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: "return=representation",
      },
      body: JSON.stringify({
        user_id: userId,
        audio_path: `pending/${userId}`,
        duration_seconds: durationSeconds,
        offer_context: offerContext,
        stt_provider: "deepgram",
        status: "recorded",
      }),
    });

    const callId = inserted[0].id;
    const storagePath = `${userId}/${callId}.webm`;

    await supabaseFetch(`/rest/v1/calls?id=eq.${callId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({ audio_path: storagePath }),
    });

    const encodedPath = encodeStoragePath(storagePath);
    const signed = await supabaseFetch(
      `/storage/v1/object/upload/sign/${bucket}/${encodedPath}`,
      { method: "POST" }
    );

    // Supabase returns a path relative to /storage/v1 (e.g. "/object/upload/sign/...").
    // Turn it into an absolute URL so the browser PUTs to Supabase, not back to us.
    const supabaseUrl = requireEnv("SUPABASE_URL").replace(/\/$/, "");
    const signedPath = signed.url || signed.signedURL || signed.signedUrl;
    if (!signedPath) throw new Error("Supabase did not return a signed upload URL");
    const signedUploadUrl = signedPath.startsWith("http")
      ? signedPath
      : `${supabaseUrl}/storage/v1${signedPath}`;

    return json(res, 200, {
      call_id: callId,
      storage_path: storagePath,
      signed_upload_url: signedUploadUrl,
      token: signed.token,
    });
  } catch (err) {
    return json(res, 500, { error: err.message || "Could not create upload" });
  }
};
