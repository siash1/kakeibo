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
