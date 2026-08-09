# Prompt: continue the kakeibo public launch

Paste everything below the line into a fresh Claude Code session in this repo,
or just say: **"Read docs/continue-here.md and start."**

---

## Where things stand

kakeibo is a from-scratch Gemini agent over a double-entry ledger, live at
`github.com/siash1/kakeibo`. It is being taken public in four plans plus a UI
phase. **Three plans are merged. Phase 2 is half built on a branch. Plan D has
not been written.**

**Read first, in this order:**

1. `CLAUDE.md` — conventions. The authorship rule is not optional.
2. `docs/superpowers/specs/2026-08-09-public-launch-design.md` — the design and
   every decision the owner has already made. Do not re-open these. Its own
   §9.7 records a correction Plan C made to §11's testing table — read that
   before you go looking for a test the design doc describes but that
   provably cannot exist.
3. `README.md` for the architecture, `docs/kakeibo_spec.md` for the build spec
   (its "no accounts" non-goal is superseded; §7, §8.6 and §16 carry the Plan
   A and B amendments, and §7/§16 carry Plan C's).
4. `apps/web/PRODUCT.md` — product truth for the UI work: who the visitor is,
   what success looks like, what is real and what is synthetic. Written at the
   start of Phase 2 and it is the thing to argue with, not around.
5. `docs/superpowers/plans/2026-08-09-auth-and-serverless-readiness.md` (Plan B)
   and `docs/superpowers/plans/2026-08-09-operator-dashboard.md` (Plan C), each
   with its **"What actually happened"** section. Nearly every task in Plan C
   found a defect in its own brief; the record says what and why.

### Done and merged to `main`

- **Plan A: multi-tenancy foundation.** `owner_id` on all nine tables,
  ~24 repository functions take a branded `OwnerId` first, Postgres row-level
  security as a backstop against a non-owning `app_user` role, a cross-tenant
  isolation suite that runs in two enforcement modes.
- **Plan B: auth and serverless readiness.** Better Auth with the anonymous
  plugin, `owner_id` referencing `"user"(id)` on delete cascade, ledger
  repointing on sign-in, conversation and suspended-turn persistence, a
  suspendable/resumable agent loop, per-owner and per-IP quotas with a global
  budget cap, the web round trip, the lazy per-visitor demo ledger, the reaper.
- **Plan C: operator dashboard.** Coarse per-run geolocation, the `db:reset`
  guard, the live-chat kill switch, the one door through RLS
  (`packages/ledger/src/repo/admin.ts`, gated by a branded `AdminSession` and
  held to a reviewed allowlist by `admin-containment.test.ts`), eight read
  panels and two audited operator actions at `/admin`.

**233 tests across 30 files, plus a 12-test second isolation pass, all green**
(`pnpm test`); `pnpm injection:report` still 100%; `pnpm --filter @kakeibo/web
build` succeeds.

### In flight: Phase 2, branch `ui-overhaul`

Worktree at `.worktrees/ui-overhaul`, **one commit, not pushed, not merged.**
The gate is green on it (233 + 12, lint, typecheck, web build).

The owner picked the direction in a structured round; these are decided and not
to be re-opened:

| | |
| --- | --- |
| Ground | **Warm paper, light** for product pages |
| Type | **Serif display + sans body**; mono only for code, IDs and terminal pages |
| The seam | **Hard cut, shared nav** — crossing to `/runs` or `/admin` flips the ground entirely |
| Accent | **None.** Sumi ink on paper; colour only where it means something |

**What the commit contains:**

- `apps/web/src/app/globals.css` — two palettes in one file. A `paper`/`sumi`
  ramp at hue ~85 for the product genre, the incumbent cool `ink` ramp kept
  unchanged for the terminal genre, status colours in two tunings, and the
  browser surfaces (selection, caret, scrollbars, focus rings) themed per genre.
- **Route groups `(paper)` and `(terminal)`.** Each layout paints its own
  full-height ground via `[data-genre]`; `body` owns neither, which is what
  lets a nested route change worlds without fighting the root. Every existing
  page moved into `(terminal)` unchanged, so nothing broke.
- `apps/web/src/components/ledger.tsx` — the paper primitives. Rules, not
  cards: a section is a ruled band with its heading sitting on the rule. There
  are no cards in a 家計簿.
- `apps/web/src/components/bars.tsx` — `SpendBars` and `BudgetMeter`.
- `apps/web/src/app/(paper)/dashboard/page.tsx` — the dashboard, with month
  navigation across the seed range.
- Two self-hosted faces via `@fontsource-variable`: **Source Serif 4** display,
  **Public Sans** body. Both were chosen partly for *not* being on the design
  skill's banned list of training-data defaults; if you swap them, check that
  list first.

**What remains in Phase 2, in the order to do it:**

1. **Restyle the chat page and move it to `/chat`.** It is currently
   `app/(terminal)/page.tsx` and still wears terminal styling — correct and
   unbroken, but it is a product surface and belongs in `(paper)`. Design spec
   §7 puts the agent at `/chat` and the landing page at `/`.
2. **Landing page at `/`.** Hero, the free replayed demo, the engineering
   story, a CTA. This is the one **Persuade** surface in the product; every
   other page is Operate. `docs/public-launch-prompt.md` §2 names
   `/imagegen-frontend-web` for the prompting method and Vertex Imagen 4 Ultra
   (`imagen-4.0-ultra-generate-001`, same GCP project and ADC as Gemini) for
   generation. Design-reference images stay out of git; final assets go in
   `apps/web/public/`.
3. **Brand assets** — the 家計簿 mark and wordmark. `/brandkit`.
4. **Restyle `/evals` into the paper genre.** It is a product-facing report,
   not a machine record. Left in `(terminal)` only because moving it without
   restyling would have shipped ink-on-paper colours.
5. **Finish the design cycle properly.** The `impeccable` skill's own contract:
   run its detector over the changed targets
   (`node ~/.claude/skills/impeccable/scripts/detect.mjs --json <targets>`),
   spawn `impeccable-finish-reviewer` with screenshots, then
   `impeccable-documenter` to write `apps/web/DESIGN.md` **from the built
   world**. A new visual world shipped without DESIGN.md is an incomplete run
   by that skill's definition, and DESIGN.md is deliberately written at the
   end, not the start.

### Not started: Plan D

Needs writing with `/writing-plans`. Scope, from the design spec: the sign-in /
sign-up / `/settings` pages, `/privacy` and `/terms` (all paper-genre product
pages — do Phase 2 first or build them twice), Turnstile on the anonymous entry
point (§5 layer 4), and the Vercel + Neon deploy (§10). The deploy already has
the pieces Plan C built for it: `ALLOW_DESTRUCTIVE_RESET` and
`assertResettable` in `packages/ledger/src/reset-guard.ts` exist so a
production `DATABASE_URL` in a local shell cannot eat a live database with one
`pnpm eval`.

`/privacy` has a specific obligation, not boilerplate: design spec §9.6 says
trace payloads contain tool arguments and results, so an operator reading a
trace is reading that visitor's ledger contents. The page must say so plainly.

## Start here

```bash
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm test                       # expect 233 + 12, all green
```

To pick up Phase 2:

```bash
cd .worktrees/ui-overhaul       # or: git worktree add .worktrees/ui-overhaul ui-overhaul
pnpm install && cp ../../.env .env
pnpm dev
```

Then sign in (anonymous is enough) and visit `/dashboard`. To see `/admin`, set
`ADMIN_EMAILS` in `.env` to an address you sign in with **and** mark it
verified once — `/admin` now requires `emailVerified`, and no mail provider is
configured:

```sql
update "user" set email_verified = true where email = '<your address>';
```

## How to work

The project skills in `.claude/skills/` are used at the step they are named
for: `/impeccable` for the remaining UI work, `/writing-plans` for Plan D,
`/using-git-worktrees` to isolate, `/executing-plans` or
`/subagent-driven-development` to implement,
`/verification-before-completion` before claiming anything is done, and
`/finishing-a-development-branch` to land it.

Subagent-driven execution earned its cost on Plan C and is worth repeating for
anything plan-shaped: every one of its ten task briefs contained at least one
real defect, and in each case the implementer that pushed back was right. Two
habits from that run are worth keeping:

- **Run the full gate yourself before each review.** One implementer reported
  green on a 119-test subset while the full suite failed 8 — and the failure
  was that its own change truncated the seeded ledger on every test run.
- **Hand briefs over as files, and treat their code as a draft to verify.**

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

## Known and deliberately left

One real gap, triaged during Plan C's final review and left rather than fixed,
because closing it belongs with the suite it belongs to rather than with an
operator dashboard:

**`listRuns`, `getRun` and `cacheStats` are not in
`packages/ledger/src/isolation.test.ts`.** CLAUDE.md rule 7 says every
repository read goes in that table, and these three predate the rule. They *are*
correctly owner-scoped in code — each takes `OwnerId` and filters on it — so
this is missing proof rather than a known leak, and the second, RLS-bypassed
pass is exactly the thing that would catch it if that ever stopped being true.
Add them next time that file is opened.

**The populated dashboard has never been looked at.** Its empty state and its
mobile layout were captured and checked; the version with 25 bars, budget
meters and anomaly rows was verified by parsing the HTML for the right figures
and row counts. That is evidence the data path works and no evidence at all
about whether it reads well. Closing it needs a browser session with a real
cookie — see "Screenshotting the app" above.

Not gaps, for the avoidance of a second look: `adminGetRun` and everything else
in `packages/ledger/src/repo/admin.ts` are deliberately absent from the
isolation suite. They read across owners on purpose, which is what
`packages/ledger/src/admin-containment.test.ts` exists to bound instead.

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

Decided during Phase 2, by the owner, in a structured round — same standing:

| Question | Answer |
| --- | --- |
| Ground for product pages | Warm paper, light. Not a warmer dark, not a dark landing |
| Typographic voice | Serif display + sans body; mono only for code, IDs and terminal pages |
| Where the two genres meet | Hard cut, shared nav — crossing flips the ground entirely |
| Accent colour | **None.** Sumi ink on paper; colour only where it carries meaning |

The no-accent decision is the load-bearing one and the easiest to erode. It
means emphasis comes from weight, scale and the rules — and it is why the
status colours still read as signals when they appear. Adding "just one accent"
later does not add a colour; it removes the reason the others work.

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
