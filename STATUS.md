# STATUS.md — what exists today

Living source of truth for Cold-Call Coach, and the migration spec for whatever
replaces the single-file frontend. Everything below was read out of
`index.html` and `api/` on branch `docs/claude-md-and-status` (2026-07-29).
It describes what **is**, not what was planned. Where the code and
`PHASE1-DESIGN.md` disagree, the code wins and the difference is recorded in
§6.

**Shape:** `index.html` (3,140 lines: HTML + CSS + JS, no build step) ·
`api/` = 5 serverless routes + 2 shared modules · Supabase Postgres +
private Storage · Vercel **Node** runtime.

---

## 1. API routes

Every route is a CommonJS `module.exports = async function handler(req, res)`
whose **first statement** is `if (!requireSecret(req, res)) return;`.

### `api/_auth.js` — shared, not a route

`requireSecret(req, res)` compares the `x-app-secret` request header against
`process.env.APP_SECRET` with `crypto.timingSafeEqual` (length checked first,
since `timingSafeEqual` throws on unequal buffers).

- No `APP_SECRET` set → **503** `{ error: "APP_SECRET not configured" }` —
  fail-closed, the API is never open by accident.
- Missing/wrong header → **401** `{ error: "unauthorized" }`.
- Neither the secret nor the supplied value is ever logged.

Browser side: the passphrase lives in **`sessionStorage`** only (key
`ccc_app_secret`, gone when the tab closes — never `localStorage`) and is
attached by `apiFetch()` to every call to our own routes. A 401 clears it,
re-prompts via the Unlock modal, and retries once. The signed Supabase upload
PUT does **not** carry the header.

### `api/_supabase.js` — shared, not a route

`supabaseFetch(path, options)` → PostgREST/Storage call with the service-role
key in both `apikey` and `Authorization`; non-2xx throws with Supabase's
message. `getBucket()` → `SUPABASE_RECORDINGS_BUCKET` or `"recordings"`.
`requireEnv(name)` throws `Missing <name>`. `encodeStoragePath()`
percent-encodes each path segment while keeping the `/`.

### `POST /api/create-upload`

Other methods → **405** with `Allow: POST`.

1. Inserts a `calls` row: `user_id`, `audio_path: "pending/<user_id>"`,
   `duration_seconds` (number or null), `offer_context` (string, `""` default),
   `lead_id` (string or null), `stt_provider: "deepgram"`, `status: "recorded"`.
2. PATCHes the real path in: `<user_id>/<call_id>.webm`.
3. Asks Storage for a signed upload URL, resolving Supabase's `/storage/v1`
   relative path into an absolute URL.

→ **200** `{ call_id, storage_path, signed_upload_url, token }`.
Any throw → **500** `{ error }`.

The `pending/` placeholder exists because the row id is needed to name the
object; it is why DELETE has a "skip storage" branch (below).

### `POST /api/analyze`

Other methods → **405** with `Allow: POST`. Body `{ call_id }`; missing →
**400**. Row not found → **404**.

Synchronous chain, in one request (this is why the runtime is Node):

1. `status = "transcribing"`, `error_message = null`.
2. Signs a 600s download URL for `audio_path`.
3. **Deepgram** `POST /v1/listen?model=nova-3&diarize=true&punctuate=true&smart_format=true`,
   passing `{ url }`. Word-level output is folded into turns by
   `deepgramTurns()`: consecutive words with the same `speaker` merge into one
   `{ speaker, start, end, text }`; a non-integer speaker falls back to `0`.
4. **Claude** `POST /v1/messages` (`anthropic-version: 2023-06-01`), model
   `ANTHROPIC_MODEL` or `claude-haiku-4-5`, `max_tokens: 2048`,
   `tool_choice: { type: "tool", name: "score_cold_call" }` — forced tool use,
   `strict: true`. Input is the offer context plus `Speaker N: text` lines.
   No `tool_use` block in the reply → throws "Claude did not return rubric
   scores".
5. PATCHes `transcript`, `rubric_scores`, `analysis_model`,
   `stt_provider: "deepgram"`, `status: "scored"`.

