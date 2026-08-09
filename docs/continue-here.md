# Prompt: continue the kakeibo public launch

Paste everything below the line into a fresh Claude Code session in this repo,
or just say: **"Read docs/continue-here.md and start."**

---

## Where things stand

kakeibo is a from-scratch Gemini agent over a double-entry ledger, live at
`github.com/siash1/kakeibo`. It is being taken public in four plans. **Three
are done and merged. Plan D has not been written.**

**Read first, in this order:**

1. `CLAUDE.md` — conventions. The authorship rule is not optional.
2. `docs/superpowers/specs/2026-08-09-public-launch-design.md` — the design and
   every decision the owner has already made. Do not re-open these. Its own
   §9.7 records a correction Plan C made to §11's testing table — read that
   before you go looking for a test the design doc describes but that
   provably cannot exist.
3. `README.md` for the architecture, `docs/kakeibo_spec.md` for the build spec
   (its "no accounts" non-goal is superseded; §7, §8.6 and §16 carry the Plan
   A and B amendments, and §7/§16 carry Plan C's — `operator_flags`, the five
   `geo_*` columns, `ADMIN_EMAILS`, `ALLOW_DESTRUCTIVE_RESET`).
4. `docs/superpowers/plans/2026-08-09-auth-and-serverless-readiness.md` — Plan
   B, and in particular its **"What actually happened"** section, which
   records every place the implementation diverged from the plan and why.
5. `docs/superpowers/plans/2026-08-09-operator-dashboard.md` — Plan C — and
   `.superpowers/sdd/2026-08-09-operator-dashboard/progress.md` alongside it.
   The progress log is the more honest document: nearly every task found a
   defect in its own brief (a wrong containment allowlist, a bare
   `current_date` that had already shipped a live enforcement bug, a test
   fixture leaking into a sibling suite) and the log says what the defect was
   and why the fix is what it is, not just that a task is "done."

### Done and merged to `main`

- **Phase 1** — decisions, design spec, three-plan split (later four; see
  below).
- **Plan A: multi-tenancy foundation.** `owner_id` on all nine tables,
  ~24 repository functions take a branded `OwnerId` first, Postgres row-level
  security as a backstop against a non-owning `app_user` role, a cross-tenant
  isolation suite that runs in two enforcement modes.
- **Plan B: auth and serverless readiness.** All twelve tasks. Better Auth with
  the anonymous plugin, `owner_id` actually referencing `"user"(id)` on delete
  cascade, ledger repointing on sign-in, conversation and suspended-turn
  persistence, a suspendable/resumable agent loop, per-owner and per-IP quotas
  with a global budget cap, the web round trip, the lazy per-visitor demo
  ledger, and the nightly reaper.
- **Plan C: operator dashboard.** All ten tasks. Coarse per-run geolocation
  from Vercel's edge headers (five nullable `geo_*` columns on `trace_runs`); a
  guard that refuses `db:reset`/`pnpm eval` against a non-localhost database
  without `ALLOW_DESTRUCTIVE_RESET=1`; a site-wide live-chat kill switch
  (`operator_flags`); the one door through row-level security,
  `packages/ledger/src/repo/admin.ts`, gated by a branded `AdminSession` only
  `assertAdmin` can produce and held to a reviewed allowlist by
  `admin-containment.test.ts`; eight read panels (budget, traffic, health,
  safety, tools, recent runs, users, map) and two audited operator actions
  (pause live chat, block an owner) at `/admin` — terminal genre, matching the
  trace viewer, not the warm-editorial product pages Phase 2 will define.

  **228 tests across 29 files, plus a 12-test second isolation pass, all
  green** (`pnpm test`); `pnpm injection:report` still 100% block rate (it
  replays fixtures under `REPLAY=1` — no API key, no cost); `pnpm --filter
  @kakeibo/web build` succeeds with `/admin` emitted as a dynamic route.

### Not started

