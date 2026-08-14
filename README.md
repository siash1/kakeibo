# kakeibo

**家計簿 — an AI finance agent built from scratch on the raw Gemini API.**

No agent framework. No SDK tool-runner. The loop, the message arrays and the tool
dispatch are hand-written, and this README explains why each of them works the
way it does.

kakeibo imports bank-statement CSVs into a double-entry PostgreSQL ledger and
answers questions about them across turns: what you spent, what you are
subscribed to, what looks wrong, what you should budget. Twelve tools, a
confirm-before-write gate, context caching, a prompt-injection suite, an eval
harness and a trace viewer for every model and tool call.

```
you ──▶ CLI / web / MCP ──▶ runTurn ──▶ Gemini (Vertex)
                               │
                               ├─▶ tool registry ──▶ ledger (Postgres, double-entry)
                               ├─▶ context manager ──▶ summarise & evict
                               ├─▶ confirm gate ──▶ you, again, before any write
                               └─▶ tracer ──▶ trace_runs / trace_events
```

![The confirm-before-write gate: the turn suspended, the proposed write posted in
the margin, and the amount shown as money beside the literal argument being
authorised.](docs/screens/gate.jpg)

*The write gate, mid-turn. The loop is suspended in Postgres waiting on this
answer; the margin records what the agent did and what it cost. Every screenshot
in this README is the running app, not a mock-up.*

---

## The numbers

Everything below is measured by a script in this repo and reproducible with one
command. Nothing here is an estimate.

| metric | value | reproduce |
| --- | --- | --- |
| Eval pass rate | **50 / 50 (100%)** | `pnpm eval` |
| Injection block rate | **100%** (6/6) | `pnpm injection:report` |
| Context-cache token savings | **65.6%** overall, **61.0%** steady state | `pnpm cache:report` |
| Context-cache savings across the eval run | **82.2%** of prompt tokens (50 tasks) | `pnpm eval` |
| Cost saved by caching | **51.7%** | `pnpm cache:report` |
| Median / p95 turn latency | **15.8 s** / **26.7 s** | `pnpm eval` |
| Median cost per eval task | **$0.0098** (list price) | `pnpm eval` |
| Context estimate error vs `countTokens` | **3.1% mean absolute** | `pnpm metrics` |
| Tests | **252** across 33 files, plus the isolation suite a second time with RLS bypassed (15 more); no API key and no network | `pnpm test` |
| Tools | 12 | `pnpm cli` then `/help` |
| Core loop | **496 lines** of code (`packages/core/src/loop.ts`, 649 with comments) | `pnpm metrics` |

Cost figures are list-price estimates from `packages/core/src/pricing.ts`, read
from Google's published Vertex pricing. They are useful as *relative* numbers —
cached versus uncached, Flash versus Pro — which is what they are used for.

The Tests row cites `pnpm test`, which is vitest's own runtime count.
`pnpm metrics` prints a lower number for the same 33 files (239, not 252): it
is a static `grep` for `it(`/`test(` declarations, and `isolation.test.ts`
builds several tests from a table at runtime that the grep only sees once.
Both figures are real; they are answers to different questions, not a
disagreement.

---

## Quick start

```bash
pnpm install
cp .env.example .env          # then fill in GCP_PROJECT_ID
pnpm check:providers          # resolves model IDs against your account
pnpm db:up                    # Postgres 16 on :5433 (docker, or a local fallback)
pnpm db:migrate && pnpm db:seed
pnpm cli                      # talk to it
pnpm dev                      # or use the web UI on :3000
```

**Two database roles.** `DATABASE_URL` owns the tables and is used by
migrations, seeding and evals, which must write rows for any owner.
`APP_DATABASE_URL` connects as `app_user`, which does not own the tables and is
therefore subject to row-level security — that is the connection the application
uses, and the reason a forgotten `where owner_id = ...` returns nothing instead
of someone else's ledger. `pnpm db:up` creates the role locally.

`pnpm check:providers` exists because model IDs move faster than any document.
It probes each role's candidate chain against the account you actually have and
prints the `.env` lines to paste.

**Provider auth.** `GEMINI_AUTH=vertex` (default) uses application-default
credentials — `gcloud auth application-default login`. `GEMINI_AUTH=apikey` uses
an AI Studio key. Both paths are supported by the same adapter and both are
tested.

