# Prompt: continue the kakeibo public launch

Paste everything below the line into a fresh Claude Code session in this repo,
or just say: **"Read docs/continue-here.md and start."**

---

## Where things stand

kakeibo is a from-scratch Gemini agent over a double-entry ledger, live at
`github.com/siash1/kakeibo`. It is being taken public in three plans. **Two are
done and merged. Plan C has not been written.**

**Read first, in this order:**

1. `CLAUDE.md` — conventions. The authorship rule is not optional.
2. `docs/superpowers/specs/2026-08-09-public-launch-design.md` — the design and
   every decision the owner has already made. Do not re-open these.
3. `README.md` for the architecture, `docs/kakeibo_spec.md` for the build spec
   (its "no accounts" non-goal is superseded; §7, §8.6 and §16 carry the Plan A
   and B amendments).
4. `docs/superpowers/plans/2026-08-09-auth-and-serverless-readiness.md` — Plan B,
   and in particular its **"What actually happened"** section, which records
   every place the implementation diverged from the plan and why.

### Done and merged to `main`

- **Phase 1** — decisions, design spec, three-plan split.
- **Plan A: multi-tenancy foundation.** `owner_id` on all nine tables,
  ~24 repository functions take a branded `OwnerId` first, Postgres row-level
  security as a backstop against a non-owning `app_user` role, a cross-tenant
  isolation suite that runs in two enforcement modes.
- **Plan B: auth and serverless readiness.** All twelve tasks. Better Auth with
  the anonymous plugin, `owner_id` actually referencing `"user"(id)` on delete
  cascade, ledger repointing on sign-in, conversation and suspended-turn
  persistence, a suspendable/resumable agent loop, per-owner and per-IP quotas
  with a global budget cap, the web round trip, the lazy per-visitor demo
  ledger, and the nightly reaper. **183 tests plus a 12-test second isolation
  pass, all green; `pnpm injection:report` still 100%.**

### Not started

- **Plan C.** Needs writing with `/writing-plans`. Its scope, from the design
  spec: the admin dashboard (§9) with its seven panels and the single-door RLS
  bypass in `repo/admin.ts`; the visitor map from Vercel's IP headers (§3.5,
  §9.5); the two operator actions (§9.4 — pause live chat, block an owner);
  Turnstile on the anonymous entry point (§5 layer 4); the sign-in / settings
  UI; `/privacy` and `/terms`; and the Vercel + Neon deploy including the
  `resetAndSeed` guard from §10.
- **Phase 2 — the UI overhaul.** See `docs/public-launch-prompt.md` §2: warm
  editorial-minimal for product pages, terminal genre kept for the trace viewer,
  a dashboard page, a landing page, brand assets. Images via Vertex Imagen 4
  Ultra (`imagen-4.0-ultra-generate-001`), same GCP project and ADC as Gemini.

## Start here

```bash
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm test                       # expect 183 + 12, all green
```

## How to work

The project skills in `.claude/skills/` are used at the step they are named for:
`/writing-plans` for Plan C, `/using-git-worktrees` to isolate,
`/executing-plans` or `/subagent-driven-development` to implement,
`/verification-before-completion` before claiming anything is done, and
`/finishing-a-development-branch` to land it.

## Things that cost time to learn — do not rediscover them

**The provider.**

- Gemini 3.x attaches an opaque `thoughtSignature` to `functionCall` parts.
  Replaying a tool turn without it is a hard 400. It rides on
  `ToolUseBlock.providerMeta` and must survive every round trip **including the
  trip through Postgres** — `conversation_messages.message` is stored verbatim
  for exactly this reason, and `conversations.test.ts` asserts it.
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
- `owner_id` references `"user"(id) on delete cascade`. Deleting a user is the
  whole implementation of both the reaper and "delete everything", so there is
  no per-table delete list to go stale. **Adding an owner-scoped table means
  adding it to `OWNED` in `packages/ledger/src/repo/link.ts`** — `repointOwner`,
  `deleteOwnerRows` and the test helpers all read that one list, and a coverage
  test derives the expected set from the schema.
- `app_user` has **no privileges at all** on `user`, `session`, `account` and
  `verification`. Foreign key checks still work: Postgres runs referential
  integrity as the referenced table's owner.
