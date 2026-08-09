# Working on kakeibo

Conventions for anyone — human or agent — writing code in this repo.

## Authorship and commits

**Never credit Claude, Anthropic, or any AI tool as an author or co-author of a
commit.** Specifically:

- Do **not** add `Co-Authored-By: Claude ...` (or any other AI co-author
  trailer) to commit messages.
- Do **not** add "Generated with Claude Code", "🤖 Generated with ...", or
  similar footers to commits, pull request bodies, issue comments, or code
  comments.
- Do **not** set `author` or `committer` to anything other than the repository
  owner.

The commit trail is the owner's. This applies to every commit, amend, rebase and
PR body, including ones written by an agent. If a tool or default template adds
such a trailer automatically, strip it before committing.

Commit messages should explain **why**, not restate the diff. The existing
history is the style reference: a one-line summary, a blank line, then the
reasoning and any findings that shaped the change.

## Ground rules from the spec

These are decided and not up for re-litigation (see `docs/kakeibo_spec.md`):

1. **No agent frameworks.** No LangChain, LangGraph, CrewAI, or any SDK's
   automatic tool-runner or chat-session helper. `@google/genai` is used as a
   typed HTTP client only. The loop is the product.
2. **TypeScript strict everywhere.** `any` only at the provider wire boundary,
   with a comment saying so.
3. **Every performance or cost number must be measured.** `pnpm metrics` prints
   every figure the README claims. If a number cannot be reproduced by a script
   in this repo, it does not go in the README.
4. **Money is integer minor units.** Never floats, anywhere but display.
5. **Synthetic data only in git.** Real statements live in `data/private/`,
   which is gitignored.
6. **Secrets never in git.** `.env` is gitignored; `.env.example` is committed
   and must never contain a real key.
7. **Every ledger query is owner-scoped.** Repository functions take `OwnerId`
   as their first parameter, and Postgres RLS refuses unscoped reads. If you add
   a repository read, add it to `packages/ledger/src/isolation.test.ts` — a
   function missing from that table is a leak waiting to happen.

   The isolation suite runs twice and both passes matter. The normal pass has
   RLS enforcing; the second (`pnpm test:isolation:app`, with
   `APP_DATABASE_URL` cleared) connects as the owning role so RLS is bypassed,
   and is the only pass that actually tests the application's own scoping.
   Never "fix" a failure there by adjusting the assertion.

   `owner_id` references `"user"(id)` — Better Auth's table, a reserved word,
   quote it — `on delete cascade`. Deleting a user is the whole implementation
   of both the anonymous reaper and "delete everything". If you add an
   owner-scoped table, add it to `OWNED` in `packages/ledger/src/repo/link.ts`;
   `repointOwner`, `deleteOwnerRows` and the test helpers all read that one
   list, and a coverage test derives the expected set from the schema.

8. **`runTurn` takes a `ConfirmPolicy`, not a callback.** `'inline'` for the
   CLI, `'auto-allow'` / `'auto-deny'` for evals and MCP, `'suspend'` for the
   web. Under `'suspend'` the loop stops at the first batch containing a write
   and returns a `SuspendedState`; the caller persists it and a second request
   resumes from a decision. Do not reintroduce a `confirm` callback the loop
   awaits — on serverless there is no shared memory to await across, and that
   is the whole reason the policy exists.

9. **Anything that persists a `CanonicalMessage` stores it verbatim.** Gemini
   3.x attaches an opaque `thoughtSignature` to `functionCall` parts, and
   replaying a tool turn without it is a hard 400. A layer that normalises the
   message shape breaks only on tool turns and only in production.

10. **Cross-owner reads live in `packages/ledger/src/repo/admin.ts`, and take
    an `AdminSession`.** That module is the only place in the application
    permitted to bypass row-level security; every function in it takes an
    `AdminSession` — producible only by `assertAdmin`, checked against
    `ADMIN_EMAILS` — as its first parameter, rather than re-checking
    authorization itself. `packages/ledger/src/admin-containment.test.ts`
    asserts the set of modules holding the RLS-bypassing connection equals a
    reviewed allowlist with a reason per entry. Adding a module to that
    allowlist is a deliberate act, not a fix for a failing test: the first
    question is always whether the query could have been owner-scoped instead,
    and only once that has a real answer does the new entry get a reason
    written next to it.

11. **Dates in hand-written SQL must be UTC-anchored.** `current_date` and
    `<date> - interval` both evaluate in the database session's timezone —
    `Asia/Kolkata` on the development machine, UTC on the intended production
    host — so a bound built from either silently picks a different day
    depending on which database it runs against. `admin.ts` and
    `packages/ledger/src/repo/quota.ts` each define a `UTC_DAY_START` constant
    that pins midnight UTC as a `timestamptz` instant instead of a bare date;
    the second is a deliberate duplicate of the first, not an import, because
    importing from `admin.ts` — the RLS-bypass door — would give the
    containment test another module to name for a one-line expression.

## Layout

```
packages/core      agent loop, provider adapter, context, memory, guardrails, tracing, pricing
packages/ledger    Drizzle schema, double-entry repositories, all 12 tool implementations
packages/mcp       MCP stdio server over the same registry
packages/evals     harness, golden tasks, judge, report generator, injection suite
apps/cli           readline chat
apps/web           Next.js: chat, trace viewer, evals report
```

Dependency direction is one-way: `ledger` → `core`; `mcp`, `evals` and the apps
depend on both. Do not introduce a cycle.

`packages/mcp` and `packages/ledger` import core through **subpaths**
(`@kakeibo/core/env`, `@kakeibo/core/registry`) rather than the package barrel.
The barrel re-exports the Gemini adapter, and the MCP server must not pull a
provider SDK into a process that makes no model calls.

## Before committing

```bash
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` runs against recorded fixtures and needs no API key. If you change
the system prompt, the tool schemas or the canonical message format, the
fixtures will miss — re-record them:

```bash
pnpm db:reset && pnpm db:seed && RECORD=1 pnpm injection:report
```

Eval runs (`pnpm eval`) truncate and reseed the ledger before every task. Do not
run them against a database something else is using — including the web app.

## Adding a tool

Add it to `packages/ledger/src/tools/index.ts` and it appears in the agent loop,
the MCP server and the eval harness at once. There is nothing else to wire.
Declare the tier honestly: anything that writes is `write`, and write means the
loop stops for a human.

Tool descriptions should say *when* to reach for the tool, not just what it
does — that is what actually drives selection.
