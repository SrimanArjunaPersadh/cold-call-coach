# CLAUDE.md — Cold-Call Coach

Working notes for Claude Code sessions in this repo. For what the app actually
does, route by route, read **STATUS.md** — it is the living source of truth.
**PHASE1-DESIGN.md is superseded**: historical record only.

---

## Stack

- **Frontend:** one vanilla `index.html` (3,140 lines — HTML + CSS + JS in a
  single file). No React, no framework, no build step, no bundler, no
  `package.json`, no `node_modules`. Edit the file directly.
- **Backend:** `api/` — 5 Vercel serverless routes (`analyze`, `calls`,
  `create-upload`, `leads`, `scrape-leads`) plus 2 shared underscore-prefixed
  modules (`_auth.js`, `_supabase.js`, not deployed as routes). CommonJS
  (`require` / `module.exports`).
- **Data:** Supabase — Postgres (`calls`, `leads`) + a **private** Storage
  bucket `recordings`. All access is server-side with the service-role key.
- **External:** Deepgram Nova-3 (diarized STT), Anthropic Messages API
  (Claude Haiku, forced tool use), Apify (Google Maps lead scraper).
- **Runtime: Node, NOT Edge — deliberate.** The analyze route awaits Deepgram
  then Haiku in one request; that chain exceeds Edge's limits and needs Node's
  extended `maxDuration` and SDK surface. Keys stay server-side either way.
  Do not "modernise" a handler onto Edge.

## Hard rules

1. **Metrics are computed in browser JS from diarized turns. The model NEVER
   does arithmetic.** Claude returns 1–5 judgments, evidence quotes and fixes —
   nothing it had to calculate. Talk share, longest monologue and filler counts
   come from `computeMetrics()` in `index.html`. Never move a number into the
   prompt or the tool schema.
2. **`requireSecret(req, res)` is line one of every handler**, before any work,
   any parsing, any env read:
   ```js
   module.exports = async function handler(req, res) {
     if (!requireSecret(req, res)) return;
   ```
   It **fails closed**: no `APP_SECRET` configured → 503 for everyone, never
   open. A new route without it is a security bug, not a style nit.
3. **One feature per branch.** Branch off `main`, one concern, then a PR.
4. **Manual git only. Never `/ship`.** Do not commit, push, merge or open PRs
   unless the developer asks in that turn. Hand over the exact commands instead.
5. **`/review` before every commit.**
6. **`APIFY_TOKEN` (spec) vs `APIFY_API_TOKEN` (code) is a KNOWN, PRESERVED
   inconsistency — do not "fix" it.** `api/scrape-leads.js` reads
   `process.env.APIFY_API_TOKEN`; that is the name to set in `.env`, `.env.local`
   and the Vercel dashboard. Renaming either side breaks a working deploy for
   cosmetics.

## Code delivery standard

Every change ships with all three, in this order:

- **(a) The change** — the actual edit, complete, not a sketch.
- **(b) Exact test/verify steps** — what to click, in which view, and what a
  pass looks like. Name the surface and the expected string.
- **(c) Exact git commands** — copy-pasteable `git checkout -b …`, `git add`,
  `git commit -m "…"`, `git push -u origin …`. The developer runs them.

## Conventions

- **Dropdown / menu items select on `onmousedown` + `preventDefault()`**, never
  on `click` — the click would otherwise blur the input and close the menu
  first. See `setupLeadCombo()` in `index.html`.
- **Four states on every surface: empty / loading / error / happy.** No surface
  ships with only the happy path. STATUS.md tracks which surfaces have all four
  today and where the gaps are.
- **44px minimum touch targets.** Enforced globally under
  `@media (pointer: coarse)`; keep new controls inside that rule or give them
  their own `min-height`.
- **Server-side clamps on list endpoints.** Never trust a client-sent count.
  Existing clamps: `maxResults` 1–25 in `scrape-leads`, 500-row cap on bulk
  lead import. Every query is additionally scoped to `user_id` server-side, so
  a request cannot widen its own reach.
- **Errors are user-facing sentences**, not statuses. Supabase/Apify internals
  never reach the browser; logs carry counts and outcomes only, never
  transcripts, phone numbers, lead identifiers or storage paths.
- **Optimistic UI reverts on failure** (see `persistMove`): apply, call, and on
  error restore the previous value and toast.

## Verification

**Claude Code cannot reach the developer's local server.** There is no
`vercel dev` here, no browser, no Supabase credentials in this session — so no
change can be confirmed working from inside a session.

- The developer tests on **Live Server / `vercel dev` in Chrome plus a real
  phone** (touch drag on the Kanban board, 44px targets).
- Note that `/api/*` routes exist only under `vercel dev` or a deploy. Opening
  `index.html` from a plain static server 404s them into an HTML page; the app
  already detects that and says "run `vercel dev`, not a static server".
- **Always state what to verify and how**, and say plainly that you have not
  run it. Never write "tested", "verified" or "confirmed working" about
  anything that only ran in your head.