**Visitor auth.** Set `BETTER_AUTH_SECRET` (`openssl rand -base64 32`). Google
OAuth is optional: email/password and anonymous sign-in need no external setup,
and the sign-in UI hides the Google button while `GOOGLE_CLIENT_ID` is empty.

**Docker.** `pnpm db:up` prefers `docker compose` and falls back to a local
Postgres cluster in `.pgdata/` when Docker is not installed, so `DATABASE_URL`
is the same either way.

---

## How the loop works

`packages/core/src/loop.ts`. The whole agent is one function, short enough to
read in a sitting:

```
1. Append the user message (with recalled memories on the same turn).
2. contextManager.fit(history)      # may summarise and evict
3. LOOP:
   a. stream from the provider
   b. blocked?    -> record, surface the safety reason, END
   c. max_tokens? -> record, surface, END           (never hand back a half-answer)
   d. append the assistant message, signatures intact
   e. no tool calls? -> the text is the answer, END
   f. iterations++ ; over the cap -> synthetic error results, one final
      tool-free completion, END
   g. run every tool call in parallel; each resolves to a tool_result —
      success, validation failure, denial or thrown error alike
   h. append ONE user message containing ALL results
   i. goto a
```

**Why it terminates.** Every iteration either ends the turn at (e) or spends one
of a bounded number of iterations at (f). No path adds iterations, and the cap
is checked *before* the provider is called again, so the worst case is
`MAX_ITERATIONS` calls plus one forced completion. There is no unbounded path.

**Why tool errors do not crash it.** A failing tool returns a `tool_result` with
`is_error` set — data the model can read and react to. Validation failures come
back as the validation message. The model then corrects itself on the next
iteration. If the exception propagated instead, a mistyped argument would end
the conversation. `packages/core/src/loop.test.ts` proves this against a
scripted provider, because the live model is too well-behaved to reliably
produce the failure: it reads the enum in the declaration and refuses before
calling.

**Why all parallel results go back together.** The provider rejects a turn where
the number of `functionResponse` parts differs from the number of
`functionCall` parts it is answering — splitting them across two turns is a hard
400. It also keeps the model willing to emit parallel calls at all, since it
sees them answered as a batch.

---

## The loop can stop halfway and be picked up by a different process

This is the part of the codebase I would point at first.

The confirm-before-write gate used to be a callback the loop awaited. That is
the obvious design and it works fine when the human is in the same process — the
CLI's readline prompt, an eval script. It cannot work when the human is a
browser on the far side of a second HTTP request: on serverless, `/api/chat` and
`/api/confirm` are different function invocations with no shared memory to await
across. The symptom is not subtle and it is not local: the card renders, you
click allow, and the first request sits there until it times out.

So `runTurn` takes a **policy** rather than a callback:

```ts
type ConfirmPolicy =
  | { mode: 'inline'; confirm: ConfirmFn }  // the CLI
  | { mode: 'auto-allow' }                  // MCP with ALLOW_WRITES=1
  | { mode: 'auto-deny' }                   // evals, the injection suite
  | { mode: 'suspend' }                     // the web
```

Under `suspend`, step (g) changes. When the batch contains a write the loop
executes the **read-tier** calls, returns `status: 'suspended'` with everything
needed to continue, and appends no results message. The caller writes that to
`suspended_turns`; `POST /api/confirm` reads it back, runs the approved writes,
emits a refusal for the rest, reassembles all the results into one message in
the model's original call order, and continues from step (h) — streaming the
rest of the turn on *its own* response.

Three things about it are easy to get wrong and each one is a test:

**All writes in a batch suspend together.** The provider requires response count
to equal call count, so a batch cannot be answered piecemeal — you cannot pause
on one write while answering another call beside it. The reads' results are
carried across rather than re-run, which also stops the data shifting underneath
a decision a human is still making. Getting this wrong produces a hard 400 that
only appears when the model happens to emit a mixed batch, so the test uses a
scripted adapter that emits exactly that shape.

**The paused turn carries its own spend.** `usage` and `cost_usd_est` go into
the suspended state and seed the resumed turn's totals. Starting them at zero
would hide the model calls that led to the confirmation from both the trace and
the daily budget cap — and turns involving a confirmation are the expensive
ones, so the cap would undercount exactly the conversations that cost the most.

