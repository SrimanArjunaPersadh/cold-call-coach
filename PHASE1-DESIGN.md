# Cold-Call Coach — Phase 1 Design Doc

**Goal of this phase:** prove the full loop on ONE real call, end to end.
Record → upload → diarized transcript → Claude scores a fixed rubric → store → display.
No CRM, no multi-call views, no VoIP, no React. One vanilla `index.html`.

**Owner:** solo (you). **Status:** design agreed → ready to build. **Date:** 2026-07-08.

---

## 1. Locked decisions (for the record — not relitigated)

- **Capture:** iPhone on speakerphone; laptop Chrome records via `MediaRecorder`. Single mixed-mono track. No VoIP, no native iOS recorder.
- **Frontend:** single vanilla `index.html`. React/Next deferred to CRM phase.
- **Backend:** Supabase (audio in Storage + one `calls` table). Vercel functions hold all secret keys. Never a key in the browser.
- **Transcription:** a diarizing STT API. **Analysis:** Claude Haiku, forced tool-use JSON.
- **Metrics** (talk:listen, longest monologue, filler count): computed in **JS from diarized turns**. The model does NOT do arithmetic.
- **Legal:** RICA one-party = legal to record your own calls. Inject a "recording for training" line as good practice; audio stays private to you.
- **Test flow:** Live Server → Vercel. Record/test in Chrome only.

**One runtime clarification (honoring the intent, not changing the stance):** the pipeline function runs on Vercel's **Node serverless runtime** with an extended `maxDuration`, not the true **Edge** runtime. An awaited Deepgram + Haiku chain exceeds Edge's tighter limits; Node gives a 60–300s budget and better SDKs. Keys still live only server-side. If you specifically meant the Edge *runtime* (not just "server-side"), flag it and we adjust.

---

## 2. Resolved open decisions