- **Plan D.** Needs writing with `/writing-plans`. Its scope, from the design
  spec: the sign-in / sign-up / `/settings` pages, `/privacy` and `/terms` —
  all "warm editorial" product pages (design spec §7) that the terminal-genre
  `/admin` and `/runs` pages deliberately are not — Turnstile on the anonymous
  entry point (design spec §5, layer 4), and the Vercel + Neon deploy (design
  spec §10), which already has the pieces Plan C built for it:
  `ALLOW_DESTRUCTIVE_RESET` and the `assertResettable` guard in
  `packages/ledger/src/reset-guard.ts` exist specifically so a production
  `DATABASE_URL` in a local shell cannot eat a live database with one
  `pnpm eval`. All of it waits on either Phase 2's visual direction or on an
  account only the owner can create (Neon, Vercel, a Cloudflare Turnstile site
  key, Google OAuth credentials for the deployed origin) — see "What needs the
  owner" below.
- **Phase 2 — the UI overhaul.** See `docs/public-launch-prompt.md` §2: warm
  editorial-minimal for product pages, terminal genre kept for the trace viewer
  and the admin dashboard, a landing page, brand assets. Images via Vertex
  Imagen 4 Ultra (`imagen-4.0-ultra-generate-001`), same GCP project and ADC as
  Gemini.

## Start here

```bash
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm test                       # expect 228 + 12, all green
```

To see the dashboard itself, set `ADMIN_EMAILS` in `.env` to whatever email you
sign in with locally, then visit `/admin` after signing in — everything else
about it is 404 by design, including a signed-in but non-allowlisted session.

## How to work

The project skills in `.claude/skills/` are used at the step they are named
for: `/writing-plans` for Plan D, `/using-git-worktrees` to isolate,
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
- Better Auth's CLI-generated tables use naive `timestamp`, not `timestamptz`,
  while every table in `schema.ts` uses `timestamptz`. `user.created_at` is the
  concrete instance that bit Plan C: comparing it against a `timestamptz` bound
  needs `user.created_at::timestamptz`, and that cast recovers the original
  instant *only if the session timezone at read time is the same one that was
  active at insert time* — nothing in this codebase pins that. It is correct
  today because nothing changes the session zone between insert and read, not
  because the cast is zone-independent. `trafficPanel`'s `returning` count in
  `packages/ledger/src/repo/admin.ts` has the full derivation in a comment. The
  real fix is making `user.created_at` a `timestamptz` in the generated schema,
  which is out of scope for a query to do on its own.

**The loop.**

- `runTurn` takes a `ConfirmPolicy`, never a `confirm` callback. Reintroducing
  one breaks serverless, which is the entire reason it changed.
- A suspended turn resumes into the **same** `trace_runs` row via
  `Tracer.resumeRun`. Two rows would show half a conversation twice and charge
  two messages against the quota for one turn.
- `executeToolUse` deliberately does not record a `confirm` trace event when the
  caller already ruled on the call. Two events for one decision doubles every
  "writes allowed" figure the admin dashboard reads off the timeline.

**The operator dashboard (Plan C).**

- `current_date` and `<date> - interval` are the **session** timezone's date,
  not UTC. That timezone is `Asia/Kolkata` on the development machine and UTC
  on the intended production host, so a bound built from either silently picks
  a different day depending on which database it runs against — and it cost
  two tasks: the budget panel's sparkline and month-to-date bounds shipped
  wrong first, and `quota.ts`'s `spendToday`/`messagesToday` turned out to have
  the same bug already live, meaning the daily budget allowance was resetting
  5.5 hours early in production every day. `admin.ts` and `quota.ts` each
  define their own `UTC_DAY_START` constant that pins midnight UTC as a
  `timestamptz` instant; the duplication is deliberate (see rule 11 in
  `CLAUDE.md`).
- An operator action needs a real `trace_runs` row to hang an audit event off
  of, so `admin.ts`'s `audit()` writes one, tagged `provider: 'operator'`. Every
  place a run is counted, timed or costed as *visitor* activity has to exclude
  that tag (`IS_VISITOR_RUN` in both `admin.ts` and `quota.ts`) or an
  operator's own moderation click quietly spends the target's quota — the
  concrete failure mode review caught before it shipped: unblocking a visitor
  would have silently cost them one of their eight daily messages, every time.
  The one place it must **not** be excluded is `recentRuns`:
  the whole reason the audit event lives in `trace_events` rather than a
  separate log is so an intervention shows up in the same timeline as
  everything else.