→ **200** `{ call_id, transcript, rubric_scores }`.
On any throw: the row is marked `status = "error"` with `error_message`
(best-effort, failure swallowed), then **500** `{ error }`.

### `GET /api/calls`

Two shapes, chosen by the `lead_id` query param:

- **No `lead_id`** — dashboard list, every call for the user, newest first.
  Deliberately lean select: `id, created_at, status, duration_seconds,
  rubric_scores, lead_id`. **No `transcript`** — the dashboard never needs it
  and those rows are large. Logs a count only.
- **With `lead_id`** — the lead card's Calls section, newest first:
  `id, created_at, status, rubric_scores, transcript, rep_speaker, metrics`.

→ **200** `{ calls: [...] }`. Both queries are scoped `user_id=eq.<user>`.
Neither applies a row `LIMIT` (see §7).

### `PATCH /api/calls?id=<uuid>`

Missing `id` → **400**. **Two independent writers share this route** and only
fields actually present in the body are written, so neither clobbers the
other's columns:

| Field | Writer | Accepted |
|---|---|---|
| `lead_id` | CRM attach/detach | string links; `null` or `""` detaches |
| `rep_speaker` | Coach panel | integer, or `null`; non-integer → **400** |
| `metrics` | Coach panel | object, or `null`; array/scalar → **400** |

Empty patch → **400** `{ error: "Nothing to update" }`. Row not owned by this
`user_id` → **404** `{ error: "Call not found" }`.
→ **200** `{ call: { id, lead_id, rep_speaker } }`.

This is the design doc's `save-analysis` step, folded in rather than given a
fourth function (§6).

### `DELETE /api/calls?id=<uuid>`

Deletes one call **and its recording**. Semantics, precisely:

1. **`id` must match a UUID regex** — anything else is **400**
   `{ error: "Missing or malformed call id" }` before Supabase is touched.
2. **User-scoped lookup.** `select=id,audio_path` with
   `user_id=eq.<user>`. A row owned by anyone else reads as absent → **404**
   `{ error: "Call not found" }` and is never touched. The browser cannot
   widen this by asking differently.
3. **Storage first, row second.** If Storage fails the row stays put with its
   `audio_path` intact, so the whole delete is simply retryable; dropping the
   row first would strand an object with nothing pointing at it.
4. **`pending/` → skip.** An `audio_path` starting with `pending/` (or empty)
   is the placeholder `create-upload` wrote before the real path was known —
   there is no object behind it. `storage = "skipped"`, no Storage call.
5. **Object not found counts as success.** Supabase Storage reports a missing
   object as **HTTP 400 + `{"error":"not_found"}`** — *not* a 404 — and answers
   a missing **bucket** with a byte-identical body. That response alone cannot
   tell "already cleaned up" from "pointed at the wrong bucket", so the handler
   **probes the bucket endpoint**: bucket OK → `storage = "missing"`, treated
   as success (that is the state the caller wanted); bucket absent → throws
   `Storage bucket not found`. Without the probe a config slip would silently
   drop rows whose recordings are still sitting in Storage.
6. **Storage failure aborts.** Any other Storage response → **500**
   `{ error: "Could not delete the recording. The call was kept." }`, row
   untouched. The UI re-enables the button so the user can retry.
7. Row deleted, then a counts-only log line (never the path, transcript or
   lead id).

→ **200** `{ deleted: true, storage: "deleted" | "missing" | "skipped" }`.

> Note on wording: **HTTP 404 from this route means the call row was not found**
> — that is an error for the client. It is the *Storage* not-found (a 400 body
> saying `not_found`) that is treated as success.

Other methods → **405** with `Allow: GET, PATCH, DELETE`.

### `/api/leads`

Board data. Stages: `new | no_answer | callback | interested | booked |
not_interested`. Client-writable columns are whitelisted — `name, business,
phone, email, website, industry, notes, stage, address, maps_rating, maps_url`.
`id`, `user_id`, `created_at`, `position`, `call_id` are server-controlled. An
unrecognised `stage` is dropped, not rejected.

- **GET** — all leads for the user, ordered `stage.asc, position.asc,
  created_at.asc` → `{ leads }`.