### #1 — STT provider → **Deepgram (Nova-3)**, settled by a call-#1 bake-off
- **$200 free credit, no card** (vs AssemblyAI's $50, also no card). Diarization included on pre-recorded.
- Accepts Chrome's `webm/opus` blob directly. No transcoding.
- Pre-recorded endpoint returns **diarized JSON with word-level speaker labels + timestamps in the HTTP response** — this is what makes the synchronous flow and the JS metrics clean.
- Neither vendor publishes South-African-accent diarization benchmarks. So the truthful answer to "which is better for SA English" is **measure it**: run your first real recorded call through both free tiers, compare speaker separation on the mixed-mono track, keep the winner. Each is ~10 lines to call. (See The Assignment.)
- Provider is stored per-call (`stt_provider`) so a later switch is auditable.

### #2 — Async UX → **synchronous single request** *(your call)*
Browser hands the function a call reference; the function awaits Deepgram, then awaits Haiku, then returns the full result. Loading state while it works. No status table, no poll loop. Works because Deepgram returns in-response and a 5–10 min call finishes inside the Node function budget. Polling/webhooks become worth it only once calls get long enough to need a real background worker — that's Phase 2.

### #3 — Rep-speaker identity → **default first speaker = rep, one-click swap**
On an outbound cold call you speak first ("Hi, is this…?"), so `Speaker 0 = rep` is correct ~95% of the time. A "swap speakers" toggle in the UI fixes the rest instantly. Zero extra model calls, fully deterministic. Chosen over asking Haiku to infer the rep (which can silently flip and corrupt every per-speaker metric).

### #4 — `calls` table + storage path → see §4.

### #5 — `offer_context` → **per-call snapshot on the row, pre-filled from a localStorage default**
What you sell changes over time; the score must reflect the offer *as it was on that call*. So the actual string is persisted in `calls.offer_context`. A `localStorage` "default offer" pre-fills the field so you don't retype it each call. It's injected into the Haiku prompt so the rubric can score "did I state the offer clearly / tie it to their problem."

### #6 — Mic-permission-denied flow → designed first, see §6.

---

## 3. Architecture & data flow

```
[Chrome] record (MediaRecorder, webm/opus, mono)
   │  webm blob
   ▼
1) POST /api/create-upload            (Node serverless)
   → insert calls row (status='recorded')
   → mint signed Storage upload URL (Supabase service key)
   ← { call_id, signed_upload_url, storage_path }
   │
2) PUT blob → signed_upload_url        (browser → Supabase Storage direct)
   │  (bypasses Vercel's ~4.5MB function body limit — see Risks)
   ▼
3) POST /api/analyze { call_id }       (Node serverless, synchronous)
   → signed download URL for the audio
   → Deepgram pre-recorded (await) → diarized turns JSON
   → Claude Haiku forced tool-use (await) → rubric JSON
   → update calls row (transcript, rubric_scores, status='scored')
   ← { transcript, rubric_scores }
   │
4) [browser] render transcript + scores
   → user confirms / swaps rep speaker
   → compute metrics in JS from diarized turns
   ▼
5) PATCH /api/save-analysis { call_id, rep_speaker, metrics }
   → persist rep_speaker + metrics (status stays 'scored')
```

Three tiny functions: `create-upload`, `analyze`, `save-analysis`. All secret keys (Supabase service role, Deepgram, Anthropic) live only inside these. Browser holds none.

**Why upload direct to Storage (step 2) instead of POSTing bytes through the function:** Vercel serverless request bodies cap around **4.5 MB**; a 10-minute mono `webm/opus` recording can exceed that. Signed-upload-URL sidesteps the limit and also persists the audio *before* analysis, so a scoring error never costs you the recording — you just retry `/api/analyze`.

---

## 4. Data model

### Storage
- Bucket: `recordings` (private).
- Path convention: `recordings/{user_id}/{call_id}.webm`.
  - MVP is solo, but namespacing under `user_id` now makes multi-user + RLS free later. Use a fixed `user_id` constant for Phase 1.

### `calls` table
```sql
create table calls (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  user_id          text not null,                 -- fixed constant for Phase 1
  audio_path       text not null,                 -- recordings/{user_id}/{id}.webm
  duration_seconds numeric,                        -- from MediaRecorder, persisted client-side
  offer_context    text,                           -- snapshot of what you were selling
  transcript       jsonb,                          -- [{speaker:int, start:num, end:num, text:str}]
  rep_speaker      int,                            -- which diarized label is the rep (after tag)
  rubric_scores    jsonb,                          -- Haiku forced-tool-use output (§5)
  metrics          jsonb,                          -- computed in JS (§5): talk:listen, monologue, fillers
  stt_provider     text,                           -- 'deepgram' | 'assemblyai'
  analysis_model   text,                           -- e.g. 'claude-haiku-4-5-20251001'
  status           text not null default 'recorded', -- recorded | transcribing | scored | error
  error_message    text
);
```
`status` earns its place even in the synchronous flow: it's how the UI renders the **error** state distinctly from a call that scored fine.

---

## 5. The two analysis outputs (kept strictly separate)

### 5a. Qualitative rubric — Claude Haiku, forced tool-use (NO arithmetic)
Haiku is handed the diarized transcript + `offer_context` and forced to call one tool. It scores Hormozi cold-calling principles, each with an **evidence quote** pulled from the transcript and **one concrete fix**. Representative contract (your drafted schema slots in here):

```json
{
  "overall_score": 1,                     // 1-5
  "top_fix": "string",                    // the single highest-leverage change
  "dimensions": [
    { "key": "opener_pattern_interrupt", "score": 3, "evidence": "quote", "fix": "…" },
    { "key": "offer_clarity",            "score": 2, "evidence": "quote", "fix": "…" },
    { "key": "problem_tie",              "score": 4, "evidence": "quote", "fix": "…" },
    { "key": "objection_handling",       "score": 2, "evidence": "quote", "fix": "…" },
    { "key": "close_or_cta",             "score": 1, "evidence": "quote", "fix": "…" },
    { "key": "permission_and_framing",   "score": 3, "evidence": "quote", "fix": "…" }
  ]
}
```
**Prosody/tonality is out of scope this phase** (no audio-feature analysis), so every dimension must be inferable from text alone. Haiku returns **no numbers it had to compute** — only 1–5 judgments and quotes.

### 5b. Quantitative metrics — JS, in the browser, from diarized turns
- **Talk:listen ratio** = `rep_speech_seconds / total_speech_seconds`. **Labelled an ESTIMATE in the UI** — mixed-mono can't perfectly attribute overlaps, so no false precision (e.g. show "~68% you" not "68.4%").
- **Longest monologue** = longest run of consecutive rep turns with no prospect turn breaking it (gaps under ~1.5s merged).
- **Filler count** = matches of `\b(um|uh|like|you know|so|basically|literally|right)\b` in rep turns, per minute and absolute.
All derived from `transcript[]` after `rep_speaker` is confirmed. Recomputed instantly if you swap speakers.

---

## 6. Mic-permission state machine (the #1 failure path — built first)

Before showing a Record button, pre-check with `navigator.permissions.query({name:'microphone'})` where supported, then branch:

| State | Trigger | UI |
|---|---|---|
| **insecure-context** | `!window.isSecureContext` | Blocking banner: "Recording needs https or localhost. You're on `{origin}`." Record disabled. (Catches any non–Live-Server/Vercel test.) |
| **unsupported** | no `MediaRecorder` / Safari | "Use Chrome to record — MediaRecorder is unreliable here." |
| **prompt** | permission = `prompt` | "Click Record, then Allow the mic prompt." |
| **granted** | permission = `granted` | Record enabled. |
| **denied** | `getUserMedia` throws `NotAllowedError` | Recovery card: "Mic blocked. Click the 🔒 icon in the address bar → Site settings → Microphone → Allow → reload." **Retry** button. |
| **no-device** | `NotFoundError` | "No microphone found. Plug one in / check system sound settings." **Retry** button. |

Plus a pre-record nudge (not enforced): ☐ "I said 'this call is recorded for training.'" — the RICA good-practice line.

---

## 7. Every feature, four states (empty / loading / error / happy)

| Feature | Empty | Loading | Error | Happy |
|---|---|---|---|---|
| Record | "No recording yet" + mic-state banner | Recording timer + level meter | Mic denied/no-device cards (§6) | Blob ready, "Analyze" enabled |
| Upload | — | Progress % on PUT | "Upload failed — Retry" (audio not lost) | Stored, `call_id` known |
| Analyze | — | "Transcribing & scoring… (10–60s)" spinner | `status='error'` → error_message + Retry | transcript + scores returned |
| Transcript | "No transcript" | skeleton lines | "Diarization returned 1 speaker" fallback (§8) | diarized turns, speaker colors, swap toggle |
| Scores | "Not scored yet" | skeleton | "Scoring failed — Retry" | rubric cards + metrics (talk:listen labelled *estimate*) |

---

## 8. Risks (ranked)

1. **Mixed-mono diarization quality — the whole loop depends on it.** Two voices through one phone speaker, far end compressed, room echo. If Deepgram can't cleanly split you from the prospect, talk:listen / monologue / per-speaker scoring all degrade. **Mitigations:** (a) validate on the *very first* real call (the bake-off); (b) **degrade gracefully** — if diarization returns 1 speaker or obvious garbage, still show the transcript and the call-level rubric dimensions that don't need a speaker split, and surface the estimate caveat loudly. Design assumes this can fail.
2. **Function timeout on long calls (synchronous flow).** Addressed by Node runtime + extended `maxDuration`, and by keeping Phase-1 test calls short. The upgrade path (Deepgram webhook + poll) is documented and deferred.
3. **Vercel body-size limit.** Solved by the signed-upload-URL pattern (§3).
4. **Audio format.** Chrome emits `webm/opus`; Deepgram ingests it directly — confirm on call #1.

---

## 9. Task breakdown (build order)

0. **Bake-off (do this first, it settles #1 with data):** record one real call, POST it to both Deepgram and AssemblyAI free tiers, eyeball diarization on your accent, lock the winner into `stt_provider`.
1. Supabase: create `recordings` bucket + `calls` table (§4).
2. `index.html` shell + mic-permission state machine (§6) — the failure path before the happy path.
3. Record → webm blob + duration + level meter, Chrome-gated.
4. `/api/create-upload` (row insert + signed upload URL) → browser PUT to Storage.
5. `/api/analyze`: signed download URL → Deepgram (diarized) → Haiku (forced tool-use rubric) → persist → return.
6. Render: transcript with speaker colors + rep swap toggle; rubric cards; metrics computed in JS (talk:listen *estimate* label).
7. `/api/save-analysis`: persist `rep_speaker` + `metrics`.
8. Wire all four states per feature (§7). Graceful diarization-failure fallback (§8.1).
9. Live Server pass → deploy to Vercel → real-call test.

---

## 10. Out of scope this phase
CRM shell, VoIP upgrade, React migration, multi-user, POPIA hardening, audio-prosody/tonality analysis, polling/webhook async, multi-call views.

---

## The Assignment

**Before writing any pipeline code:** record one real cold call (iPhone speakerphone → Chrome), and run that single audio file through **both** Deepgram and AssemblyAI free tiers (both give you no-card credit). Look at one thing only: **how cleanly does each separate your voice from the prospect's on the mixed-mono track?** That answer — on your accent, your phone, your room — decides #1 with evidence instead of my guess, and it stress-tests Risk #1 (the thing the entire loop rests on) on day one.