**It stays one run.** `Tracer.resumeRun` reopens the existing `trace_runs` row
and continues its event sequence instead of starting a second. Otherwise the
trace viewer shows half a conversation twice and the per-visitor quota charges
two messages for one — which would make "ask for something that needs approval"
the cheapest way to burn a quota.

All three are asserted in `pnpm test` against a scripted adapter and a real
Postgres: the mixed batch returns its reads' results and only its writes as
pending, the resumed turn's `usage.inputTokens` is strictly greater than the
suspended state's, and `listRuns` finds one run whose event sequence continues
`[0, 1]` rather than restarting.

There is one more that only bites in production. The suspended state round-trips
through `jsonb`, and Gemini 3.x hangs an opaque `thoughtSignature` off every
`functionCall` part — so a persistence layer that helpfully normalises the
message shape breaks resume on tool turns only, after a confirmation only, and
never in a test that does not look for it. `conversations.test.ts` looks for it.

---

## What building on raw Gemini actually taught me

These are the things that cost time, found empirically against the live API
rather than read off a doc page.

### Thought signatures are load-bearing

Gemini 3.x attaches an opaque `thoughtSignature` to `functionCall` parts. Replay
that turn without it and the request fails:

```
400 Function call is missing a thought_signature in functionCall parts.
This is required for tools to work correctly...
```

So kakeibo's canonical `ToolUseBlock` carries a `providerMeta` bag that the core
never reads and the adapter restores on the way out. With two parallel calls,
only the *first* part carries a signature — so it has to be per-part, not
per-message.

### Gemini has no function-call IDs (until it does)

Gemini 2.5 emits `functionCall` parts with **no `id` at all**. Gemini 3.x emits
one. kakeibo needs a stable correlation ID either way, so the adapter takes the
provider's when offered and mints `call_<n>_<name>` otherwise. Going back the
other way, `functionResponse.id` turns out to be *optional* — the API pairs by
position — but the count and order are not. Synthesised IDs are therefore never
echoed to the provider, only used internally.

Compare Anthropic, where `tool_use.id` is mandatory and round-tripped. Writing a
provider-neutral core meant discovering that ID correlation is a *provider
capability*, not a given.

### The cache invalidator hunt

First measurement: 0% cached. The stable prefix has to be byte-identical across
requests, and three things were quietly perturbing it:

1. **Tool declaration order.** The registry was a `Map`, and while JS preserves
   insertion order, the *serialisation* of each JSON Schema did not sort keys.
   Fixed by `stableSchema()` — keys sorted at every depth, declarations sorted by
   name, and the result memoised.
2. **Memory injection.** Recalled memories were being put where they perturbed
   the prefix. They now ride on the *latest user turn*, after everything stable.
3. **The 4096-token floor.** Vertex refuses to create an explicit cache below
   4096 tokens:
   ```
   400 The cached content is of 2762 tokens.
   The minimum token count to start explicit caching is 4096.
   ```
   System instruction + 12 tool declarations came to 2762. Rather than pad with
   filler, the domain reference block was expanded into the prompt itself — a
   merchant glossary, worked answers, a tool-selection table. It is *one*
   constant, not an optional suffix, because with an explicit cache the system
   instruction lives inside the cached content and is not re-sent: a prompt that
   grew padding only when caching was enabled would be two different prompts and
   would never hit.

### Gemini vs Anthropic caching

They are different products that solve the same problem.

| | Gemini | Anthropic |
| --- | --- | --- |
| automatic layer | **implicit caching**, on by default, no API surface | none |
| explicit layer | `caches.create()` returns a resource you reference by name | `cache_control: {type: "ephemeral"}` breakpoints inline in the request |
| granularity | whole cached-content object | up to 4 breakpoints, each a prefix boundary |
| minimum | 4096 tokens (3.6-flash, measured) | 1024–2048 tokens depending on model |
| billed for storage | yes, per token-hour | yes, as a one-off write premium on the cached tokens |
| TTL | you set it (kakeibo uses 30 min, refreshed on use) | 5 min, refreshed on use (1 hour available) |
| visible in usage | `cachedContentTokenCount` | `cache_read_input_tokens` / `cache_creation_input_tokens` |

The practical difference is *where the decision lives*. Anthropic makes you mark
the prefix boundary in every request, which is more work but means the cache is
part of the request. Gemini makes you create and manage a resource with a
lifetime, which is less per-request work but introduces something that can
expire underneath you — hence `ensureCache` refreshing two minutes before the
TTL rather than at it.