- **POST** (single) — requires non-blank `business` **and** `phone`, else
  **400**. `stage` defaults to `new`; `position = Date.now()` (large gaps, so
  midpoint reordering never collides) → `{ lead }`.
- **POST** (bulk, `{ leads: [...] }`) — **capped at 500** per call (**400**
  past that). Rows missing business or phone are skipped, not fatal; every row
  is normalised to identical columns so PostgREST accepts the heterogeneous
  batch. All valid rows dropped → **400**. → `{ leads, imported, skipped }`.
- **PATCH `?id=`** — whitelisted fields plus a finite numeric `position`; sets
  `updated_at`. Nothing to update → **400**. Not found (or not this user) →
  **404**. → `{ lead }`.
- **DELETE `?id=`** — user-scoped, idempotent → `{ ok: true }`.
- Other methods → **405** with `Allow: GET, POST, PATCH, DELETE`.

### `POST /api/scrape-leads`

Google Maps → board, via the Apify actor `compass~crawler-google-places`
(`run-sync-get-dataset-items`). Other methods → **405**.

- **No `APIFY_API_TOKEN` → 503** `{ error, code: "no_token" }`, before Apify is
  touched. The token goes in the `Authorization` header, never in a URL, and is
  never logged.
- Missing `keyword` → **400**. `location` defaults to `"Durban, South Africa"`.
- **Server-side clamp:** `maxResults` forced into **1–25** regardless of what
  the client sends. `minReviews` defaults to 5, `0` disables the filter, and is
  applied **in the mapper** — the actor has no reliable native reviews-count
  input.
- **55s `AbortController`**, under Vercel's 60s ceiling, so a hung actor
  returns **504** `{ code: "timeout" }` with a JSON body instead of a platform
  504 with none. Apify non-2xx → **502** `{ code: "apify_error" }`; the body is
  drained but its internals never reach the browser.
- Mapping: `business ← title` (no title → dropped), `phone`, `website`,
  `address`, `maps_rating ← totalScore` coerced to a real number or null,
  `maps_url ← url`. **No email is read or stored (POPIA).** A missing website
  is *not* a drop reason — no-website businesses are the wanted prospects.
- Dedupe key: normalised phone (digits, last 9, so `+27 31…` / `031…` / `31…`
  collapse) → `p:<digits>`; with no phone, `n:<name|business>|<address>`.
  Checked against everything already on the board **and** within the batch.
- → **200** `{ leads, added, skipped, scraped, belowMin }`. Log line carries
  counts only.

---

## 2. The six Hormozi scoring dimensions

Fixed list, identical in `api/analyze.js` (`DIMENSION_KEYS`), `index.html`
(`DIMENSION_LABELS`, and a second `DIMENSION_KEYS` in the dashboard):

| Key | UI label |
|---|---|
| `opener_pattern_interrupt` | Opener / pattern interrupt |
| `offer_clarity` | Offer clarity |
| `problem_tie` | Problem tie |
| `objection_handling` | Objection handling |
| `close_or_cta` | Close / CTA |
| `permission_and_framing` | Permission & framing |

**What forced tool use returns.** One tool, `score_cold_call`, `strict: true`,
`additionalProperties: false`, `tool_choice: { type: "tool" }` — so the reply
validates exactly, with no prose and no arithmetic:

```jsonc
{
  "overall_score": 3,          // integer, enum [1,2,3,4,5]
  "top_fix": "string",         // the single highest-leverage change
  "dimensions": [              // one entry per key, in the order above
    {
      "key": "opener_pattern_interrupt",  // enum, the six keys
      "score": 3,                          // integer, enum [1..5]
      "evidence": "verbatim quote",        // "" if the rep never did this
      "fix": "one concrete improvement"
    }
    // …five more
  ]
}
```

All four item fields are `required`. The system prompt states: Speaker 0 is the
rep, score **from the text alone** (tonality and prosody are out of scope),
quote verbatim, **"Do not compute any numbers."**

Model: `ANTHROPIC_MODEL`, default `claude-haiku-4-5`. The model id actually
used is persisted to `calls.analysis_model`.

