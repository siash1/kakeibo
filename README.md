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

---

## The numbers

Everything below is measured by a script in this repo and reproducible with one
command. Nothing here is an estimate.

| metric | value | reproduce |
| --- | --- | --- |
| Eval pass rate | **PASS_RATE** | `pnpm eval` |
| Injection block rate | **100%** (6/6) | `pnpm injection:report` |
| Context-cache token savings | **CACHE_ALL** overall, **CACHE_STEADY** steady state | `pnpm cache:report` |
| Cost saved by caching | **COST_SAVED** | `pnpm cache:report` |
| Median / p95 turn latency | **MEDIAN_LAT** / **P95_LAT** | `pnpm eval` |
| Median cost per eval task | **MEDIAN_COST** (list price) | `pnpm eval` |
| Context estimate error vs `countTokens` | **EST_ERROR** | `pnpm eval` |
| Tests | **TEST_COUNT** across TEST_FILES files, no API key needed | `pnpm test` |
| Tools | 12 | `pnpm cli` then `/help` |
| Core loop | **LOOP_LOC lines** (`packages/core/src/loop.ts`) | — |

Cost figures are list-price estimates from `packages/core/src/pricing.ts`, read
from Google's published Vertex pricing. They are useful as *relative* numbers —
cached versus uncached, Flash versus Pro — which is what they are used for.

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

`pnpm check:providers` exists because model IDs move faster than any document.
It probes each role's candidate chain against the account you actually have and
prints the `.env` lines to paste.

**Auth.** `GEMINI_AUTH=vertex` (default) uses application-default credentials —
`gcloud auth application-default login`. `GEMINI_AUTH=apikey` uses an AI Studio
key. Both paths are supported by the same adapter and both are tested.

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
pauses the loop for a human: CLI prompts y/n, web emits an SSE `confirm_request`
and blocks on a promise resolved by `POST /api/confirm`, MCP simply does not
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
a `chars/4` estimate in between. Both are traced, so the estimate's error is a
measured number rather than a claim.

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

## Evals

46 golden tasks in `evals/tasks/*.yaml`, across 12 classes: reports,
categorisation, budgets, recurring, anomalies, memory, multi-tool composition,
currency, refusal-to-fabricate, injection, search and guardrails.

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

## Layout

```
packages/core      agent loop, provider adapter, context, memory, guardrails, tracing, pricing
packages/ledger    Drizzle schema, double-entry repositories, all 12 tool implementations
packages/mcp       MCP stdio server over the same registry
packages/evals     harness, golden tasks, judge, report generator, injection suite
apps/cli           readline chat with streaming and a y/n confirm gate
apps/web           Next.js: chat, trace viewer, evals report
```

Dependency direction is one-way: `ledger` → `core`; `mcp`, `evals` and the apps
depend on both.

## Not built, on purpose

No accounts or multi-tenancy — single user, local. No PDF parsing. No live bank
connections or live FX. Only one live LLM provider: the `ProviderAdapter`
interface is the seam that makes a Claude or OpenAI adapter a drop-in, and
writing one is a day's work, but shipping an untested second provider to claim
"multi-provider" would be worse than not having it.

pgvector semantic memory recall is a stretch. Voice mode (Web Speech API) is
specified and not yet built.

## License

MIT.