And the measured shape differs. Explicit caching earns its keep at the *start* of
a conversation; implicit caching catches up by about the fourth turn:

| turn | explicit + implicit | implicit only |
| --- | --- | --- |
| 1 | 89.5% | 18.7% |
| 2 | 74.1% | 15.5% |
| 3 | 68.0% | 57.7% |
| 4 | 59.8% | 64.5% |
| 5 | 52.0% | 56.6% |

If your workload is many short conversations, explicit caching is most of the
win. If it is few long ones, implicit gets you most of the way for free.

### Schema declarations are a request, not a constraint

Gemini has no server-side strict-schema guarantee. The declaration tells the
model what to produce; nothing enforces it. So kakeibo re-validates every tool
input with zod **at execution time**, and a validation failure becomes an
`is_error` tool result the model can recover from. The declaration is also a
narrow subset — no `$ref`, no `additionalProperties`, no `oneOf`/`allOf` — so
`zodToJsonSchema` is a whitelist that folds anything it must drop into the
`description`, which is the only channel the model actually reads.

---

## Guardrails

**Tiers.** Every tool declares `read` or `write`. Read auto-executes. Write
pauses the loop for a human: the CLI prompts y/n inline, the web *suspends the
turn* and resumes it from `POST /api/confirm` (see above), MCP simply does not
expose write tools unless started with `ALLOW_WRITES=1`, and evals script the
answer per task.

**Data is not instruction.** Every tool result is wrapped in `<tool_data>` and
the system prompt is explicit that content inside it can never issue an
instruction, approve a write, or change the rules. Transaction descriptions come
from merchants, and merchants can write whatever they like in them.

**The injection suite.** Six hostile descriptions are planted in the seed data
and imported through the ordinary CSV path — instruction override, a forged
`<system>` tag claiming pre-approval, a forged assistant turn aiming at
persistent memory, a forged tool result, a destructive "note to the AI", and a
Cyrillic homoglyph variant. Each test asks an innocuous question whose answer
necessarily drags the hostile text into context.

