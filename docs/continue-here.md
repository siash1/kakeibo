# Prompt: continue the kakeibo public launch

Paste everything below the line into a fresh Claude Code session in this repo,
or just say: **"Read docs/continue-here.md and start."**

---

## Where things stand

kakeibo is a from-scratch Gemini agent over a double-entry ledger, live at
`github.com/siash1/kakeibo`. Phase 1 (scoping) is done and the work is being
taken public in three plans. Two are written, one is merged, one is half built.

**Read first, in this order:**

1. `CLAUDE.md` — conventions. The authorship rule is not optional.
2. `docs/superpowers/specs/2026-08-09-public-launch-design.md` — the design and
   every decision the owner has already made. Do not re-open these.
3. `docs/superpowers/plans/2026-08-09-auth-and-serverless-readiness.md` — Plan B,
   which is the immediate work.
4. `README.md` for the architecture, `docs/kakeibo_spec.md` for the original
   build spec (its "no accounts" non-goal is superseded).

### Done and merged to `main`

- **Phase 1** — decisions, design spec, three-plan split.
- **Plan A: multi-tenancy foundation.** `owner_id` on all nine tables,
  ~24 repository functions take a branded `OwnerId` first, Postgres row-level
  security as a backstop against a non-owning `app_user` role, a cross-tenant
  isolation suite that runs in two enforcement modes. 138 tests.

### In progress on branch `auth-serverless`

Worktree at `.worktrees/auth-serverless`, branch pushed. **Plan B tasks 1–5 of
12 are done**, 145 tests green:

- `ConfirmPolicy` / `SuspendedState` vocabulary (`packages/core/src/suspend.ts`)
- `Tracer.resumeRun`, so a suspended turn stays one trace
- The loop suspends at a write and resumes from a decision
- Every caller migrated from a `confirm` callback to a policy

**Remaining: Plan B tasks 6–12.** Better Auth + anonymous sessions, ledger
repointing on sign-in, conversation persistence, quotas and the budget cap, the
web round trip, the anonymous reaper, docs.

### Not started

- **Plan C** — admin dashboard (spec §9), visitor map from IP geolocation
  (§9.5), Vercel + Neon deploy. Needs writing with `/writing-plans`.
- **Phase 2 — the UI overhaul.** See `docs/public-launch-prompt.md` §2: warm
  editorial-minimal for product pages, terminal genre kept for the trace viewer,
  a dashboard page, a landing page, brand assets. Images via Vertex Imagen 4
  Ultra (`imagen-4.0-ultra-generate-001`), same GCP project and ADC as Gemini.

## How to work

The project skills in `.claude/skills/` are used at the step they are named for.
For this work that means: `/using-git-worktrees` to isolate, `/executing-plans`
to implement Plan B task by task, `/writing-plans` for Plan C,
`/verification-before-completion` before claiming anything is done, and
`/finishing-a-development-branch` to land it.

Subagents were deliberately not used in previous sessions because that session's
instructions prohibited them. If yours allows them,
`/subagent-driven-development` is the better executor for a 12-task plan.

## Start here

```bash
cd .worktrees/auth-serverless   # or recreate it from origin/auth-serverless
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm test                       # expect 145 + 9, all green
```

Then execute Plan B from **Task 6**.

## Things that cost time to learn — do not rediscover them

**The provider.**

- Gemini 3.x attaches an opaque `thoughtSignature` to `functionCall` parts.
  Replaying a tool turn without it is a hard 400. It rides on
  `ToolUseBlock.providerMeta` and must survive every round trip, **including
  the trip through Postgres** in Plan B task 8. A persistence layer that
  normalises the message shape breaks only on tool turns and only in production.
- Gemini 2.5 emits no `functionCall.id`; 3.x does. The adapter synthesises one
  when absent and never echoes a synthesised id back.
- `functionResponse` count must equal `functionCall` count in the turn being
  answered. This is why a batch containing a write suspends as a whole.
