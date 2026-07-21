# Supabase Setup

## Storage

Create a private bucket named:

```text
recordings
```

## Table

Run this in the Supabase SQL editor:

```sql
create table calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id text not null,
  audio_path text not null,
  duration_seconds numeric,
  offer_context text,
  transcript jsonb,
  rep_speaker int,
  rubric_scores jsonb,
  metrics jsonb,
  stt_provider text,
  analysis_model text,
  status text not null default 'recorded',
  error_message text
);
```

## Leads table (CRM)

Run this in the Supabase SQL editor. Backs the Kanban board (`/api/leads`).
`stage` is the board column: `new | no_answer | callback | interested | booked | not_interested`.

```sql
create table leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id text not null,
  stage text not null default 'new',
  name text,
  business text,
  phone text,
  email text,
  website text,
  industry text,
  notes text,
  position numeric,
  call_id uuid
);

create index leads_user_stage_idx on leads (user_id, stage, position);
```

Business + phone are required by the app (form + import); contact name is optional.

**Already created the leads table?** Contact name used to be `NOT NULL`. Run this once so
name-less leads can be saved (the removed columns can stay — they're just unused):

```sql
alter table leads alter column name drop not null;
```

## Environment

Copy `.env.example` for local Vercel dev, then fill in:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_RECORDINGS_BUCKET
PHASE1_USER_ID
DEEPGRAM_API_KEY
ANTHROPIC_API_KEY
APP_SECRET
```

> **Where `vercel dev` reads these:** this project is linked to a Vercel
> project (`.vercel/`), and `vercel dev` picks up local vars from **`.env`**.
> Keep `.env` and `.env.local` in sync — put every var in **both** (they are
> both git-ignored). A var added to only one of them may not reach the running
> functions, and `vercel dev` must be **restarted** after any change.

`APP_SECRET` is the shared passphrase that gates every `/api` route (sent by the
browser as the `x-app-secret` header). If it is unset on the server, the API
fails closed (503) — set it locally (in `.env` / `.env.local`, restart
`vercel dev`) and in the Vercel dashboard for production (then redeploy).

Never put the service role key in `index.html` or any browser code.

## Local Testing

The recording screen can run on a plain static server.

The upload and transcript buttons need Vercel functions, so run the app with:

```powershell
vercel dev
```

Then open the local URL that Vercel prints.
