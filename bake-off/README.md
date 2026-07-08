# Task 0 — STT diarization bake-off

Settles decision **#1** (STT provider) with evidence, and stress-tests **Risk #1**
(mixed-mono diarization) on day one. Judge **one thing only**: how cleanly does each
provider split *your* voice from the *prospect's* on a single mixed-mono track?

## 0. Get a recording first

You don't have a call recorded yet. For the bake-off, any real two-party cold call works —
you don't need the Chrome recorder built yet. Easiest path:

- iPhone on **speakerphone**, record with the **Voice Memos** app during a real call, or
- record the laptop side later once task 3's recorder exists.

Export/AirDrop it to this machine. `.m4a` (Voice Memos), `.webm`, `.mp3`, and `.wav` all work.

## 1. Get free API keys (no card required)

- **Deepgram** — $200 free credit: https://console.deepgram.com/signup → create an API key
- **AssemblyAI** — $50 free credit: https://www.assemblyai.com/dashboard/signup → copy the API key

## 2. Run both against the same file

The key is passed via an env var — it is never stored in the repo.

```sh
# Deepgram (Nova-3, one request)
DEEPGRAM_API_KEY=xxxxx node bake-off/deepgram.mjs ./my-call.m4a

# AssemblyAI (upload -> transcribe -> poll)
ASSEMBLYAI_API_KEY=xxxxx node bake-off/assemblyai.mjs ./my-call.m4a
```

On PowerShell, set the var first:

```powershell
$env:DEEPGRAM_API_KEY="xxxxx"; node bake-off/deepgram.mjs .\my-call.m4a
```

Requires Node 18+ (uses built-in `fetch`). No `npm install` needed.

## 3. What to look for

Each script prints diarized turns as `[Speaker N] start–end  text` plus a speaker count.
Compare the two outputs on **your** accent, **your** phone, **your** room:

- Are there exactly **2 speakers**, not 1 (merged) or 5 (over-split)?
- Do the turns actually match who said what — is *your* opener attributed to one speaker
  and the prospect's replies to the other?
- A `⚠️ Only one speaker detected` line means diarization failed on that track.

Keep the winner and lock it into `calls.stt_provider`. If **both** struggle to split the
mixed-mono track, that's Risk #1 firing early — the §8.1 graceful-degradation path
(show transcript + call-level rubric, flag the estimate loudly) becomes load-bearing.

These scripts are throwaway — once the winner is chosen, `/api/analyze` (task 5) calls
the provider server-side with the key in a Vercel env var, never in the browser.
