const { encodeStoragePath, getBucket, requireEnv, supabaseFetch } = require("./_supabase");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  // Vercel's Node runtime pre-parses JSON bodies into req.body; only fall back
  // to reading the raw stream when it hasn't (e.g. plain `node` / other hosts).
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// The six fixed Hormozi cold-calling dimensions (PHASE1-DESIGN §5a).
const DIMENSION_KEYS = [
  "opener_pattern_interrupt",
  "offer_clarity",
  "problem_tie",
  "objection_handling",
  "close_or_cta",
  "permission_and_framing",
];

// Forced tool-use schema. strict:true guarantees the JSON validates exactly —
// no prose, no arithmetic, only 1–5 judgments + evidence quotes (§5a).
const RUBRIC_TOOL = {
  name: "score_cold_call",
  description:
    "Record Hormozi cold-calling rubric scores for this call. Score every dimension from text alone; never compute numbers.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      overall_score: {
        type: "integer",
        enum: [1, 2, 3, 4, 5],
        description: "Overall call quality, 1 (poor) to 5 (excellent).",
      },
      top_fix: {
        type: "string",
        description: "The single highest-leverage change the rep should make.",
      },
      dimensions: {
        type: "array",
        description:
          "Exactly one entry per dimension key, in this order: " +
          DIMENSION_KEYS.join(", ") + ".",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string", enum: DIMENSION_KEYS },
            score: {
              type: "integer",
              enum: [1, 2, 3, 4, 5],
              description: "1 (poor) to 5 (excellent) for this dimension.",
            },
            evidence: {
              type: "string",
              description:
                "A short verbatim quote from the transcript that justifies the score, or an empty string if the rep never did this.",
            },
            fix: {
              type: "string",
              description: "One concrete, specific improvement for this dimension.",
            },
          },
          required: ["key", "score", "evidence", "fix"],
        },
      },
    },
    required: ["overall_score", "top_fix", "dimensions"],
  },
};

const RUBRIC_SYSTEM =
  "You are a cold-calling coach grading a rep against Alex Hormozi's principles. " +
  "You are given a diarized transcript (Speaker 0 is the rep, other speakers are the prospect) " +
  "and the rep's current offer. Score each dimension from the text alone — tonality and prosody " +
  "are out of scope. Pull evidence quotes verbatim from the transcript. Do not compute any numbers; " +
  "only give 1–5 judgments, quotes, and one concrete fix per dimension. Call the score_cold_call tool.";

function transcriptToText(turns) {
  return turns
    .map((t) => `Speaker ${t.speaker}: ${t.text}`)
    .join("\n");
}

async function scoreRubric(turns, offerContext) {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

  const offer = offerContext && offerContext.trim()
    ? offerContext.trim()
    : "(No offer context provided.)";
  const userText =
    `Offer being sold on this call:\n${offer}\n\n` +
    `Diarized transcript:\n${transcriptToText(turns)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: RUBRIC_SYSTEM,
      tools: [RUBRIC_TOOL],
      tool_choice: { type: "tool", name: "score_cold_call" },
      messages: [{ role: "user", content: userText }],
    }),
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = (json.error && json.error.message) || `Claude failed: ${res.status}`;
    throw new Error(message);
  }

  const toolUse = (json.content || []).find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return rubric scores");

  return { rubricScores: toolUse.input, analysisModel: json.model || model };
}

function deepgramTurns(result) {
  const words = result.results?.channels?.[0]?.alternatives?.[0]?.words || [];
  const turns = [];

  for (const word of words) {
    const speaker = Number.isInteger(word.speaker) ? word.speaker : 0;
    const text = word.punctuated_word || word.word || "";
    if (!text) continue;

    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) {
      last.text += " " + text;
      last.end = word.end;
    } else {
      turns.push({
        speaker,
        start: word.start || 0,
        end: word.end || word.start || 0,
        text,
      });
    }
  }

  return turns;
}

async function markError(callId, message) {
  await supabaseFetch(`/rest/v1/calls?id=eq.${encodeURIComponent(callId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", prefer: "return=minimal" },
    body: JSON.stringify({ status: "error", error_message: message }),
  }).catch(() => {});
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return json(res, 405, { error: "Method not allowed" });
  }

  let callId = "";
  try {
    const payload = await readJson(req);
    callId = typeof payload.call_id === "string" ? payload.call_id : "";
    if (!callId) return json(res, 400, { error: "Missing call_id" });

    const rows = await supabaseFetch(
      `/rest/v1/calls?id=eq.${encodeURIComponent(callId)}&select=id,audio_path,offer_context`
    );
    const call = rows && rows[0];
    if (!call) return json(res, 404, { error: "Call not found" });

    await supabaseFetch(`/rest/v1/calls?id=eq.${encodeURIComponent(callId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", prefer: "return=minimal" },
      body: JSON.stringify({ status: "transcribing", error_message: null }),
    });

    const bucket = getBucket();
    const signedDownload = await supabaseFetch(
      `/storage/v1/object/sign/${bucket}/${encodeStoragePath(call.audio_path)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: 600 }),
      }
    );

    const supabaseUrl = requireEnv("SUPABASE_URL").replace(/\/$/, "");
    const signedPath = signedDownload.signedURL || signedDownload.signedUrl || signedDownload.url;
    if (!signedPath) throw new Error("Could not create audio download URL");
    // signedPath is relative to /storage/v1 (e.g. "/object/sign/...") — make it absolute.
    const audioUrl = signedPath.startsWith("http")
      ? signedPath
      : `${supabaseUrl}/storage/v1${signedPath}`;

    const deepgramKey = requireEnv("DEEPGRAM_API_KEY");
    const deepgramUrl = "https://api.deepgram.com/v1/listen?model=nova-3&diarize=true&punctuate=true&smart_format=true";
    const dgRes = await fetch(deepgramUrl, {
      method: "POST",
      headers: {
        authorization: `Token ${deepgramKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: audioUrl }),
    });
    const dgText = await dgRes.text();
    const dgJson = dgText ? JSON.parse(dgText) : {};
    if (!dgRes.ok) {
      const message = dgJson.err_msg || dgJson.message || dgJson.error || `Deepgram failed: ${dgRes.status}`;
      throw new Error(message);
    }

    const transcript = deepgramTurns(dgJson);

    // Claude Haiku forced tool-use → rubric JSON (§5a). No arithmetic here.
    const { rubricScores, analysisModel } = await scoreRubric(
      transcript,
      call.offer_context
    );

    await supabaseFetch(`/rest/v1/calls?id=eq.${encodeURIComponent(callId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", prefer: "return=minimal" },
      body: JSON.stringify({
        transcript,
        rubric_scores: rubricScores,
        analysis_model: analysisModel,
        stt_provider: "deepgram",
        status: "scored",
      }),
    });

    return json(res, 200, { call_id: callId, transcript, rubric_scores: rubricScores });
  } catch (err) {
    if (callId) await markError(callId, err.message || "Analyze failed");
    return json(res, 500, { error: err.message || "Analyze failed" });
  }
};