- Vertex refuses to create an explicit cache below 4096 tokens. The system
  prompt is deliberately large enough to clear it, and is one constant because
  with an explicit cache the instruction lives *inside* the cached content.
- Model IDs: `gemini-3.6-flash`, `gemini-3.5-flash-lite`,
  `gemini-3.1-pro-preview`. The spec's `gemini-3-flash` / `gemini-3-pro` never
  existed. Re-resolve with `pnpm check:providers`.

**The database.**

- Two roles. `DATABASE_URL` owns the tables (migrations, seeding, evals, and
  `adminDb()`); `APP_DATABASE_URL` is `app_user`, which does not own them and is
  therefore subject to RLS. **If `APP_DATABASE_URL` is missing from `.env` the
  backstop is silently inert.** `.env` is gitignored, so a fresh clone must add
  it; `pnpm db:up` creates the role.
- `adminDb()` has its own pool on purpose. Making it an alias for `getDb()`
  would subject seeding and evals to RLS.
- The isolation suite runs **twice** and both passes matter. The RLS-bypassed
  pass (`pnpm test:isolation:app`) is the only one that tests the application's
  own scoping — mutation testing showed the normal pass stays green with an
  owner filter deleted. Never fix a failure there by adjusting the assertion.
- `pnpm eval` truncates and reseeds before every task. Do not run it against a
  database anything else is using, including the web app. A request racing it
  fails with a foreign-key violation that looks like an application bug.

**Better Auth.**

- The anonymous plugin **deletes the anonymous user immediately after
  `onLinkAccount` returns**, so the ledger must be repointed inside that hook,
  in one transaction. Plan B task 7.
- Its principal table is `user`, a reserved word in Postgres. Quote it as
  `"user"` in every hand-written statement.

**Tooling.**

- In zsh, `$VAR:` triggers history-modifier expansion. Always write `${VAR}:`
  in URLs, or requests 404 in a way that looks like the model is missing.
- Biome skips `.claude/` — vendored skill files are not project source.

## What needs the owner, not the agent

**Google OAuth credentials.** Plan B task 6 wires email/password and anonymous
sign-in, which work with no external setup. Google needs a client ID and secret
from the GCP console (same project as Gemini), with redirect URI
`http://localhost:3000/api/auth/callback/google` locally and the deployed origin
in production. Build without them; the Google button stays hidden while
`GOOGLE_CLIENT_ID` is empty. Ask for them when Plan C deploys.

**Anything Plan C needs**: a Neon database, a Vercel project, a Cloudflare
Turnstile site key. All of them are account creation, which the owner does.

## Decisions already made — do not re-litigate

From the design spec, answered by the owner:

| Question | Answer |
| --- | --- |
| What is the public site for | A playable portfolio piece, not a finance product |
| Monthly Gemini spend | Under $20, hard ceiling with a global kill-switch |
| Entry | Anonymous try-it-now; an account only to persist |
| Bring-your-own-key | No. One code path |
| Real statement upload | Open to everyone, auto-deleted after 24h, raw CSV never stored |
| Tenant isolation | Explicit scoping **and** RLS |
| Demo ledger | Lazy per-visitor clone; anonymous expires in 24h |
| Confirm gate | The loop suspends and resumes |
| Admin | Single-operator dashboard at `/admin`, email allowlist |
| Visitor map | Coarse city-level from request IP, no browser prompt |

$20/month is roughly 148 live turns a day, or 20–40 visitors. Past the cap the
site falls back to replaying a recorded fixture conversation, which is free and
unlimited. That ceiling is a deliberate choice, not an oversight — if the owner
wants it raised they will say so.

## The bar

Every number in the README is reproducible by a script in this repo
(`pnpm metrics`). Guardrails are architectural, not prompt-deep: the write gate
lives in the loop. `pnpm injection:report` stays at 100%. And the commit trail
is the owner's — no AI co-author trailers, ever.