- `packages/ledger/src/repo/tracer.test.ts` inserts a `tool_call` event named
  `set_budget` and never deletes it (it resets its *owner's* rows on the way
  in, but that owner is not itself the target of the delete). Any later test
  that does an exact-count assertion on a real tool name across all owners will
  pick that row up and flake on a second consecutive `pnpm test` run against
  the same database. `admin.test.ts`'s `toolsPanel` suite works around it by
  using tool names no real tool has (`__test_tool_a`, `__test_tool_b`) rather
  than fixing the leak, which is documented in a comment at the top of that
  `describe` block.
- A full `pnpm test` run **concurrent with other heavy work** made the MCP
  suite take 900 seconds and time out; run alone, immediately after, the same
  test took 2.6 seconds. It was resource contention, not a defect — run the
  gate with nothing else going on, per the constraint at the top of every task
  brief in this plan.
- Vercel's `x-vercel-ip-*` headers are derived from the connection's public IP
  at the edge and cannot be spoofed by the client the way `x-forwarded-for`
  can; Vercel explicitly overwrites the latter to prevent exactly that. Worth
  knowing before treating the geo columns as more sensitive than they are —
  nothing in the app makes an authorization, quota or ledger decision off of
  them, only the map renders a dot.

## What needs the owner, not the agent

**Google OAuth credentials.** Email/password and anonymous sign-in work with no
external setup, and the Google button stays hidden while `GOOGLE_CLIENT_ID` is
empty. Google needs a client ID and secret from the GCP console (same project as
Gemini), with redirect URI `http://localhost:3000/api/auth/callback/google`
locally and the deployed origin in production. Ask for them when Plan D
deploys.

**Anything Plan D needs**: a Neon database, a Vercel project, a Cloudflare
Turnstile site key. All of them are account creation, which the owner does.

**`RATE_LIMIT_SALT` in production.** It defaults to empty, which is fine
locally. Empty in production makes the stored per-IP hashes a plain
rainbow-table lookup of the IPv4 space.

**`ADMIN_EMAILS` in production.** Empty means nobody can reach `/admin` —
correct as a default, wrong as a permanent state once the site is live. Set it
to the owner's real sign-in email(s) as part of the deploy, or the dashboard
Plan C just built is unreachable on the one database it exists to watch.

**Email verification, before `ADMIN_EMAILS` goes on a public deploy.**
`adminSession()` (`apps/web/src/lib/admin.ts`) now requires
`viewer.emailVerified === true` in addition to the allowlist match, because
`auth.ts` enables `emailAndPassword` with no `requireEmailVerification` and
sign-up is public at `/api/auth/sign-up/email`. Without the check, `email` on
a password account is self-asserted: whoever registers the allowlisted
address first *becomes* the operator, and the owner's address is sitting in
plain sight in all 18 commit headers of a public repo.

No mail provider is configured anywhere in this codebase, so nothing can
currently set `email_verified` on a normal sign-up — which means the fix, left
as it is, locks the owner out of their own dashboard. Before `ADMIN_EMAILS` is
set on a public deploy, Plan D must configure one of:

- **Google OAuth**, so the provider vouches for the address (see the OAuth
  item above) — the better long-term answer, since it needs no further manual
  step per address; or
- **A real email-verification flow** (a mail provider plus Better Auth's
  verification email/link).

Until one of those exists, the operator marks their own account verified once,
deliberately, by hand:

```sql
update "user" set email_verified = true where email = '<the operator address>';
```

Do this once, right after the owner's own sign-up, before announcing the site.

**The residual risk, stated plainly.** Requiring verification stops an
attacker from *using* the allowlisted address — they cannot register it and
have Better Auth call it verified, since nothing here does that automatically.
It does **not** stop an attacker from *registering* it first and denying it to
the owner: on a fresh production deploy, the address is claimable by whoever
signs up with it first, verified or not, and Better Auth will not hand it to
a second registrant. The mitigation is procedural, not technical: the owner
registers their own account — and runs the `email_verified` statement above —
*before* `ADMIN_EMAILS` is set and the site is announced. This is not fixed by
anything in this codebase; it is a sequencing requirement on the deploy.

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
(`pnpm metrics`, or the command named next to the figure). Guardrails are
architectural, not prompt-deep: the write gate lives in the loop, and the RLS
bypass the admin dashboard needs lives in exactly one file, held to that by a
containment test rather than a comment. `pnpm injection:report` stays at 100%.
And the commit trail is the owner's — no AI co-author trailers, ever.
