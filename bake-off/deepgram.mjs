// Bake-off: Deepgram Nova-3 pre-recorded diarization (PHASE1-DESIGN §The Assignment)
// Usage:  DEEPGRAM_API_KEY=xxxx node bake-off/deepgram.mjs path/to/call.webm
// Judge ONE thing: does it cleanly split YOU (Speaker 0) from the PROSPECT?
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const key = process.env.DEEPGRAM_API_KEY;
const file = process.argv[2];
if (!key || !file) {
  console.error("Usage: DEEPGRAM_API_KEY=xxxx node bake-off/deepgram.mjs <audio-file>");
  process.exit(1);
}

const MIME = { ".webm": "audio/webm", ".m4a": "audio/mp4", ".mp4": "audio/mp4",
               ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg" };
const contentType = MIME[extname(file).toLowerCase()] || "application/octet-stream";
const audio = await readFile(file);

// Nova-3, diarized, smart-formatted. Diarization is included on pre-recorded.
const url = "https://api.deepgram.com/v1/listen?model=nova-3&diarize=true&punctuate=true&smart_format=true";
const t0 = Date.now();
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Token ${key}`, "Content-Type": contentType },
  body: audio,
});
if (!res.ok) {
  console.error(`Deepgram ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const json = await res.json();

// Group consecutive words by speaker into turns.
const words = json.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
const turns = [];
for (const w of words) {
  const spk = w.speaker ?? 0;
  const text = w.punctuated_word ?? w.word;
  const last = turns[turns.length - 1];
  if (last && last.speaker === spk) { last.text += " " + text; last.end = w.end; }
  else turns.push({ speaker: spk, start: w.start, end: w.end, text });
}

const speakers = new Set(turns.map((t) => t.speaker));
console.log(`\n=== Deepgram Nova-3 ===  (${((Date.now() - t0) / 1000).toFixed(1)}s, ${speakers.size} speaker(s), ${turns.length} turns)\n`);
for (const t of turns) {
  console.log(`[Speaker ${t.speaker}] ${t.start.toFixed(1)}–${t.end.toFixed(1)}s  ${t.text}`);
}
if (speakers.size < 2) console.log("\n⚠️  Only one speaker detected — diarization failed on this track (Risk #1).");