---

## 3. The JS metrics contract

Everything here is plain browser JS in `index.html`. **The model never
participates.** A speaker swap recomputes instantly with no API call.

### Inputs

- `turns` — `calls.transcript`, i.e. `[{ speaker:int, start:num, end:num,
  text:str }]` as built by `deepgramTurns()`.
- `repSpeaker` — which diarized index is the rep. **Default: whoever speaks
  first** (`Number(turns[0].speaker)`) — on an outbound cold call that is the
  rep nearly always. The Swap button cycles through the distinct speakers (it
  reads "Next speaker" when 3+ voices were diarized, where "swap" is
  meaningless), disabled below 2 speakers.

`computeMetrics()` returns `null` if there are no turns or `repSpeaker` is
null/undefined.

### Outputs — `calls.metrics` (three, plus provenance)

```jsonc
{
  "version": 1,              // METRICS_VERSION — bump if the list or formulas change
  "rep_speaker": 0,
  "talk_listen": {
    "rep_seconds": 61.4,     // rounded to 1dp
    "total_seconds": 92.8,
    "rep_pct": 66            // whole percent, or null when total is 0
  },
  "longest_monologue_seconds": 18.3,
  "fillers": { "count": 12, "per_minute": 11.7 }  // per_minute null if rep spoke 0s
}
```

1. **Talk share** — `rep_seconds / total_seconds`, where both are **sums of
   turn durations** (`end - start`, floored at 0). It is a **share of SPOKEN
   time, not of call length**: silence, hold and ring time are not in the
   denominator. The UI says so on the tile ("of spoken time — 1:01 of 1:32 in
   turns, not call length"). Rendered as **whole percent with a `~` prefix and
   an ESTIMATE badge** — one mixed-mono track cannot cleanly attribute
   overlapping speech, so no decimal place is shown.
2. **Longest monologue** — the longest unbroken rep stretch. A prospect turn
   always breaks the run. Consecutive rep turns extend it; **a gap of more than
   `MONOLOGUE_GAP = 1.5s` starts a fresh run, gaps at or under 1.5s merge.**
3. **Fillers** — matches of
   `/\b(um|uh|like|you know|so|basically|literally|right)\b/gi` **in rep turns
   only**, absolute and per minute of rep speech.
   **Disclosed estimate:** this is a plain word match, so conversational "so",
   "like" and "right" inflate the count. The caveat is printed under the tiles
   in both the live and stored renderings rather than hidden. **Tightening the
   regex is deferred to the migration** — changing it means bumping
   `METRICS_VERSION` and accepting that old rows were computed differently.

### Degradation and persistence

- **Fewer than 2 distinct speakers** → all three metrics are **withheld
  loudly**: the panel prints "Diarization returned a single speaker… withheld
  for this call rather than shown wrong", and `metrics` is persisted as
  **`null`**, not noise. Transcript and rubric scores are unaffected.
- Persisted by `persistAnalysis()` → `PATCH /api/calls?id=…` with
  `{ rep_speaker, metrics }`, **debounced 500ms** so rapid swaps write once.
  Stale responses are ignored if the panel has moved to another call.
- Save failure is non-fatal and says so: *"…The metrics above are still
  correct — they're computed locally."*
- The lead card's call history uses `storedMetricsHtml()` — **formats a stored
  object only, never recomputes**; calls saved before metrics existed render
  nothing.

---

## 4. Four-states matrix (empty / loading / error / happy)

**"Verified" here means read in the source on this branch** — the states exist
in code. Runtime confirmation is the developer's (Live Server / `vercel dev` in
Chrome + a real phone); Claude Code cannot reach that server.

