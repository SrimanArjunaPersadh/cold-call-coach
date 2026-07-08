// Bake-off: AssemblyAI diarization (PHASE1-DESIGN §The Assignment)
// Usage:  ASSEMBLYAI_API_KEY=xxxx node bake-off/assemblyai.mjs path/to/call.webm
// Judge ONE thing: does it cleanly split YOU from the PROSPECT on the mixed-mono track?
// AssemblyAI is a 3-step flow: upload -> create transcript -> poll.
import { readFile } from "node:fs/promises";

const key = process.env.ASSEMBLYAI_API_KEY;
const file = process.argv[2];
if (!key || !file) {
  console.error("Usage: ASSEMBLYAI_API_KEY=xxxx node bake-off/assemblyai.mjs <audio-file>");
  process.exit(1);
}
const H = { Authorization: key };
const t0 = Date.now();

// 1) Upload the raw bytes -> upload_url
const up = await fetch("https://api.assemblyai.com/v2/upload", {
  method: "POST",
  headers: { ...H, "Content-Type": "application/octet-stream" },
  body: await readFile(file),
});
if (!up.ok) { console.error(`upload ${up.status}: ${await up.text()}`); process.exit(1); }
const { upload_url } = await up.json();

// 2) Create a diarized transcript job
const create = await fetch("https://api.assemblyai.com/v2/transcript", {
  method: "POST",
  headers: { ...H, "Content-Type": "application/json" },
  body: JSON.stringify({ audio_url: upload_url, speaker_labels: true }),
});
if (!create.ok) { console.error(`create ${create.status}: ${await create.text()}`); process.exit(1); }
const { id } = await create.json();

// 3) Poll until completed / error
let job;
for (;;) {
  const r = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, { headers: H });
  job = await r.json();
  if (job.status === "completed" || job.status === "error") break;
  process.stdout.write(".");
  await new Promise((res) => setTimeout(res, 3000));
}
if (job.status === "error") { console.error(`\nAssemblyAI error: ${job.error}`); process.exit(1); }

const turns = (job.utterances ?? []).map((u) => ({
  speaker: u.speaker, start: u.start / 1000, end: u.end / 1000, text: u.text,
}));
const speakers = new Set(turns.map((t) => t.speaker));
console.log(`\n\n=== AssemblyAI ===  (${((Date.now() - t0) / 1000).toFixed(1)}s, ${speakers.size} speaker(s), ${turns.length} turns)\n`);
for (const t of turns) {
  console.log(`[Speaker ${t.speaker}] ${t.start.toFixed(1)}–${t.end.toFixed(1)}s  ${t.text}`);
}
if (speakers.size < 2) console.log("\n⚠️  Only one speaker detected — diarization failed on this track (Risk #1).");
