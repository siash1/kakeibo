# Prompt: continue the kakeibo public launch

Paste everything below the line into a fresh Claude Code session in this repo,
or just say: **"Read docs/continue-here.md and start."**

---

## Where things stand

kakeibo is a from-scratch Gemini agent over a double-entry ledger, live at
`github.com/siash1/kakeibo`. It is being taken public in four plans plus a UI
phase. **Plans A, B and C, the whole of Phase 2, and now Plan D are all
written and built.** Plans A–C and Phase 2 are on `main`; **Plan D is built and
green on the `plan-d` branch and has not been merged.**

**The site is live at https://kakeibo.co.in.** It was deployed on 2026-08-10 to
a Hetzner box rather than to Vercel + Neon — see **`docs/deploy-hetzner.md`**,
which is the runbook that was actually executed. `docs/deploy.md` remains the
Vercel route and is untested.

What is left is one decision: `plan-d` has never been merged to `main` or
pushed. The running site and that branch are the only two copies of this work.

**Read first, in this order:**

1. `CLAUDE.md` — conventions. The authorship rule is not optional.
2. `docs/superpowers/specs/2026-08-09-public-launch-design.md` — the design and
   every decision the owner has already made. Do not re-open these. Its own
   §9.7 records a correction Plan C made to §11's testing table — read that
   before you go looking for a test the design doc describes but that
   provably cannot exist.
3. `README.md` for the architecture, `docs/kakeibo_spec.md` for the build spec
   (its "no accounts" non-goal is superseded; §7, §8.6 and §16 carry the Plan
   A and B amendments, §7/§16 carry Plan C's, and §13 carries Phase 2's — the
   routes, the two genres, and the fact that the confirm round trip has not
   "resolved the loop's pending promise" since Plan B).
4. `apps/web/PRODUCT.md` — product truth for the UI work, and
   `apps/web/DESIGN.md` — the visual system, written from the built world at
   the end of Phase 2. PRODUCT.md is the thing to argue with, not around;
   DESIGN.md describes what shipped, so if it and the code disagree, the code
   is the bug or the doc is stale and one of them gets fixed.
5. `docs/deploy-hetzner.md` — **the runbook that was actually executed**, and
   the description of the machine the site runs on. `docs/deploy.md` is the
   Vercel + Neon alternative, written by Plan D and never run.
6. `docs/superpowers/plans/2026-08-10-public-launch-surfaces-and-deploy.md` —
   Plan D, now built. Its "Out of scope" block is still the record of what the
   owner cut. Four of its task briefs were wrong in ways worth knowing about;
   see "What Plan D actually did" below.
7. `docs/superpowers/plans/2026-08-09-auth-and-serverless-readiness.md` (Plan B)
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

### Phase 2 — done and merged (PRs #3 and #4)

The product surfaces are built. `/` is a landing, `/chat` is the agent,
`/dashboard` and `/evals` are paper, `/runs` and `/admin` stayed terminal.
`apps/web/DESIGN.md` and `apps/web/.impeccable/design.json` record the system
**from the built world** — if the code and DESIGN.md disagree, one of them is a
bug, and the design detector will tell you which.

The gate on `main`: `pnpm lint`, `pnpm typecheck`, **236 tests across 30 files
plus the 15-test second isolation pass**, `pnpm --filter @kakeibo/web build`,
`pnpm injection:report` at 100%, and
`node ~/.claude/skills/impeccable/scripts/detect.mjs --json <targets>` at zero
findings.

Four things Phase 2 fixed that were not UI:

- **The reaper deleted the current day's rate-limit counters.** `quota.ts` writes
  `window_start` as the UTC day; `reaper.ts` compared it to a bare
  `current_date`, which is the *session* timezone's day. For the 5.5 hours
  between local midnight and UTC midnight those differ, so the nightly sweep
  reset every per-IP quota early. It was live, and it was the one site Plan C's
  UTC sweep missed. See rule 11.