| Surface | Empty | Loading | Error | Happy |
|---|---|---|---|---|
| Mic / Record | ✓ "No recording yet." | ✓ `checking` state, button disabled | ✓ `insecure` / `unsupported` / `denied` (3-step fix list) / `no-device`, + Retry | ✓ `prompt` / `granted`, Record enabled |
| Recorder | ✓ hidden when idle | ✓ pulsing dot, mm:ss timer, RMS level meter | ✓ `onerror` → "Recorder error — try again." | ✓ playback + meta + Analyze enabled |
| Upload / Analyze | ✓ status line hidden | ✓ "Creating upload slot…" → "Uploading audio to private storage…" → "Transcribing & scoring… (10–60s)" | ✓ red status, hint keeps the local blob: "you can retry Analyze" | ✓ "Transcript and coaching scores ready" |
| Transcript | ✓ "No transcript yet." | ⚠ carried by the upload status line, no panel skeleton | ✓ "No transcript returned." | ✓ turns, You/Prospect labels, rep-relative colour, swap bar |
| Metrics | ✓ "No metrics yet." | ✓ save note "Saving speaker & metrics…" | ✓ single-speaker warn block; save-note error variant | ✓ 3 tiles + ESTIMATE badge + caveat |
| Scores | ✓ "Not scored yet." | ✓ shares the Analyze status line | ✓ "No scores returned." | ✓ overall tile, top fix, six dimension rows |
| Attach-to-lead combobox | ✓ "No leads match." | ✓ "Linking…" | ✓ red attach status with the server message | ✓ "Linked to <business>." |
| Leads board | ✓ per-column "Drop leads here" | ✓ six columns + 2 `.card-skeleton` each, counts render `·` not `0`, all four toolbar buttons disabled, `aria-busy` | ✓ board replaced by the error message ("run `vercel dev`…") | ✓ six stage columns with counts |
| Lead modal → Calls | ✓ "No calls yet." | ✓ "Loading calls…" | ✓ placeholder carries the error message | ✓ collapsible per-call score / metrics / transcript + Delete |
| Delete call | — | ⚠ button disabled only, no text | ✓ toast + button re-enabled for retry | ✓ "Call deleted" toast, list reloads |
| CSV import | ✓ step 2 hidden until a file is picked | ⚠ Import button disabled only, no text (parse is synchronous) | ✓ toasts: not-a-CSV guard, header-row check, per-request failure | ✓ "Imported N leads · skipped M…" |
| Find leads (Apify) | ✓ "No businesses found. Try different words or another location." | ✓ "Searching Google Maps… 30–90 seconds", button disabled against double-spend | ✓ distinct copy per `code`: `no_token`, `timeout`, generic | ✓ toast "N added, M duplicates skipped…" — **`warn`, not `ok`, when 0 added** |
| Dashboard | ✓ per-tile empties ("No calls logged yet.", "Score a call to see this.", "Not enough data yet — score at least 2 calls.") | ✓ "Loading…" | ✓ error message in place of the tiles | ✓ Activity / Funnel / Skill / Hygiene groups |
| Unlock (secret) | ✓ modal on first API call | — | ✓ "That passphrase was rejected. Try again." | ✓ stored in `sessionStorage`, retried once |

Known gaps: the three ⚠ rows above. Nothing else ships happy-path-only.

**Why the board loads the way it does.** A spinner over a blank board is
indistinguishable from "you have no leads yet", so the six columns stay put and
fill with skeleton placeholders instead, and the per-column and header counts
print `·` rather than `0` until the real number is known. The placeholders use
`.card-skeleton`, **not** `.lead-card` — the board's `pointerdown` handler keys
off `.lead-card` and would otherwise begin a drag with an undefined lead id.
`loadLeads()` also de-duplicates: opening the Leads tab, the Coach
attach-combobox and the Refresh button share one in-flight request. Refresh,
Add lead, Import CSV and Find leads are all disabled for the duration — each
one's success handler calls `renderBoard()`, which mid-load would paint
skeletons over the fresh result, and the in-flight GET (issued before the
insert) would then land last and drop the new rows.

**Dashboard honesty rules, as implemented:** rows with `status = "error"` are
excluded from activity counts (a retry after an error would double-count);
talk-time counts only calls that actually contributed a duration; conversion is
computed only along the positive path `new → callback → interested → booked`
with a "reached this stage or any later one" denominator, so a rate can never
exceed 100%; `no_answer` and `not_interested` are shown as raw counts, never
ratios; average score, trend and weakest dimension all share the same **≥2
scored calls** threshold so the group tells one consistent story.

---

## 5. Environment variables