- `rate_limits` is the only table with no `owner_id` and no RLS policy. That is
  deliberate — its job is to survive a visitor clearing cookies, which is a
  change of owner.
- `pnpm eval` truncates and reseeds before every task. Do not run it against a
  database anything else is using, including the web app. A request racing it
  fails with a foreign-key violation that looks like an application bug.

**Better Auth.**

- The anonymous plugin **deletes the anonymous user immediately after
  `onLinkAccount` returns**, and `owner_id` cascades from it — so a row left
  pointing at the old owner is not merely orphaned, it is deleted milliseconds
  later. `repointOwner` runs inside that hook, in one transaction.
- Its principal table is `user`, a reserved word in Postgres. Quote it as
  `"user"` in every hand-written statement.
- `user.id` is a uuid because `owner_id` references it. That comes from
  `advanced.database.generateId: 'uuid'` in `apps/web/src/lib/auth.ts`; with the
  pg Drizzle adapter Better Auth then omits the id and lets the column's
  `gen_random_uuid()` default fire. Regenerating `auth-schema.ts` must preserve
  that, and the hand-added `blocked_at` column.
- **CSRF: every mutating auth call needs an `Origin` header** matching
  `BETTER_AUTH_URL`. A browser sends one; `curl` does not, and the failure reads
  as `MISSING_OR_NULL_ORIGIN`. Probe with
  `-H 'Origin: http://localhost:3000'`, and run the dev server on the port
  `BETTER_AUTH_URL` names.
- The session endpoint is `/api/auth/get-session`, not `/api/auth/session`.

**The loop.**

- `runTurn` takes a `ConfirmPolicy`, never a `confirm` callback. Reintroducing
  one breaks serverless, which is the entire reason it changed.
- A suspended turn resumes into the **same** `trace_runs` row via
  `Tracer.resumeRun`. Two rows would show half a conversation twice and charge
  two messages against the quota for one turn.
- `executeToolUse` deliberately does not record a `confirm` trace event when the
  caller already ruled on the call. Two events for one decision doubles every
  "writes allowed" figure the Plan C dashboard reads off the timeline.

**Tooling.**

- In zsh, `$VAR:` triggers history-modifier expansion. Always write `${VAR}:`
  in URLs, or requests 404 in a way that looks like the model is missing.
- Biome skips `.claude/` — vendored skill files are not project source.
- `pnpm metrics` prints every number the README claims. A figure a script here
  cannot reproduce does not go in the README, and that includes an impressive
  number from a one-off live run.

## What needs the owner, not the agent

**Google OAuth credentials.** Email/password and anonymous sign-in work with no
external setup, and the Google button stays hidden while `GOOGLE_CLIENT_ID` is
empty. Google needs a client ID and secret from the GCP console (same project as
Gemini), with redirect URI `http://localhost:3000/api/auth/callback/google`
locally and the deployed origin in production. Ask for them when Plan C deploys.

**Anything Plan C needs**: a Neon database, a Vercel project, a Cloudflare
Turnstile site key. All of them are account creation, which the owner does.

**`RATE_LIMIT_SALT` in production.** It defaults to empty, which is fine
locally. Empty in production makes the stored per-IP hashes a plain
rainbow-table lookup of the IPv4 space.

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

Decided during Plan B, and worth the same treatment:

| Question | Answer |
| --- | --- |
| Signing in when the account already has a ledger | The anonymous one is discarded, not merged — both are clones of one corpus, so merging doubles every report |
| Persisting conversation history | Replace the thread, never append: the context manager rewrites history when it summarises |
| Quota on a resumed turn | Free. It was charged when the turn started; blocking and the daily cap still apply |

$20/month is roughly 148 live turns a day, or 20–40 visitors. Past the cap the
site falls back to replaying a recorded fixture conversation, which is free and
unlimited. That ceiling is a deliberate choice, not an oversight — if the owner
wants it raised they will say so.

## The bar

Every number in the README is reproducible by a script in this repo
(`pnpm metrics`). Guardrails are architectural, not prompt-deep: the write gate
lives in the loop. `pnpm injection:report` stays at 100%. And the commit trail
is the owner's — no AI co-author trailers, ever.