- **The dashboard counted salary as a subscription.** `detectRecurring` finds
  anything on a cadence, income postings are negative, and "Monthly
  subscriptions" summed all of them — reporting −₹1,50,472.03 across "11
  merchants" on every month since it shipped.
- **`listRuns`, `getRun` and `cacheStats`** joined `isolation.test.ts`, closing
  the rule-7 gap the previous handoff left open.
- **`flag_anomalies` stopped printing paise at people.** The detail string is
  tool output the fixtures hash over, so it is unchanged on the wire; `sigma`
  and `meanMinor` ride alongside it and the dashboard formats at the display
  boundary.

The four owner decisions from the Phase 2 direction round are in the decided
table at the bottom. The no-accent one is still the load-bearing one.

### The live deployment (2026-08-10)

`root@89.167.44.127`, a shared Hetzner box that also runs an unrelated project
(`japcar`) on :3001. kakeibo is deliberately separate at every layer: its own
directory, systemd unit, Postgres container and volume. Nothing is shared.

| | |
| --- | --- |
| App | `/opt/kakeibo/app`, `kakeibo.service`, `pnpm start` on **:3002** |
| Env | `/opt/kakeibo/.env` (0600), symlinked to the repo root — see below |
| Database | `kakeibo-postgres`, **127.0.0.1:5434**, volume `kakeibo_pgdata` |
| Proxy | Caddy, automatic TLS, `www` and `http` redirect to the apex |
| Sweep | `kakeibo-reap.timer`, 03:17 UTC — the only thing enforcing 24h retention |
| GeoIP | `kakeibo-geoip.timer`, monthly, DB-IP city file at `/opt/kakeibo/geoip` |
| Gemini | `apikey` mode. Vertex needs a service account; ADC does not exist on a server |
| Turnstile | **present in the code and deliberately unconfigured.** The owner declined it on 2026-08-10. Both keys empty means the gate is inert on the server and invisible in the browser, which is a supported state, not a broken one |

Four things cost time there and are written up in `docs/deploy-hetzner.md`:
Docker's published ports bypass ufw entirely; `tests/setup.ts` loads `.env` from
the *repository root* and otherwise falls back to a `DATABASE_URL` pointing at
the neighbouring project's Postgres; Caddy appends to `X-Forwarded-For` unless
told to overwrite, which would let a visitor forge their per-IP quota bucket;
and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is inlined at build time, so it needs a
rebuild rather than a restart.

### Plan D — built, green, unmerged

Branch `plan-d`, worktree `.worktrees/plan-d`, thirteen commits on top of
`main`, and the exact code the live site is running.
**The owner cut sign-up entirely on 2026-08-10**, so the scope was:

| In | Out |
| --- | --- |
| `/sign-in` — unlinked, email+password, the operator's door to `/admin` | Any sign-up page or form |
| `/privacy`, including a delete-everything control | `/settings` |
| `/terms` | Google OAuth |
| Turnstile in front of `/api/chat` | |
| The Vercel + Neon deploy | *(the code half is done; the accounts are the owner's)* |

Three consequences of the cut, so nobody rediscovers them:

- No visitor can create an account, so **every** visitor is anonymous and the
  24-hour reaper applies to all of them without exception.
- The manual `email_verified` statement is permanent, not a stopgap — Google
  OAuth was the intended fix and it no longer has a user to serve.
- `repointOwner` is *not* dead code: signing in as operator while holding an
  anonymous session still fires the link hook and repoints that ledger.

### What Plan D actually did, where it differed from its brief

The pattern from Plan C held: **four of the ten task briefs were wrong**, and in
each case the codebase was right.

- **Task 3 asked for a `deleteAccount` in `link.ts`. It already existed** as
  `deleteUser` in `repo/users.ts`, already exported from the barrel. Writing the
  second one would have been the parallel deletion path the plan's own
  self-review rejected. What was missing was the *proof*: `link.test.ts` now
  seeds a row in every one of the twelve owner-scoped tables — derived from the
  schema, not listed — and asserts they all vanish with the user row and the
  neighbour's all survive. A new owner-scoped table arriving without its cascade
  now fails there instead of making `/privacy` quietly false.
- **Task 9 would have shipped a Turnstile gate that 403s every turn after the
  first.** The brief renders the widget inside `Opening`, which unmounts as soon
  as a question is asked — and a Turnstile token is single-use. The widget lives
  above the composer for the life of the page instead, in `interaction-only`
  mode so it takes no space, and the page drops the spent token and asks for
  another as each turn ends. Verified in a real browser with Cloudflare's
  always-passes test keys: two consecutive live turns, both 200.
- **Task 8's tests would have passed while proving nothing.** `env()` memoises,
  so without `resetEnvCache()` the first call freezes an empty secret and every
  "once configured" case silently exercises the unconfigured path. The brief
  noted this as a possibility; it is a certainty.
- **Task 4's endpoint and Task 10's runbook were right** and went in close to as
  written.

**One thing was found that was not in the plan at all, and it was a launch
blocker.** See "The import path was an arbitrary file read" below.

### The gate, now

`pnpm lint`, `pnpm typecheck`, **245 tests across 32 files plus the 15-test
second isolation pass**, `pnpm --filter @kakeibo/web build`,
`pnpm injection:report` at 100%, and
`node ~/.claude/skills/impeccable/scripts/detect.mjs --json <targets>` at zero
findings. All green on `plan-d` as of 2026-08-10.

## Start here

```bash
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm test                       # expect 245 + 15 on plan-d, 236 + 15 on main
```

To work on Plan D's branch:

```bash
cd .worktrees/plan-d            # already exists; if not:
                                #   git worktree add .worktrees/plan-d plan-d
pnpm install && cp ../../.env .env
PORT=3100 BETTER_AUTH_URL=http://localhost:3100 pnpm dev
```

To exercise the Turnstile gate locally, add Cloudflare's documented test keys —
site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA` —
to that command. Both empty is the normal state and turns the gate off on the
server and the client at once.

**Put worktrees in `.worktrees/`, never in `.claude/worktrees/`.** The harness's
own worktree tool defaults to the latter, and `biome.json` excludes `**/.claude`
— correctly, since that directory is skill files — so `pnpm lint` inside such a
worktree reports *"Checked 0 files"* and exits non-zero. It fails loudly rather
than silently, which is the only mercy in it. `.worktrees/` is gitignored and
demonstrably works.

**Use a port nothing else is on, and set `BETTER_AUTH_URL` to match it.** A
`next dev` left running on 3000 from another worktree serves *that* worktree
silently: every route you just added 404s while auth keeps working, which reads
as a routing bug in your own code for about twenty minutes. Better Auth also
rejects a mutating call whose `Origin` does not match `BETTER_AUTH_URL`, so the
two have to move together.

To see `/admin`, set `ADMIN_EMAILS` in `.env` to an address you sign in with
**and** mark it verified once — `/admin` requires `emailVerified` and no mail
provider is configured:

```sql
update "user" set email_verified = true where email = '<your address>';
```

## How to work

The project skills in `.claude/skills/` are used at the step they are named
for: `/writing-plans` to plan, `/using-git-worktrees` to isolate,
`/executing-plans` or `/subagent-driven-development` to implement,
`/verification-before-completion` before claiming anything is done, and
`/finishing-a-development-branch` to land it. `/impeccable` owns UI work; its
cycle is detector → build → two batched screenshot rounds → a finish review in
a **fresh context** → DESIGN.md, and the review is where the real defects were
caught both times it ran.

Subagent-driven execution earned its cost on Plan C and is worth repeating for
anything plan-shaped: every one of its ten task briefs contained at least one
real defect, and in each case the implementer that pushed back was right. Three
habits worth keeping:

- **Run the full gate yourself before each review.** One implementer reported
  green on a 119-test subset while the full suite failed 8 — and the failure
  was that its own change truncated the seeded ledger on every test run.
- **Hand briefs over as files, and treat their code as a draft to verify.** Plan
  D held to the pattern: four of its ten briefs were wrong, and the codebase was
  right every time.
- **Look at the thing.** Phase 2's worst two defects — a dashboard figure that
  had been wrong on every month since it shipped, and a landing page with a
  hole in the middle of it — were both invisible to tests, to typecheck and to
  HTML assertions, and both were obvious in a screenshot. Plan D found four more
  the same way, on pages that had already passed lint, typecheck and the
  detector.
- **Check the claims a page makes against the code that would have to be true.**
  The one live vulnerability in this repo was found by asking whether `/privacy`
  could honestly say a visitor may upload a statement. No test was ever going to
  ask that.

## Things that cost time to learn — do not rediscover them

**The import path was an arbitrary file read, and it is the one thing on this
list that was a live vulnerability rather than a lost afternoon.**

`import_statement_csv` takes a path from the model, which takes it from whoever
is talking to the model — on the public site, an anonymous visitor.
`resolvePath` passed absolute paths through untouched, and the dry-run preview
returns `parseErrors[].raw`, which is the literal text of every line the CSV
parser could not read. `/api/chat` serves the full registry. Those three facts
compose: *"import /proc/self/environ, dry run"*, the visitor confirms their own
write gate, and `DATABASE_URL`, `BETTER_AUTH_SECRET`, `CRON_SECRET` and the
Gemini credentials come back as unparseable rows. It was found while checking
what `/privacy` could honestly claim, not by a test.

`packages/ledger/src/tools/import-path.ts` now confines every read to `data/` —
already the repo's convention (`data/seed/` for the corpus, `data/private/` for
anything real), so no existing caller changed. The refusal happens before any
filesystem access, so it cannot double as an existence oracle, and
`import-path.test.ts` pins both halves.

**The tool's schema wording was deliberately left alone.** Every string in a
tool schema is inside the explicitly cached prefix that the replay fixtures hash
over, so editing the `path` description would make `pnpm test` miss until the
fixtures are re-recorded against a live model. A behaviour change is free; an
interface change costs an API key and a recording run.

**A Turnstile token is single-use.** Cloudflare rejects a replay as
`timeout-or-duplicate`. Any widget that issues one token and is never reset
gates the first turn and 403s every turn after it — and the failure looks like
the site breaking on the second question only, which is a horrible thing to
debug. The widget stays mounted beside the composer, the page discards the spent
token in the `finally` of each turn and bumps a `refreshKey`, and the composer
waits on the new one rather than sending without it.

Cloudflare's test keys (`1x00000000000000000000AA` /
`1x0000000000000000000000000000000AA`) always pass **and always return the same
constant token string**, so a local test cannot prove freshness by comparing
values. What it can prove is that the widget's callback fired again: the turn
clears the held token before it clears `busy`, so the submit button can only
become enabled again after a second callback.

**Looking at the UI.**

- **A heavy header rule directly above a `Section` is two rules doing one job.**
  Every incumbent paper page puts something — a band of figures, a margin rail,
  an empty state — between its `border-b border-sumi-900` header and the first
  section's `border-t border-sumi-900`. `/privacy` and `/terms` did not, and the
  result was two sumi rules 56px apart with nothing between them. Invisible to
  the detector; obvious in a full-page capture.
- **Tailwind's reset removes list markers, so a `<ul>` reads as loose
  paragraphs.** In this system a list is ruled rows, which is also what the
  ledger's own rows are.
- **Preflight sets `text-decoration: inherit` on anchors**, so the paper-link
  rule in `globals.css` has never had an underline to offset and every inline
  link on the site renders `text-decoration-line: none`. On a site with no
  accent colour that makes an inline link in body-coloured prose invisible. The
  two new pages underline explicitly; the dead global rule and the four existing
  pages it would change were left for a change that can look at all of them.
- **The detector does not enforce the named rules in DESIGN.md.** It returned
  `[]` on a `<Mark tone="ok">deleted</Mark>` that directly contradicted the
  Nothing-Is-Green-When-It-Is-Fine rule. The detector checks tokens; the rules
  need a reader.

- **A screenshot is evidence; a full-page screenshot is evidence about a
  document, not about a viewport.** `position: sticky` renders at its scroll-0
  position in a full-page capture, so a sticky composer appears to sit on top
  of content it never covers in a real browser; an inner `overflow-x-auto`
  container renders only its visible slice, so a scrollable table appears to be
  clipped. Both cost a round of chasing defects that were not there. Judge
  occlusion and scrollers from a **viewport-sized** capture, and measure with
  `getBoundingClientRect` before believing either.
- **A full-page capture of a long page is also too small to read.** Crop to a
  section at `deviceScaleFactor: 3` before concluding anything about type. The
  mobile tool list looked fine at thumbnail size and was truncating every name.
- **The session cookie is `httpOnly`, so a headless capture is signed out by
  default** — every owner-scoped page shows its empty state. The fix costs
  nothing and no model call: in the page context,
  `fetch('/api/auth/sign-in/anonymous', { method: 'POST', headers: {
  'Content-Type': 'application/json' }, body: '{}' })`. **The JSON content type
  is required** — without it Better Auth answers `415` and you get a signed-out
  page and no error worth reading. `/dashboard` clones the demo ledger itself
  on first view, so that one call is enough to see it populated.

**Tests and the shared dev database.**

- **Driving the web app against the dev database breaks `pnpm test`.**
  `safetyPanel` in `admin.test.ts` counts confirmation decisions **across all
  owners** — it is the operator's cross-tenant panel, that is its job — so one
  real allowed write from a browser session makes `expect(panel.allowed).toBe(2)`
  fail with 3. This is the same hazard class as the `tracer.test.ts` leak below,
  but it fires from ordinary use of the app rather than from another test. It is
  not a defect in the panel and **the assertion is not the thing to change**:
  run `pnpm db:reset && pnpm db:seed` before the gate, or run the gate before
  you go clicking. It cost two red suites in one session.
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
  test took 2.6 seconds. It was resource contention, not a defect.

**The web app's module boundaries.**

- `apps/web` imports money formatting from **`@kakeibo/ledger/money`**, not from
  the package barrel. `money.ts` imports nothing; the barrel re-exports the
  repositories, and pulling that into a `'use client'` component drags Drizzle
  and pg toward the browser bundle. The `./*` subpath export already exists, so
  this costs nothing but knowing to do it. The same rule is why `packages/mcp`
  imports core through subpaths (CLAUDE.md, Layout).

**Generating images.**

- Imagen 4 Ultra works, via `scripts/brand/imagen.py`. The key comes from the
  environment or `.env` and never touches a command line.
- **Put the call in a file and run the file.** An inline
  `python3 -c "..."` that contains a key and posts to an external host has the
  shape of credential exfiltration, and the harness's safety classifier blocks
  it on shape, not intent. The same code in a script runs without complaint.
  This cost most of an afternoon before the owner pointed it out.
- **The model generates material, never lettering.** Every glyph on the social
  card is composited by a real browser in the real Source Serif 4. A model sets
  type that is almost right, and almost right on a wordmark is worse than no
  image at all. When it was asked for a photographed account book it rendered
  the word AMOUNTS into the page — legibly, and still wrong to ship.
- The card's four figures are the measured ones. `pnpm eval` moving them means
  the card is stale until it is regenerated; the recipe is in the script header.

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
- `onToolResult` sends the raw payload cut at 200 characters, which is why the
  margin rail parses it and prints nothing when it will not parse rather than
  showing a JSON fragment ending mid-token. Widen that cut only if you also
  want every 40kB tool result streaming to every browser.

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
- **A turn held at the gate has produced no prose and completed no tool calls.**
  Any UI that renders a turn has to handle that state explicitly or it draws two
  empty columns on the one screen whose whole job is to say the machinery
  stopped. `/chat` posts the proposed write to the margin as "awaiting your
  decision" and says so in the book's column.

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
- **The reaper was the one place Plan C's UTC sweep missed, and it was a live
  bug.** `quota.ts` writes `rate_limits.window_start` from `today()`, which is
  always the UTC day; `reaper.ts` deleted anything `< current_date`, which is
  the *session* timezone's day. For the 5.5 hours between local midnight and
  UTC midnight those differ, so the nightly sweep deleted the current UTC day's
  counters and handed every IP a fresh daily allowance early. `reaper.test.ts`
  had asserted this correctly all along and only fails inside that window,
  which is why it stayed green for months. If you are reading this because a
  date-bucketed test just went red for no reason, check the clock first:
  `select current_setting('TimeZone'), current_date, (now() at time zone
  'utc')::date`. The same window took out two `budgetPanel` assertions, where
  the fault was the *fixture* seeding from `current_date` rather than the panel.
  Rule 11 covers test fixtures too.
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
- Vercel's `x-vercel-ip-*` headers are derived from the connection's public IP
  at the edge and cannot be spoofed by the client the way `x-forwarded-for`
  can; Vercel explicitly overwrites the latter to prevent exactly that. Worth
  knowing before treating the geo columns as more sensitive than they are —
  nothing in the app makes an authorization, quota or ledger decision off of
  them, only the map renders a dot.

## Known and deliberately left

**Nothing on `/admin` or `/runs` was restyled.** They are the terminal genre by
decision, not by neglect, and the only change they saw was the shared nav.

**`apps/web/PRODUCT.md` predates the current product-record schema.** The
impeccable tooling flags it `route`-severity: it has no schema stamp and none of
the sections that version adds (Positioning, Operating Context, Evidence on
Hand, Product Principles). Repaired by `/impeccable init`, which is an
interview — the answers cannot be inferred, which is why it was left rather than
guessed at.

**No per-route surface briefs.** The impeccable flow offers them; the durable
strategy for `/` and `/chat` went into the direction contracts at the top of
each page file instead, on the grounds that a contract in the file you are
editing gets read and a sidecar drifts. If you disagree, `surface-brief.mjs`
is still there.

**At the write gate, `/chat` leaves ~330px of empty prose column** beside the
running margin, because a suspended turn has produced two lines of text and the
margin has a full account. The finish review scored it non-blocking; it is how a
ledger looks when the note is short.

**No page carries an image.** The only generated asset is the social card, which
never appears on a surface. A photographed account book and a full-bleed paper
band behind the landing header were both built and rejected — the reasons are in
`scripts/brand/imagen.py` so nobody generates them twice.

Not gaps, for the avoidance of a second look: `adminGetRun` and everything else
in `packages/ledger/src/repo/admin.ts` are deliberately absent from the
isolation suite. They read across owners on purpose, which is what
`packages/ledger/src/admin-containment.test.ts` exists to bound instead.

**`/privacy` and `/terms` are linked from the landing footer only.** No
site-wide footer exists, so a visitor on `/chat` or `/dashboard` reaches the
delete control by going back to `/`. Plan D's steps specified the landing footer
and nothing else; a shared footer in the paper layout would touch four reviewed
pages and `/chat`'s sticky-composer geometry, which is a change that deserves
its own look rather than a drive-by.

**`/privacy` says a visitor may import a real statement. There is no upload in
the web app** — `import_statement_csv` reads a server-side path, now confined to
`data/`, and no page offers a file input. The owner was shown this and chose to
keep the section (2026-08-10); the landing carries the same claim and predates
Plan D. It is the one sentence on the site that a script cannot reproduce. If a
real upload is ever wanted, it is a new tool that takes CSV *text*, not a path.

## What needs the owner, not the agent

**Everything below is now written down in `docs/deploy.md`**, which is the
document to work from. This section is the why; that one is the steps.

**Merging `plan-d`.** It has not been merged or pushed. Eleven commits, gate
green, no AI trailers.

**Google OAuth credentials.** Email/password and anonymous sign-in work with no
external setup, and the Google button stays hidden while `GOOGLE_CLIENT_ID` is
empty. Google needs a client ID and secret from the GCP console (same project as
Gemini), with redirect URI `http://localhost:3000/api/auth/callback/google`
locally and the deployed origin in production. It is not required for the
deploy — with sign-up cut it has no visitor to serve — but it is the better
long-term answer to the `email_verified` problem below.

**The accounts**: a Neon database, a Vercel project, a Cloudflare Turnstile site
(both keys — the site key is public and also goes in
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`). All of them are account creation, which the
owner does. `docs/deploy.md` lists every variable and its value.

**The Neon step has an order.** Create the project, then create the `app_user`
role, *then* migrate. `scripts/db-up.sh` only creates the role; the grants live
in the migration `packages/ledger/drizzle/0002_rls.sql`, which does
`GRANT ... TO app_user` and fails outright if the role does not exist yet. And
if `APP_DATABASE_URL` ends up empty, row-level security is silently inert.

**`CRON_SECRET` in production.** Empty disables the bearer check on
`/api/cron/reap`, which deletes rows. Vercel generates one; set it. Without the
cron running at all, nothing enforces the 24-hour retention the privacy page
promises.

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
plain sight in every commit header of a public repo.

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

Amended by the owner on 2026-08-10, and carried into the design spec by Plan D
Task 1: **there is no sign-up**, so the entry row's second half no longer holds
and `/settings` is gone. The upload row survives as an intention rather than a
description — see "Known and deliberately left".

Decided during Plan D, 2026-08-10:

| Question | Answer |
| --- | --- |
| The unsandboxed import file read | Confine `resolvePath` to `data/`, with a test. Keeps all twelve tools everywhere and fixes it for every caller at once |
| What `/privacy` says about uploads | Keep the section as written, even though the web app has no upload |

Decided during Plan B, and worth the same treatment:

| Question | Answer |
| --- | --- |
| Signing in when the account already has a ledger | The anonymous one is discarded, not merged — both are clones of one corpus, so merging doubles every report |
| Persisting conversation history | Replace the thread, never append: the context manager rewrites history when it summarises |
| Quota on a resumed turn | Free. It was charged when the turn started; blocking and the daily cap still apply |

Decided during Phase 2, by the owner, in structured rounds — same standing:

| Question | Answer |
| --- | --- |
| Ground for product pages | Warm paper, light. Not a warmer dark, not a dark landing |
| Typographic voice | Serif display + sans body; mono only for code, IDs and terminal pages |
| Where the two genres meet | Hard cut, shared nav — crossing flips the ground entirely |
| Accent colour | **None.** Sumi ink on paper; colour only where it carries meaning |
| How much machinery `/chat` shows | A ledger margin rail, always visible, never interrupting the read |
| What `/chat` opens on | A ruled question list — one click to a live turn |

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
(`pnpm metrics`, or the command named next to the figure). The site now
inherits that rule literally: every figure on `/` and `/evals` is read out of
`evals/report/latest.json` or counted off the tool registry at render time, so
there is no number on the marketing surface that a script cannot reproduce.
Guardrails are architectural, not prompt-deep: the write gate lives in the loop,
the RLS bypass the admin dashboard needs lives in exactly one file, and the one
tool that touches the filesystem reads from exactly one directory — each held
there by a test rather than by a comment. `pnpm injection:report` stays at 100%.
And the commit trail is the owner's — no AI co-author trailers, ever.