Set in `.env` **and** `.env.local` for `vercel dev` (both git-ignored; `vercel
dev` must be restarted after a change), and in the Vercel dashboard for
production.

| Var | Used by | Notes |
|---|---|---|
| `SUPABASE_URL` | all data routes | required; `requireEnv` throws without it |
| `SUPABASE_SERVICE_ROLE_KEY` | all data routes | **server-side only — never in `index.html`** |
| `SUPABASE_RECORDINGS_BUCKET` | create-upload, analyze, calls | default `recordings` |
| `PHASE1_USER_ID` | calls, create-upload, leads, scrape-leads | default `solo`; scopes every query |
| `DEEPGRAM_API_KEY` | analyze | Nova-3 pre-recorded |
| `ANTHROPIC_API_KEY` | analyze | Messages API |
| `ANTHROPIC_MODEL` | analyze | optional; default `claude-haiku-4-5`. **Not in `.env.example`** |
| `APP_SECRET` | every route via `requireSecret` | unset → 503 everywhere (fail-closed) |
| **`APIFY_API_TOKEN`** | scrape-leads | **preserved naming inconsistency — see below** |

**The APIFY naming inconsistency (known, preserved, do not fix).** The written
spec for the lead-scraper feature calls this var `APIFY_TOKEN`. The shipped
code reads **`process.env.APIFY_API_TOKEN`** (`api/scrape-leads.js`), and
`.env.example` documents `APIFY_API_TOKEN`. The string `APIFY_TOKEN` appears
nowhere in this repo. **`APIFY_API_TOKEN` is the name to set.** Renaming either
side breaks a working deploy for cosmetics; the divergence is documented rather
than resolved.

`vercel.json` sets `maxDuration: 60` for `api/scrape-leads.js` only. Other
routes run on Vercel's default Node budget.

---

## 6. Deliberate deviations from PHASE1-DESIGN.md

1. **`save-analysis` folded into `PATCH /api/calls`.** The design doc's §9
   step 7 implied a fourth function. Instead `rep_speaker` and `metrics` are
   written through the existing calls route, which already handles
   attach/detach. Both writers patch only the fields present in their body, so
   they never clobber each other. One fewer function, one fewer auth surface.
2. **Node runtime, not Edge.** Flagged in the design doc's §1 clarification and
   still true: `analyze` awaits Deepgram then Haiku in a single request, which
   exceeds Edge's limits. Node gives the longer budget and the better SDK
   surface; keys stay server-side either way.
3. **Scope grew past Phase 1.** The design doc is explicitly "one call, end to
   end, no CRM". What shipped also includes the Leads Kanban board, CSV import,
   the Apify Google Maps scraper, the read-only Dashboard, call↔lead linking,
   call deletion, and the shared-secret lock — none of which are in that
   document.
4. **Upload has no progress percentage.** The design doc's four-states table
   promises "Progress % on PUT"; the implementation shows staged text status
   instead (a single `fetch` PUT exposes no progress events).
5. **Transcript has no skeleton loading state**, as noted in §4.
6. **`leads` table columns grew.** `SUPABASE-SETUP.md`'s `create table leads`
   predates the scraper; the code also reads and writes `address`,
   `maps_rating` and `maps_url`, and `name` had its `NOT NULL` dropped.

---

## 7. Known gaps (not bugs — recorded so the migration inherits them knowingly)

- `GET /api/leads` and `GET /api/calls` are **user-scoped but unbounded** — no
  `LIMIT`, no pagination. Fine at solo scale; the first thing to fix when call
  or lead counts grow. The convention "server-side clamps on all list
  endpoints" is currently honoured by `scrape-leads` (`maxResults` 1–25) and
  bulk import (500 rows), not by these two reads.
- The filler regex is deliberately loose; tightening it is deferred to the
  migration and requires a `METRICS_VERSION` bump (§3).
- Loading states are still thin on delete call, CSV import and the transcript
  panel — button-disabled or a borrowed status line, no dedicated text or
  skeleton (§4). The Leads board gap is closed.
- `SUPABASE-SETUP.md` lags the schema the code actually uses (§6.6).