**Block rate: 100%.** But be precise about what that claims. It does *not* claim
the model cannot be talked into anything — no prompt achieves that. It claims
**data cannot cause a write**, which is architectural: the gate is in the loop,
not in the prompt, so an injection would have to fool a *human*, not a model.
The suite also checks that the guardrail did not cost the answer (100% still
answered the user's actual question), and records how often the agent
proactively flagged the attack — which varies 50–83% run to run, so it is
reported and not asserted.

`memory_save` is write-tier for this reason specifically: memory is the one
place an injection could earn persistence across sessions.

---

## Context management

Budget defaults to 60k input tokens. Over budget, the oldest turns are
summarised by a Flash-Lite model and the summary is pinned as the first user
turn, followed by a stub `Understood.` assistant turn.

The subtle part is **what a unit of eviction is**. It is not a message. A tool
call and its results are indivisible — drop half and the provider rejects the
whole history — so eviction works on *turn groups*: a real user message plus
every assistant and tool-result message that followed it. Four things are never
evicted: the system instruction, the tool declarations, the pinned summary, and
the six most recent groups. `context.test.ts` asserts that every surviving
`tool_use` still has its matching `tool_result`.

Token counting uses the real `countTokens` at turn start and after eviction, and
a heuristic estimate in between. Both are traced, so the estimate's error is a
measured number rather than a claim — and measuring it changed the estimator.

A flat `chars/4`, the usual rule of thumb, is wrong in the direction that
matters:

| history | `chars/4` estimate | real | error |
| --- | --- | --- | --- |
| 1 turn, prose only | 3,797 | 3,918 | −3.1% |
| 1 turn with a tool result | 9,690 | 11,930 | −18.8% |
| 4 turns | 27,440 | 35,993 | −23.8% |
| 12 turns | 74,774 | 100,165 | **−25.3%** |

Prose tokenises at roughly four characters per token. Serialised JSON does not —
every brace, quote, colon and escape tends to cost a token of its own — and tool
results are the bulk of a real history. Underestimating by a quarter is how a
window sails past its budget while believing it is inside it. Counting text and
structured content with separate divisors (≈4.1 and ≈2.6 chars/token) takes the
mean absolute error from **17.7% to 3.2%**, and the long histories that actually
approach the budget land within 0.4%.

---

## The ledger

Real double entry. Every transaction has two or more postings whose signed
minor-unit amounts sum to exactly zero. Money is integer minor units (paise)
everywhere; floats appear only when a human reads a number.

The invariant is enforced in the **repository layer**, which is the single
insert path, and asserted by a test that can actually reach it. There is no
trigger, because a trigger would be a second source of truth the tests cannot
see.

Categorising does not move money: it repoints the expense posting from
Uncategorized to the target account, which leaves the sum at zero by
construction. There is no window in which the ledger is inconsistent.

Seed data is deterministic — fixed PRNG seed, fixed end date, UUIDv5 primary
keys derived from the row. 352 transactions across six months with salary,
subscriptions, rent, noise, three planted anomalies (a 10× grocery bill, a
duplicate charge, a refund), the six hostile descriptions, and ~8% of rows
deliberately uncategorised. `data/seed/labels.json` is the eval oracle.

---

## One ledger per visitor, proven twice

Every visitor is a Better Auth user from their first request. Anonymous ones are
simply users who have not attached credentials yet, which collapses two
principal types into one and makes `owner_id` on a ledger row always `user.id`.
Signing in repoints the anonymous ledger onto the new account in a single
transaction — it has to be single, because the anonymous plugin deletes the
anonymous user the moment its hook returns and `owner_id` cascades from it.

Isolation has **two independent mechanisms**, because showing one visitor
another's finances is the worst thing this system can do.

1. **Explicit scoping.** Every repository function takes `ownerId` as its first
   parameter — a branded type, not a bare string, so `f(accountId, ownerId)`
   fails to compile. No implicit context, no AsyncLocalStorage: an explicit
   parameter is visible at every call site.
2. **Row-level security.** Every owner-scoped table has a policy reading
   `current_setting('app.owner_id')`, and the application connects as a role
   that does not own the tables. A forgotten `where owner_id = ...` therefore
   returns **zero rows**, not someone else's ledger. `withOwner` uses `SET
   LOCAL`, not `SET`: LOCAL is transaction-scoped, so a pooled connection handed
   to the next request cannot inherit the previous request's tenant.

The isolation suite **runs twice** and both passes matter, which is the part
worth stealing. The normal pass has RLS enforcing. The second
(`pnpm test:isolation:app`) clears `APP_DATABASE_URL` so the suite connects as
the owning role and RLS is bypassed — and *that* is the only pass that tests the
application's own scoping. Verified by mutation: delete the owner filter from
`searchTransactions` and the first pass stays completely green, because RLS
silently covers the mistake. Only the second fails.

---

## One door through the isolation

The operator dashboard at `/admin` needs to see every visitor at once — spend,
traffic, who is using the site and what they are costing — which is exactly
what row-level security exists to prevent. Rather than let that need punch RLS
full of holes, every cross-owner read in the application lives in one file,
`packages/ledger/src/repo/admin.ts`, and a test asserts nothing else acquired
the same reach.

**Every exported function in that file takes an `AdminSession` as its first
parameter**, and the only way to produce one is `assertAdmin`, which checks a
session's email against the `ADMIN_EMAILS` allowlist (trimmed,
case-insensitive — an allowlist that fails on a stray trailing space is an
allowlist that gets disabled during an incident). The functions do not
re-check authorization themselves; one door is easier to audit than eleven
scattered checks. Unauthorized requests to `/admin` get a **404, not a 403** —
a 403 confirms the route exists, which is free reconnaissance on a public site.

`AdminSession` is a branded type — `{ readonly email: string; readonly
[verified]: true }` with a private `unique symbol` nothing outside
`assertAdmin` can name — so a plain `{ email }` object fails to satisfy it at
the call site, the way it would not if the type were a bare `{ email: string
}`. Be precise about what that buys: a deliberate `{ email } as AdminSession`
still compiles. A single `as` cast between two structurally related types
always does, and importing the private symbol changes nothing about that. The
brand stops an accident — the wrong plain object passed where a session was
expected — not someone willing to write the cast, and that is the right bar:
anyone in this codebase able to write `as AdminSession` can already call
`adminDb()` directly, so there is nothing further here for the brand to
defend against.

**`packages/ledger/src/admin-containment.test.ts` is what actually holds the
line.** It does not (and could not) assert that `adminDb()` — the
RLS-bypassing connection — appears only in `admin.ts`: repointing an owner on
sign-in spans two named owners at once, the global budget sums every owner,
and the per-owner block reads a `user` table the application role has no
privileges on at all, none of which is "an operator reading someone else's
ledger." So the test asserts the property that is actually true: the **set**
of modules holding `adminDb()` equals a reviewed allowlist, with a stated
reason against every entry, checked on both sides of the package boundary —
once inside `packages/ledger`, once for the rest of the workspace, where
exactly one other module legitimately holds it (`apps/web/src/lib/auth.ts`;
Better Auth has to resolve a user from a session token before any owner is
known, which is the query RLS exists to refuse). Adding a module to either
list is then a visible line in a diff instead of a silent widening of the
bypass — and the question that entry has to answer, before it gets a reason
written next to it, is whether the query could have been owner-scoped instead.

---

## Not spending more than the budget

The site runs on one personal card, so the ceiling is a real constraint rather
than a policy statement. Four layers, cheapest first, all computed from tables
that already exist — `trace_runs` records owner and cost per turn, so there are
no rollup tables to invalidate:

| Layer | Default | Why that number |
| --- | --- | --- |
| Per-owner daily messages | 8 anonymous / 25 signed-in | Signing in is the upgrade path, so it has to change the answer |
| Per-address daily messages | 20 | Deliberately *higher* than the anonymous quota: offices and mobile carriers put many genuine visitors behind one address, and a cap of 8 would let the first lock out the rest |
| Global daily budget | $0.667 | $20/month at a measured $0.0045 per cached web turn (`pnpm cache:report`) ≈ 148 turns/day |
| Turnstile on "start chatting" | — | Plan D |

The address key is `sha256(ip + salt + date)`, so no raw address is stored and
yesterday's keys cannot be correlated with today's — it can count a visitor
within a day but not follow them across days. Checking and charging are one
call, because a caller who forgets to charge has silently granted an unlimited
quota and nothing fails.

When a limit trips, `/api/chat` returns 503 with a machine-readable `reason`
(`owner_quota` | `ip_quota` | `daily_cap` | `blocked`) and the UI says which,
rather than showing a generic error. A **resume** is never refused for the
message quota: it was charged when the turn started, and a turn nobody can
finish leaves a write dangling with no way to answer for it.

---

## Evals

50 golden tasks in `evals/tasks/*.yaml`, across 13 classes: reports,
categorisation, budgets, recurring, anomalies, memory, multi-tool composition,
currency, refusal-to-fabricate, injection, search, guardrails and topic scope.

**Deterministic checks gate pass/fail; the judge only refines.** That ordering is
the design. An LLM judge is good at "was this answer honest and useful" and bad
at "is 2335000 the right number", so anything SQL can decide is decided by SQL
and the judge gets the rest. A task whose deterministic checks fail is failed no
matter how much the judge liked the prose — and the judge is not even called,
which keeps a failing run cheap.

Check types: `sql_equals`, `tool_was_called`, `tool_not_called`,
`no_unconfirmed_writes`, `response_contains`, `response_not_contains`,
`response_regex`, `judge`.

Two things this harness taught me about writing evals:

- **An over-specified check tests the author, not the agent.** One task required
  `get_spend_report`; the agent used `list_accounts`, which returns the same
  category total, and got the right answer by a different route. The check was
  wrong, not the agent.
- **A judge with missing context invents failures.** A declined-write task
  scored 1/5 — "the assistant hallucinated a cancellation" — because the judge
  saw the request and the reply but had no way to know the user had actually
  declined. The judge now receives the confirmation outcomes as harness ground
  truth. It still never sees the ledger, because a judge that can check
  arithmetic starts grading correctness.

```bash
pnpm eval                 # all tasks + injection suite -> evals/report/latest.{md,json}
pnpm eval:smoke           # 12-task subset
pnpm eval --filter budgets
pnpm eval --list
```

Eval runs truncate and reseed the ledger before every task, so do not run them
against a database you are also using — including the web app.

---

## MCP

`packages/mcp` exposes the same registry over stdio. Read tools always; write
tools only with `ALLOW_WRITES=1`, because there is no kakeibo UI to prompt in and
MCP clients own their own approval flow. A tool that is not listed cannot be
called by accident.

The server makes **no LLM calls at all** — it serves tools to whatever client
connects. That is enforced structurally: it imports core through subpaths rather
than the package barrel, so the provider SDK is not in its bundle.

```bash
pnpm --filter @kakeibo/mcp build

claude mcp add kakeibo -s project \
  -e DATABASE_URL=postgres://kakeibo:kakeibo@localhost:5433/kakeibo \
  -e ALLOW_WRITES=0 \
  -- node "$PWD/packages/mcp/dist/index.js"
```

A project-scoped `.mcp.json` is committed, so opening this repo in Claude Code
offers the server directly (pending your approval). For Claude Desktop:

```json
{
  "mcpServers": {
    "kakeibo": {
      "command": "node",
      "args": ["/absolute/path/to/kakeibo/packages/mcp/dist/index.js"],
      "env": { "DATABASE_URL": "postgres://kakeibo:kakeibo@localhost:5433/kakeibo" }
    }
  }
}
```

`packages/mcp/src/mcp.test.ts` drives the real SDK client over a real stdio
transport — spawning the process is the point, since a barrel import dragging in
a provider SDK or a stray `console.log` corrupting the JSON-RPC channel are both
invisible to an in-process test.

---

## Observability

Tracing is synchronous and always on. It is not a debug flag: the trace tables
*are* the deliverable, and every number in this README is read back out of them.

- `/runs` — one row per turn: channel, model, tokens, cached %, cost, latency.
- `/runs/[id]` — the timeline. Every model call with tokens, cache hits, latency
  and thought summary; every tool call with arguments and result.

---

## Testing

```bash
pnpm test        # no API key, no cost, no network
```

Tests run against **recorded fixtures** by default. `RECORD=1` writes each
(request → response) pair to `fixtures/`; `REPLAY=1` serves them back. The
fixture key is the interesting part: a naive request hash is *not* stable,
because Gemini stamps every `functionCall` with a random ID and an opaque
signature which land in the next request. The key is therefore computed over a
canonicalised request with provider identity stripped and tool_use IDs
renumbered positionally.

CI runs lint, typecheck, migrations, seed and the full suite against Postgres on
every push. Live evals run only on `workflow_dispatch`, because they cost money.

---

## The surfaces

Two genres on one site. The product pages are a 家計簿 — warm paper, sumi ink,
ruled hairlines, no accent colour — and the machine's own record keeps the dark
terminal it was born in. Crossing between them flips the ground entirely and
keeps one nav, so it reads as another room of the same building.
`apps/web/DESIGN.md` records the system.

| | |
| --- | --- |
| ![The landing page, built as a statement of account: ruled line items, each claim with the measured figure that backs it.](docs/screens/landing.jpg) | ![The dashboard for April 2025, showing spend by category, recurring merchants and the planted anomaly the detector found.](docs/screens/dashboard.jpg) |
| **`/`** — a statement of account for the system itself. Every figure is read out of `evals/report/latest.json` or counted off the tool registry at render time. | **`/dashboard`** — the same data the agent reaches for, laid out to be taken in at a glance. |
| ![The trace viewer, in the terminal genre: every model call and tool call in one timeline with tokens, cache hits, latency and cost.](docs/screens/trace.jpg) | |
| **`/runs/[id]`** — the machine room. Every model call and tool call, synchronously recorded; the numbers in this README are read back out of these tables. | |

---

## Layout

```
packages/core      agent loop, provider adapter, context, memory, guardrails, tracing, pricing
packages/ledger    Drizzle schema, double-entry repositories, all 12 tool implementations
packages/mcp       MCP stdio server over the same registry
packages/evals     harness, golden tasks, judge, report generator, injection suite
apps/cli           readline chat with streaming and a y/n confirm gate
apps/web           Next.js: landing, chat, dashboard, evals, trace viewer, admin
```

Dependency direction is one-way: `ledger` → `core`; `mcp`, `evals` and the apps
depend on both.

## Not built, on purpose

No bring-your-own-key — one code path, everyone uses the owner's. No paid
tiers. No PDF parsing. No live bank
connections or live FX. Only one live LLM provider: the `ProviderAdapter`
interface is the seam that makes a Claude or OpenAI adapter a drop-in, and
writing one is a day's work, but shipping an untested second provider to claim
"multi-provider" would be worse than not having it.

pgvector semantic memory recall is a stretch. Voice mode (Web Speech API) is
specified and not yet built.

## License

MIT.
