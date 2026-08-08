# Prompt: take kakeibo public

Paste everything below this line into a fresh Claude Code session in this repo,
or just say: **"Read docs/public-launch-prompt.md and start."**

---

## Mission

Turn kakeibo from a local, single-user dev tool into a **public, free-to-use
website with user accounts**, and overhaul the UI to premium quality. Work in
phases; finish and verify each phase before moving on.

First, read `README.md`, `docs/kakeibo_spec.md`, and `CLAUDE.md`. The web app is
`apps/web` (Next.js 15, React 19, Tailwind 4). Today it has three pages — chat
(`/`), trace viewer (`/runs`), evals report (`/evals`) — in a dark monospace
terminal aesthetic, with a single global session and no auth.

This mission **deliberately supersedes** the spec's "Not built, on purpose:
no accounts or multi-tenancy" — that was right for the portfolio phase and the
owner has decided to go public. Update `docs/kakeibo_spec.md` to record the new
direction when Phase 3 starts. Every other CLAUDE.md rule still holds:
no AI co-author trailers in commits, money stays integer minor units, README
numbers must be measured, secrets never in git, no agent frameworks in core.

Skills for this work are installed in `.claude/skills/` (project-level). Use
them at the step they're named for.

## Phase 1 — Scope (one session, no code)

Run `/brainstorming` to pin down, then `/writing-plans` to turn into a plan:

- Who lands on this site and what do they see before signing up?
- Auth: recommend **Better Auth** (Drizzle adapter; repo already uses
  Drizzle + Postgres). Email/password + Google OAuth.
- Free-tier economics: the owner pays for every Gemini call (~$0.01/task
  measured). Decide per-user daily message quota, Flash-tier model for free
  users, and whether to offer bring-your-own-key.
- Hosting: Vercel + Neon (or Supabase) Postgres. The prod DB must be a
  **separate database from anything `pnpm eval` can reach** — eval runs
  truncate and reseed.
- Privacy: users will upload real bank statements. Data deletion, a privacy
  page, and no real statement data ever in git (`data/private/` rule).

## Phase 2 — UI overhaul (local, before auth)

1. `/impeccable` — audit the three existing pages first; extract a token
   system from the current oklch ramp in `apps/web/src/app/globals.css`.
2. Direction: **warm editorial-minimal** for product pages (kakeibo is a
   Japanese household ledger — paper, ink, one accent). Keep the terminal
   genre for the trace viewer only; it is the right genre there. Use
   `/redesign-skill` or `/taste-skill` for the app shell; `/minimalist-skill`
   or `/soft-skill` for the aesthetic floor.
3. **Dashboard page (biggest gap):** spend by category, budget meters,
   recurring subscriptions, anomaly flags. Read `/dataviz` before writing any
   chart code. Data comes from the existing read tools / repositories.
4. **Landing page:** `/imagegen-frontend-web` for the prompting method — one
   design image per section — then `/image-to-code-skill` to implement.
5. `/brandkit` for logo/wordmark/identity (家計簿 mark).

### Image generation

Those imagegen skills assume other tooling for the actual generation — ignore
that part and generate with **Vertex AI Imagen 4 Ultra**, model ID
`imagen-4.0-ultra-generate-001`, using the same GCP project and ADC
credentials the Gemini adapter already uses (`GCP_PROJECT_ID` from `.env`,
region `us-central1`):

```bash
TOKEN=$(gcloud auth application-default print-access-token)
curl -s -X POST \
  "https://us-central1-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/us-central1/publishers/google/models/imagen-4.0-ultra-generate-001:predict" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{
    "instances": [{ "prompt": "<section design prompt>" }],
    "parameters": { "sampleCount": 1, "aspectRatio": "16:9" }
  }'
# response: predictions[0].bytesBase64Encoded -> decode to PNG
```

Write a small throwaway script (scratchpad, not the repo) that decodes
`bytesBase64Encoded` to files. Design-reference images stay out of git; final
site assets go in `apps/web/public/`. If Ultra rejects a request or the model
ID 404s, fall back to `imagen-4.0-generate-001` and say so.

## Phase 3 — Accounts, multi-tenancy, deploy

Work in a worktree (`/using-git-worktrees`), TDD throughout
(`/test-driven-development`), execute the Phase 1 plan with
`/executing-plans` or `/subagent-driven-development`.

1. Better Auth with the Drizzle adapter; sessions replace the current
   `globalThis` web session (`apps/web/src/lib/session.ts`).
2. `user_id` on ledger accounts, transactions, memories, and trace runs.
   Scope it in the **repository layer** — it is the single insert path; keep
   the double-entry invariant test passing.
3. Per-user quotas + rate limiting on `/api/chat`; Flash model for free tier.
4. The confirm-before-write gate and `<tool_data>` injection defenses carry
   over unchanged — keep `pnpm injection:report` green in CI.
5. Privacy page, account deletion (cascade the user's ledger), ToS stub.
6. Deploy: Vercel + Neon. `.env` handling per CLAUDE.md — nothing real in git.

Before claiming any phase done: `/verification-before-completion`, then
`pnpm lint && pnpm typecheck && pnpm test`, then `/requesting-code-review`,
and land with `/finishing-a-development-branch`.

Start by asking which phase to run, defaulting to Phase 1 if the owner has no
preference. Do not start Phase 3 before the Phase 1 decisions are made.
