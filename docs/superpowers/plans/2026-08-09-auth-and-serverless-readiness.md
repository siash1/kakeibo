# Auth and Serverless Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-owner local app into a real multi-user one: every visitor is a Better Auth user from their first request, conversations survive between requests, the agent loop can suspend across processes for a human decision, and no month can cost more than the configured ceiling.

**Architecture:** Better Auth (Drizzle adapter, anonymous plugin) supplies `owner_id`, which Plan A already threads everywhere. Conversation history and suspended turns move from `globalThis` into Postgres. `runTurn` gains a suspend/resume path so the confirm-before-write gate works on serverless, where `/api/chat` and `/api/confirm` are different invocations. Quotas and a global budget cap are computed from `trace_runs`, which already records cost per turn.

**Tech Stack:** better-auth 1.6, Drizzle ORM, PostgreSQL, Next.js 15 App Router, TypeScript strict, Vitest.

This is Plan B of three. Plan A (merged) made every ledger row owner-scoped with an RLS backstop. Plan C adds the admin dashboard, the visitor map and deployment.

## Global Constraints

Copied verbatim from `CLAUDE.md`; every task's requirements include these.

- **No AI co-author trailers in commits.** No `Co-Authored-By: Claude`, no "Generated with" footers. Author is the repository owner.
- **TypeScript strict everywhere.** `any` only at the provider wire boundary, with a comment.
- **Money is integer minor units** (paise). Never floats outside display.
- **Secrets never in git.** `.env` is gitignored; `.env.example` carries empty values only.
- **No agent frameworks in core.** `@google/genai` is a typed HTTP client only.
- **Every ledger query is owner-scoped.** New repository reads go into `packages/ledger/src/isolation.test.ts`.
- **The isolation suite runs twice**; never fix a failure in the RLS-bypassed pass by adjusting the assertion.
- `pnpm lint && pnpm typecheck && pnpm test` must pass before every commit.
- Better Auth's principal table is `user`, a reserved word: **always quote it** as `"user"` in hand-written SQL.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/core/src/suspend.ts` | **Create.** `ConfirmPolicy`, `PendingConfirmation`, `SuspendedState` — the vocabulary of a paused turn. |
| `packages/core/src/loop.ts` | **Modify.** Suspend and resume paths. |
| `packages/core/src/trace.ts` | **Modify.** `Tracer.resumeRun` so a resumed turn continues one trace rather than starting a second. |
| `packages/ledger/src/schema.ts` | **Modify.** `conversations`, `conversation_messages`, `suspended_turns`, `rate_limits`; `blocked_at` on `user`. |
| `packages/ledger/src/auth-schema.ts` | **Create.** Better Auth's generated tables, kept separate from the ledger's. |
| `packages/ledger/src/repo/conversations.ts` | **Create.** Message and suspended-turn persistence. |
| `packages/ledger/src/repo/quota.ts` | **Create.** Owner, IP and global budget checks. |
| `apps/web/src/lib/auth.ts` | **Create.** The Better Auth server instance. |
| `apps/web/src/lib/auth-client.ts` | **Create.** The browser client. |
| `apps/web/src/lib/owner.ts` | **Create.** Session → `OwnerId`, the single door every route uses. |
| `apps/web/src/app/api/auth/[...all]/route.ts` | **Create.** Better Auth's handler. |

`suspend.ts` is its own file rather than part of `loop.ts`: the ledger and the web app both need these types, and neither should import the loop to get them.

---

### Task 1: The vocabulary of a paused turn

**Files:**
- Create: `packages/core/src/suspend.ts`
- Test: `packages/core/src/suspend.test.ts`

**Interfaces:**
- Produces: `ConfirmPolicy`, `PendingConfirmation`, `SuspendedState`, `isWritePending`.

**Why a policy object replaces the bare callback.** Today `runTurn` takes `confirm: ConfirmFn` and blocks on it. That works when the decider is in the same process — the CLI's readline, an eval script — and cannot work when it is a browser on the far side of a second HTTP request. Making the *strategy* explicit lets the same loop serve both without a boolean flag that means "actually don't call this".

- [x] **Step 1: Write the failing test**

```ts
// packages/core/src/suspend.test.ts
import { describe, expect, it } from 'vitest'
import { isWritePending, type SuspendedState } from './suspend'

describe('suspend vocabulary', () => {
  it('recognises a state that is waiting on a decision', () => {
    const state: SuspendedState = {
      runId: '11111111-1111-4111-8111-111111111111',
      history: [],
      completedResults: [],
      pending: [
        { id: 'call_0_set_budget', tool: 'set_budget', args: {}, summary: 'set a budget' },
      ],
      usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0, thoughtTokens: 0 },
      costUsdEst: 0.0001,
      iterations: 1,
    }
    expect(isWritePending(state)).toBe(true)
  })

  it('does not treat an empty pending list as waiting', () => {
    const state: SuspendedState = {
      runId: '11111111-1111-4111-8111-111111111111',
      history: [],
      completedResults: [],
      pending: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, thoughtTokens: 0 },
      costUsdEst: 0,
      iterations: 0,
    }
    expect(isWritePending(state)).toBe(false)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/suspend.test.ts`
Expected: FAIL — `Cannot find module './suspend'`.

- [x] **Step 3: Write the implementation**

```ts
// packages/core/src/suspend.ts
import type { ConfirmFn } from './registry'
import type { CanonicalMessage, ToolResultBlock, Usage } from './types'

/**
 * How this turn answers the write-confirmation gate.
 *
 * The gate used to be a single callback the loop awaited. That works when the
 * decider lives in the same process — the CLI's readline prompt, an eval
 * script — and cannot work when it is a browser on the far side of a second
 * HTTP request: on serverless, /api/chat and /api/confirm are different
 * invocations with no shared memory to await across.
 *
 * Making the strategy explicit lets one loop serve both without a flag that
 * quietly means "do not actually call the callback you were given".
 */
export type ConfirmPolicy =
  /** Block in-process. The CLI. */
  | { mode: 'inline'; confirm: ConfirmFn }
  /** Approve without asking. MCP with ALLOW_WRITES=1; eval turns marked allow. */
  | { mode: 'auto-allow' }
  /** Refuse without asking. Eval turns marked deny or none. */
  | { mode: 'auto-deny' }
  /** Stop the turn and hand the decision back to the caller. The web. */
  | { mode: 'suspend' }

/** One write the model proposed and a human has not yet ruled on. */
export interface PendingConfirmation {
  /** The tool_use id, so a decision can be matched back without extra plumbing. */
  id: string
  tool: string
  args: unknown
  /** One line, in the user's terms, describing what will change. */
  summary: string
}

/**
 * Everything needed to pick a turn back up in a different process.
 *
 * `usage` and `costUsdEst` are carried deliberately. The model calls made
 * before the pause are real spend, and a resumed turn that started its totals
 * at zero would leave them out of the trace — which is exactly the spend the
 * budget cap most needs to see, since turns involving a confirmation are the
 * expensive ones.
 */
export interface SuspendedState {
  runId: string
  /** Messages up to and including the assistant turn that requested the tools. */
  history: CanonicalMessage[]
  /** Read-tier results already executed, so resume does not re-run them. */
  completedResults: ToolResultBlock[]
  pending: PendingConfirmation[]
  usage: Usage
  costUsdEst: number
  iterations: number
}

export interface ResumeInput {
  state: SuspendedState
  decisions: { id: string; allowed: boolean }[]
}

export function isWritePending(state: SuspendedState): boolean {
  return state.pending.length > 0
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/suspend.test.ts`
Expected: PASS, 2 tests.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/suspend.ts packages/core/src/suspend.test.ts
git commit -m "Add the vocabulary of a paused turn

ConfirmPolicy makes the confirmation strategy explicit rather than implied by
a callback the loop may or may not await. The gate has to serve both an
in-process decider (the CLI) and a browser on the far side of a second HTTP
request, and on serverless there is no shared memory to await across."
```

---

### Task 2: A resumed turn continues one trace

**Files:**
- Modify: `packages/core/src/trace.ts`, `packages/ledger/src/repo/tracer.ts`
- Test: `packages/ledger/src/repo/tracer.test.ts`

**Interfaces:**
- Produces: `Tracer.resumeRun(runId: string): Promise<TraceRunHandle>` on the interface, `InMemoryTracer` and `DbTracer`.

Without this a suspended turn produces two `trace_runs` rows, the trace viewer shows half a conversation twice, and the per-owner quota counts one turn as two.

- [x] **Step 1: Write the failing test**

```ts
// packages/ledger/src/repo/tracer.test.ts
import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId } from '../owner'
import { resetOwners } from '../testing'
import { DbTracer, getRun, listRuns } from './tracer'

loadEnv()

const owner = asOwnerId('00000000-0000-4000-8000-0000000ac001')

beforeAll(async () => {
  await resetOwners(owner)
}, 60_000)

afterAll(async () => {
  await closeDb()
})

describe('resuming a run', () => {
  it('continues the same trace rather than starting a second', async () => {
    const tracer = new DbTracer(owner)
    const run = await tracer.startRun({ provider: 'gemini', model: 'test', channel: 'web' })
    await run.event({ type: 'model_call', payload: { iteration: 0 } })

    const resumed = await tracer.resumeRun(run.id)
    await resumed.event({ type: 'tool_call', payload: { name: 'set_budget' } })
    await resumed.finish({
      status: 'ok',
      usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0, thoughtTokens: 0 },
      costUsdEst: 0.001,
      latencyMs: 500,
    })

    expect(resumed.id).toBe(run.id)
    expect(await listRuns(owner, 50)).toHaveLength(1)

    const detail = await getRun(owner, run.id)
    // Sequence numbers must continue, not restart: two events at seq 0 would
    // sort ambiguously and the timeline would render out of order.
    expect(detail?.events.map((e) => e.seq)).toEqual([0, 1])
    expect(detail?.run.status).toBe('ok')
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ledger/src/repo/tracer.test.ts`
Expected: FAIL — `tracer.resumeRun is not a function`.

- [x] **Step 3: Add `resumeRun` to the interface and both implementations**

In `packages/core/src/trace.ts`:

```ts
export interface Tracer {
  startRun(info: { provider: string; model: string; channel: Channel }): Promise<TraceRunHandle>
  /**
   * Reopens an existing run so a suspended turn continues one trace.
   *
   * Without it a turn that paused for a confirmation produces two runs: the
   * viewer shows half a conversation twice, and the per-owner quota counts one
   * turn as two.
   */
  resumeRun(runId: string): Promise<TraceRunHandle>
}
```

`InMemoryTracer.resumeRun` finds the run and continues its `seq` from `run.events.length`. `NoopTracer.resumeRun` mirrors `startRun`.

In `packages/ledger/src/repo/tracer.ts`, `DbTracer.resumeRun` reads the current maximum sequence for the run and continues from it:

```ts
async resumeRun(runId: string): Promise<TraceRunHandle> {
  const owner = this.owner
  // Continue the sequence from what is already stored. Restarting at 0 would
  // put two events at the same seq, and the timeline sorts on it.
  const rows = await withOwner(owner, (tx) =>
    tx
      .select({ maxSeq: sql<number>`coalesce(max(${traceEvents.seq}), -1)::int` })
      .from(traceEvents)
      .where(and(eq(traceEvents.ownerId, owner), eq(traceEvents.runId, runId))),
  )
  let seq = Number(rows[0]?.maxSeq ?? -1) + 1
  return this.handle(runId, () => seq++)
}
```

Refactor the body shared with `startRun` into a private `handle(id, nextSeq)` returning the `TraceRunHandle`, so the event and finish logic exists once.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ledger/src/repo/tracer.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/trace.ts packages/ledger/src/repo/tracer.ts packages/ledger/src/repo/tracer.test.ts
git commit -m "Let a resumed turn continue one trace

A turn that pauses for a confirmation would otherwise write two trace_runs
rows: the viewer shows half a conversation twice and the per-owner quota
counts one turn as two. resumeRun continues the existing run's sequence
rather than restarting at zero, which the timeline sorts on."
```

---

### Task 3: The loop suspends

**Files:**
- Modify: `packages/core/src/loop.ts`
- Test: `packages/core/src/suspend-loop.test.ts`

**Interfaces:**
- Consumes: `ConfirmPolicy`, `SuspendedState` (Task 1); `Tracer.resumeRun` (Task 2).
- Produces: `RunTurnOptions.confirmPolicy`, `TurnResult.status === 'suspended'`, `TurnResult.suspended`.

**The parallel-batch rule.** The provider requires the number of `functionResponse` parts to equal the number of `functionCall` parts in the turn being answered. So the loop cannot answer one call in a batch and suspend on another: **all** writes in a batch suspend together, and the read-tier results from that same batch are carried in `completedResults` rather than re-run.

- [x] **Step 1: Write the failing test**

```ts
// packages/core/src/suspend-loop.test.ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runTurn } from './loop'
import { ToolRegistry, type ToolSpec } from './registry'
import { ScriptedAdapter, textBlock, toolUseBlock } from './testing'
import { InMemoryTracer } from './trace'
import type { CanonicalMessage } from './types'

const readTool: ToolSpec<{ value: string }> = {
  name: 'lookup',
  tier: 'read',
  description: 'Reads something',
  input: z.object({ value: z.string() }),
  handler: async (input) => ({ looked_up: input.value }),
}

const writeTool: ToolSpec<{ amount: number }> = {
  name: 'set_thing',
  tier: 'write',
  description: 'Writes a thing',
  input: z.object({ amount: z.number() }),
  summarize: (input) => `set the thing to ${input.amount}`,
  handler: async (input) => ({ written: input.amount }),
}

function registry(): ToolRegistry {
  return new ToolRegistry().registerAll([readTool, writeTool] as unknown as ToolSpec<unknown>[])
}

const base = {
  history: [] as CanonicalMessage[],
  model: 'scripted',
  summarizerModel: 'scripted',
  channel: 'web' as const,
  system: 'test system prompt',
}

describe('suspend', () => {
  it('stops at a write and hands back what it was about to do', async () => {
    const adapter = new ScriptedAdapter([
      { content: [toolUseBlock('c1', 'set_thing', { amount: 5 })] },
    ])
    const tracer = new InMemoryTracer()

    const result = await runTurn({
      ...base,
      userMessage: 'set it to 5',
      adapter,
      registry: registry(),
      tracer,
      confirmPolicy: { mode: 'suspend' },
    })

    expect(result.status).toBe('suspended')
    expect(result.suspended?.pending).toHaveLength(1)
    expect(result.suspended?.pending[0]).toMatchObject({
      id: 'c1',
      tool: 'set_thing',
      summary: 'set the thing to 5',
    })
    // The tool must NOT have run.
    expect(result.toolCalls.filter((c) => c.name === 'set_thing' && c.confirmed)).toEqual([])
    // Spend before the pause is carried, or the resumed turn under-reports it.
    expect(result.suspended?.usage.inputTokens).toBeGreaterThan(0)
  })

  it('runs the reads in a mixed batch and carries their results', async () => {
    // The provider requires response count to equal call count, so a batch
    // cannot be answered piecemeal. Reads execute now, writes wait, and the
    // read results are carried so resume does not run them twice.
    const adapter = new ScriptedAdapter([
      {
        content: [
          toolUseBlock('r1', 'lookup', { value: 'a' }),
          toolUseBlock('w1', 'set_thing', { amount: 1 }),
          toolUseBlock('w2', 'set_thing', { amount: 2 }),
        ],
      },
    ])

    const result = await runTurn({
      ...base,
      userMessage: 'do three things',
      adapter,
      registry: registry(),
      tracer: new InMemoryTracer(),
      confirmPolicy: { mode: 'suspend' },
    })

    expect(result.status).toBe('suspended')
    expect(result.suspended?.pending.map((p) => p.id)).toEqual(['w1', 'w2'])
    expect(result.suspended?.completedResults).toHaveLength(1)
    expect(result.suspended?.completedResults[0]?.tool_use_id).toBe('r1')
  })

  it('does not suspend when there is no write', async () => {
    const adapter = new ScriptedAdapter([
      { content: [toolUseBlock('r1', 'lookup', { value: 'a' })] },
      { content: [textBlock('Found it.')] },
    ])

    const result = await runTurn({
      ...base,
      userMessage: 'look it up',
      adapter,
      registry: registry(),
      tracer: new InMemoryTracer(),
      confirmPolicy: { mode: 'suspend' },
    })

    expect(result.status).toBe('ok')
    expect(result.text).toBe('Found it.')
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/suspend-loop.test.ts`
Expected: FAIL — `confirmPolicy` is not a known option.

- [x] **Step 3: Implement the suspend path**

In `packages/core/src/loop.ts`:

1. Replace `confirm: ConfirmFn` in `RunTurnOptions` with `confirmPolicy: ConfirmPolicy`.
2. `TurnResult.status` widens to `RunStatus | 'suspended'`; add `suspended?: SuspendedState`.
3. Split step (g) so reads and writes are handled separately:

```ts
// g. Execute the batch. Under a suspend policy, reads run now and writes stop
//    the turn — the provider requires response count to equal call count, so a
//    batch cannot be answered piecemeal.
const writes = toolUses.filter((use) => options.registry.get(use.name)?.tier === 'write')

if (options.confirmPolicy.mode === 'suspend' && writes.length > 0) {
  const reads = toolUses.filter((use) => !writes.includes(use))
  const completedResults = await Promise.all(
    reads.map((use) => executeToolUse(use, options, run, toolCalls, true)),
  )

  const pending: PendingConfirmation[] = writes.map((use) => {
    const spec = options.registry.get(use.name)!
    const parsed = spec.input.safeParse(use.input)
    return {
      id: use.id,
      tool: use.name,
      args: parsed.success ? parsed.data : use.input,
      summary: summarizeCall(spec, parsed.success ? parsed.data : use.input),
    }
  })

  for (const item of pending) {
    await run.event({ type: 'confirm', payload: { ...item, allowed: null, suspended: true } })
  }

  status = 'suspended'
  return finishTurn({
    suspended: {
      runId: run.id,
      history,
      completedResults,
      pending,
      usage: { ...totals },
      costUsdEst,
      iterations,
    },
  })
}
```

`executeToolUse` gains a final `skipConfirmation` parameter, true only for reads on this path (a read never confirms anyway; the flag documents that the caller has already decided).

4. `finishTurn` is a small local helper assembling `TurnResult` from the accumulated locals, so the suspend path and the normal path cannot drift.

5. Map the other policies where the old `confirm` was called:

```ts
const decide = async (request: ConfirmRequest): Promise<boolean> => {
  switch (options.confirmPolicy.mode) {
    case 'inline':
      return options.confirmPolicy.confirm(request)
    case 'auto-allow':
      return true
    case 'auto-deny':
      return false
    case 'suspend':
      // Unreachable: the suspend branch above returns before any write is
      // executed. Denying is the safe reading if it is ever reached.
      return false
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/suspend-loop.test.ts`
Expected: PASS, 3 tests.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/loop.ts packages/core/src/suspend-loop.test.ts
git commit -m "Let the agent loop suspend at a write

Under the suspend policy the loop stops at the first batch containing a
write, returns what it was about to do, and runs nothing. Reads in the same
batch execute immediately and their results are carried, because the provider
requires functionResponse count to equal functionCall count - a batch cannot
be answered piecemeal, and re-running the reads on resume would let the data
shift underneath the decision."
```

---

### Task 4: The loop resumes

**Files:**
- Modify: `packages/core/src/loop.ts`
- Test: `packages/core/src/suspend-loop.test.ts` (extend)

**Interfaces:**
- Produces: `RunTurnOptions.resume?: ResumeInput`.

- [x] **Step 1: Write the failing test**

```ts
// append to packages/core/src/suspend-loop.test.ts
describe('resume', () => {
  it('runs approved writes, refuses the rest, and answers the batch in one message', async () => {
    const first = new ScriptedAdapter([
      {
        content: [
          toolUseBlock('r1', 'lookup', { value: 'a' }),
          toolUseBlock('w1', 'set_thing', { amount: 1 }),
          toolUseBlock('w2', 'set_thing', { amount: 2 }),
        ],
      },
    ])
    const tracer = new InMemoryTracer()
    const suspended = await runTurn({
      ...base,
      userMessage: 'do three things',
      adapter: first,
      registry: registry(),
      tracer,
      confirmPolicy: { mode: 'suspend' },
    })

    const second = new ScriptedAdapter([{ content: [textBlock('Did one of them.')] }])
    const result = await runTurn({
      ...base,
      userMessage: '',
      adapter: second,
      registry: registry(),
      tracer,
      confirmPolicy: { mode: 'suspend' },
      resume: {
        state: suspended.suspended!,
        decisions: [
          { id: 'w1', allowed: true },
          { id: 'w2', allowed: false },
        ],
      },
    })

    expect(result.status).toBe('ok')
    expect(result.text).toBe('Did one of them.')

    // All three results, in one message, in call order. Any other shape is a
    // hard 400 from the provider.
    const answered = second.requests[0]?.messages.at(-1)
    expect(answered?.role).toBe('user')
    const results = (answered?.content ?? []).filter((b) => b.type === 'tool_result')
    expect(results.map((b) => (b as { tool_use_id: string }).tool_use_id)).toEqual(['r1', 'w1', 'w2'])
    expect((results[2] as { content: string }).content).toContain('User declined')

    // One trace, and the pre-pause spend is included.
    expect(result.runId).toBe(suspended.runId)
    expect(result.usage.inputTokens).toBeGreaterThan(suspended.suspended!.usage.inputTokens)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/suspend-loop.test.ts -t resume`
Expected: FAIL — `resume` is not a known option.

- [x] **Step 3: Implement the resume path**

At the top of `runTurn`, before the user message is appended:

```ts
if (options.resume) {
  const { state, decisions } = options.resume
  // Continue the existing trace: a resumed turn is the same turn.
  run = await options.tracer.resumeRun(state.runId)

  // Seed the totals from before the pause. Starting at zero would hide the
  // model calls that led to the confirmation from both the trace and the
  // budget cap.
  Object.assign(totals, state.usage)
  costUsdEst = state.costUsdEst
  iterations = state.iterations
  history = state.history

  const byId = new Map(decisions.map((d) => [d.id, d.allowed]))
  const writeResults: ToolResultBlock[] = []
  for (const item of state.pending) {
    const allowed = byId.get(item.id) === true
    await run.event({ type: 'confirm', payload: { ...item, allowed } })
    if (!allowed) {
      writeResults.push({
        type: 'tool_result',
        tool_use_id: item.id,
        name: item.tool,
        content: 'User declined. Do not retry without new instruction.',
      })
      continue
    }
    writeResults.push(
      await executeToolUse(
        { type: 'tool_use', id: item.id, name: item.tool, input: item.args },
        options,
        run,
        toolCalls,
        true,
      ),
    )
  }

  // Reassemble in the model's original call order. The provider pairs
  // responses positionally when ids are absent, so order is not cosmetic.
  const order = new Map<string, number>()
  const lastAssistant = history.at(-1)
  ;(lastAssistant?.content ?? []).forEach((block, index) => {
    if (block.type === 'tool_use') order.set(block.id, index)
  })
  const merged = [...state.completedResults, ...writeResults].sort(
    (a, b) => (order.get(a.tool_use_id) ?? 0) - (order.get(b.tool_use_id) ?? 0),
  )

  history = [...history, { role: 'user', content: merged }]
  // Fall through into the main loop, which now calls the model with a fully
  // answered batch.
}
```

Guard the "append user message" and `contextManager.fit` steps behind `if (!options.resume)`.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/suspend-loop.test.ts`
Expected: PASS, 4 tests.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/loop.ts packages/core/src/suspend-loop.test.ts
git commit -m "Let the agent loop resume from a decision

Resume seeds its totals from the suspended state rather than zero, so the
model calls that led to the confirmation appear in the trace and count
against the budget - those are the expensive turns, and they are exactly the
ones that would have gone unmeasured.

Results are reassembled in the model's original call order because the
provider pairs responses positionally when ids are absent, so ordering is
correctness rather than cosmetics."
```

---

### Task 5: Migrate every caller to the policy

**Files:**
- Modify: `apps/cli/src/index.ts`, `packages/mcp/src/index.ts`, `packages/evals/src/runner.ts`, `packages/evals/src/injection.ts`, `apps/web/src/app/api/chat/route.ts`, `packages/core/src/loop.test.ts`, `scripts/cache-report.ts`

Nothing compiles until this is done: `confirm` is gone from `RunTurnOptions`.

- [x] **Step 1: Update each surface**

| Surface | Policy |
| --- | --- |
| CLI | `{ mode: 'inline', confirm }` — readline prompt, unchanged behaviour |
| MCP | not applicable; the MCP server calls tools directly, not `runTurn` |
| Eval turn `confirm: allow` | `{ mode: 'auto-allow' }` |
| Eval turn `confirm: deny` or `none` | `{ mode: 'auto-deny' }` |
| Injection suite | `{ mode: 'auto-deny' }`, and it records what was proposed from `toolCalls` |
| Web | `{ mode: 'suspend' }` (Task 12 wires the round trip) |
| `cache-report.ts` | `{ mode: 'auto-deny' }` |

The eval runner previously recorded confirmations by capturing `ConfirmRequest`s. Under a policy there is no callback, so it reads proposals from `result.toolCalls` (which records `tier` and `confirmed`) instead. `no_unconfirmed_writes` keeps working because it already reasons over `toolCalls`.

- [x] **Step 2: Verify the whole suite**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: all green, including the injection suite — the guardrail behaviour is unchanged, only the plumbing.

- [x] **Step 3: Verify the CLI still gates writes**

```bash
printf 'Set my Dining budget for 2025-07 to 8000 rupees.\nn\n/exit\n' | pnpm cli
```

Expected: the confirm prompt appears, `n` declines, and the reply acknowledges the cancellation without retrying.

- [x] **Step 4: Commit**

```bash
git add -A
git commit -m "Migrate every surface to the confirmation policy

The CLI keeps its blocking prompt as an inline policy, evals script
allow/deny per turn, and the web declares suspend. The eval runner now reads
proposed writes from result.toolCalls rather than from a callback, which it
was already doing for no_unconfirmed_writes."
```

---

### Task 6: Better Auth schema and instance

**Files:**
- Create: `packages/ledger/src/auth-schema.ts`, `apps/web/src/lib/auth.ts`, `apps/web/src/lib/auth-client.ts`, `apps/web/src/app/api/auth/[...all]/route.ts`
- Modify: `packages/ledger/src/db.ts`, `.env.example`, `apps/web/package.json`

- [x] **Step 1: Install**

```bash
pnpm --filter @kakeibo/web add better-auth
pnpm --filter @kakeibo/ledger add better-auth
```

- [x] **Step 2: Generate the auth schema**

```bash
cd apps/web && npx @better-auth/cli generate --output ../../packages/ledger/src/auth-schema.ts
```

The generated file holds `user`, `session`, `account` and `verification`. Add the two columns kakeibo needs, with a comment explaining why they live here rather than in a parallel table:

```ts
// Both are read on every authenticated request; a parallel table would be a
// join on the hot path for two booleans.
blockedAt: timestamp('blocked_at', { withTimezone: true }),
isAnonymous: boolean('is_anonymous').notNull().default(false),
```

- [x] **Step 3: Wire the auth instance**

```ts
// apps/web/src/lib/auth.ts
import { anonymous } from 'better-auth/plugins'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { adminDb, schema } from '@kakeibo/ledger'
import { repointOwner } from '@kakeibo/ledger'

export const auth = betterAuth({
  // adminDb, not the app connection: Better Auth manages its own tables and
  // must not be subject to the ledger's row-level security.
  database: drizzleAdapter(adminDb(), { provider: 'pg', schema }),
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    },
  },
  plugins: [
    anonymous({
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        // The plugin deletes the anonymous user immediately after this hook, so
        // the ledger has to be repointed here rather than lazily.
        await repointOwner(anonymousUser.user.id, newUser.user.id)
      },
    }),
  ],
})
```

- [x] **Step 4: Route handler and client**

```ts
// apps/web/src/app/api/auth/[...all]/route.ts
import { auth } from '@/lib/auth'
import { toNextJsHandler } from 'better-auth/next-js'

export const { GET, POST } = toNextJsHandler(auth)
```

```ts
// apps/web/src/lib/auth-client.ts
import { anonymousClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({ plugins: [anonymousClient()] })
```

- [x] **Step 5: Env**

Add to `.env.example` with empty values, and to `.env` with real ones:

```
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

Generate a local secret with `openssl rand -base64 32`. Google OAuth may be left empty locally; email/password and anonymous both work without it, and the sign-in UI hides the Google button when the client id is absent.

- [x] **Step 6: Generate and apply the migration**

```bash
cd packages/ledger && npx drizzle-kit generate && cd ../.. && pnpm db:migrate
```

Verify: `select count(*) from information_schema.tables where table_name in ('user','session','account','verification')` returns 4.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "Add Better Auth with the anonymous plugin

Every visitor is a user from their first request; anonymous ones simply have
no credentials attached yet, which is what collapses two principal types into
one and makes owner_id always user.id.

Better Auth connects through adminDb: it manages its own tables and must not
be subject to the ledger's row-level security. blocked_at and is_anonymous
live on the user table rather than a parallel one because both are read on
every authenticated request."
```

---

### Task 7: Repointing a ledger on sign-in

**Files:**
- Create: `packages/ledger/src/repo/link.ts`
- Test: `packages/ledger/src/repo/link.test.ts`

**Interfaces:**
- Produces: `repointOwner(from: string, to: string): Promise<{ moved: Record<string, number> }>`

The anonymous plugin deletes the anonymous user immediately after `onLinkAccount`, so the ledger must be repointed inside that hook. One transaction; a partial repoint would strand rows against a user row that is about to disappear.

- [x] **Step 1: Write the failing test**

```ts
// packages/ledger/src/repo/link.test.ts
import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId } from '../owner'
import { resetOwners } from '../testing'
import { ensureSeedAccounts, requireAccount } from './accounts'
import { repointOwner } from './link'
import { searchTransactions, createTransaction } from './transactions'

loadEnv()

const anon = asOwnerId('00000000-0000-4000-8000-00000000aa01')
const real = asOwnerId('00000000-0000-4000-8000-00000000aa02')

beforeAll(async () => {
  await resetOwners(anon, real)
  await ensureSeedAccounts(anon)
  const checking = await requireAccount(anon, 'Checking')
  const groceries = await requireAccount(anon, 'Groceries')
  await createTransaction(anon, {
    date: '2025-03-01',
    description: 'ANON PURCHASE',
    postings: [
      { accountId: checking.id, amountMinor: -5000 },
      { accountId: groceries.id, amountMinor: 5000 },
    ],
  })
}, 60_000)

afterAll(async () => {
  await closeDb()
})

describe('repointOwner', () => {
  it('moves the whole ledger to the new owner and leaves nothing behind', async () => {
    const before = await searchTransactions(anon, { query: 'ANON PURCHASE', limit: 10 })
    expect(before).toHaveLength(1)

    await repointOwner(anon, real)

    expect(await searchTransactions(anon, { query: 'ANON PURCHASE', limit: 10 })).toEqual([])
    const after = await searchTransactions(real, { query: 'ANON PURCHASE', limit: 10 })
    expect(after).toHaveLength(1)
    // The postings moved too, or the transaction is a shell with no money.
    expect(after[0]?.postings).toHaveLength(2)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ledger/src/repo/link.test.ts`
Expected: FAIL — `Cannot find module './link'`.

- [x] **Step 3: Write the implementation**

```ts
// packages/ledger/src/repo/link.ts
import { eq } from 'drizzle-orm'
import { adminDb } from '../db'
import {
  accounts, budgets, conversationMessages, conversations, importBatches,
  memories, postings, rules, suspendedTurns, traceEvents, traceRuns, transactions,
} from '../schema'

const OWNED = [
  traceEvents, traceRuns, suspendedTurns, conversationMessages, conversations,
  postings, transactions, budgets, rules, memories, importBatches, accounts,
] as const

/**
 * Moves every row belonging to one owner to another, in one transaction.
 *
 * Called from Better Auth's onLinkAccount when an anonymous visitor signs in.
 * The plugin deletes the anonymous user immediately afterwards, so this cannot
 * be lazy: a partial repoint would strand rows against a user row that is
 * about to disappear.
 *
 * adminDb because it spans two owners by definition, which is exactly what the
 * row-level security policies forbid.
 */
export async function repointOwner(
  from: string,
  to: string,
): Promise<{ moved: Record<string, number> }> {
  return adminDb().transaction(async (tx) => {
    const moved: Record<string, number> = {}
    for (const table of OWNED) {
      const rows = await tx
        .update(table)
        .set({ ownerId: to })
        .where(eq(table.ownerId, from))
        .returning({ id: table.id })
      moved[String((table as { _: { name: string } })._.name)] = rows.length
    }
    return { moved }
  })
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ledger/src/repo/link.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/ledger/src/repo/link.ts packages/ledger/src/repo/link.test.ts
git commit -m "Repoint a ledger when an anonymous visitor signs in

One transaction, because the anonymous plugin deletes the anonymous user
immediately after the hook returns and a partial repoint would strand rows
against a user row that is about to disappear.

Spans two owners by definition, which is what the RLS policies forbid, so it
runs on adminDb."
```

---

### Task 8: Conversation persistence

**Files:**
- Modify: `packages/ledger/src/schema.ts`
- Create: `packages/ledger/src/repo/conversations.ts`, `packages/ledger/src/repo/conversations.test.ts`

**Interfaces:**
- Produces: `createConversation`, `appendMessages`, `loadHistory`, `saveSuspendedTurn`, `takeSuspendedTurn`.

- [x] **Step 1: Add the tables**

`conversations`, `conversation_messages`, `suspended_turns` per the spec, each with `ownerId: ownerId()` and an RLS policy in a new hand-written migration mirroring `0002_rls.sql`.

- [x] **Step 2: Write the failing test**

```ts
// packages/ledger/src/repo/conversations.test.ts — the assertion that matters
it('round-trips providerMeta, including the thought signature', async () => {
  const conversation = await createConversation(owner)
  await appendMessages(owner, conversation.id, [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'x1',
          name: 'get_spend_report',
          input: { period: '2025-03' },
          providerMeta: { providerCallId: 'x1', thoughtSignature: 'SIG-ABC' },
        },
      ],
    },
  ])

  const history = await loadHistory(owner, conversation.id)
  const block = history[0]?.content[0]
  // Losing this is a hard 400 on the next request, and only on tool turns —
  // so a persistence layer that "cleans up" the message shape fails in
  // production and passes every test that does not check for it.
  expect((block as { providerMeta?: Record<string, unknown> }).providerMeta).toEqual({
    providerCallId: 'x1',
    thoughtSignature: 'SIG-ABC',
  })
})
```

Plus: `takeSuspendedTurn` returns the state once and deletes it, so a decision cannot be replayed to run a write twice.

- [x] **Step 3: Run test to verify it fails**, implement, **Step 4: verify it passes**

Store `message` as `jsonb` verbatim — no mapping, no field selection.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "Persist conversations and suspended turns

Messages are stored verbatim as jsonb. Gemini 3.x attaches an opaque
thoughtSignature to functionCall parts and replaying a tool turn without it
is a hard 400, so a persistence layer that normalises the message shape
breaks only on tool turns and only in production.

takeSuspendedTurn deletes as it reads, so a decision cannot be replayed to
run the same write twice."
```

---

### Task 9: Quotas and the budget cap

**Files:**
- Create: `packages/ledger/src/repo/quota.ts`, `packages/ledger/src/repo/quota.test.ts`
- Modify: `packages/ledger/src/schema.ts` (`rate_limits`), `packages/core/src/env.ts`

**Interfaces:**
- Produces: `checkQuota({ owner, ipHash, isAnonymous }): Promise<QuotaVerdict>` where `QuotaVerdict = { allowed: true } | { allowed: false; reason: 'owner_quota' | 'ip_quota' | 'daily_cap' | 'blocked' }`

- [x] **Step 1: Write the failing test**

Cover each verdict separately, and one that matters more than it looks:

```ts
it('counts a suspended turn once, not twice', async () => {
  // A turn that pauses for a confirmation writes one trace_runs row and
  // resumes into the same one. If the quota counted rows naively it would
  // charge two messages for one, and the cheapest way to hit a quota would be
  // to ask for something that needs approval.
  // ...
})
```

- [x] **Step 2: Implement**

Owner and global from `trace_runs`; IP from `rate_limits` keyed by `sha256(ip + RATE_LIMIT_SALT + date)` so raw addresses are never stored. New env with defaults: `ANON_DAILY_MESSAGE_QUOTA=8`, `USER_DAILY_MESSAGE_QUOTA=25`, `IP_DAILY_MESSAGE_QUOTA=20`, `GLOBAL_DAILY_BUDGET_USD=0.667`, `RATE_LIMIT_SALT=`.

- [x] **Step 3: Verify, Step 4: Commit**

```bash
git commit -m "Add per-owner, per-IP and global budget limits

Three layers, cheapest first, all computed from trace_runs which already
records cost per turn. The IP key is a salted hash so raw addresses are never
stored, and the per-IP cap is deliberately higher than the anonymous quota:
offices and mobile carriers put many genuine visitors behind one address.

The global cap is the one that protects a personal card, so it is checked
last and independently of the other two."
```

---

### Task 10: The web round trip

**Files:**
- Create: `apps/web/src/lib/owner.ts`
- Modify: `apps/web/src/app/api/chat/route.ts`, `apps/web/src/app/api/confirm/route.ts`, `apps/web/src/app/page.tsx`
- Delete: `apps/web/src/lib/session.ts`

- [x] **Step 1: Session → owner**

```ts
// apps/web/src/lib/owner.ts
/**
 * The single door from an HTTP request to an OwnerId.
 *
 * Anonymous visitors are signed in transparently on first contact, so every
 * request has an owner and no route ever has to branch on "logged in or not".
 */
export async function resolveOwner(request: Request): Promise<ResolvedOwner> { /* ... */ }
```

- [x] **Step 2: Replace the globalThis session**

`/api/chat` loads history from Postgres, runs the turn with `{ mode: 'suspend' }`, and on a suspended result persists the state and emits `confirm_request` per pending write, then closes the stream. `/api/confirm` takes the decisions, calls `takeSuspendedTurn`, and resumes — streaming the rest of the turn back on *that* response.

This removes the cross-request promise entirely, which is the point: nothing is awaited across invocations any more.

- [x] **Step 3: Verify end to end**

```bash
pnpm dev
# allow path: budget lands in the ledger
# deny path : nothing is written, reply acknowledges
# quota path: 9th anonymous message returns 503 with reason owner_quota
```

- [x] **Step 4: Commit**

---

### Task 11: The anonymous reaper

**Files:** `packages/ledger/src/scripts/reap.ts`, test.

Deletes anonymous users older than 24 hours; `on delete cascade` removes their ledger. Runs from a Vercel cron in Plan C. The test asserts it deletes an aged anonymous user, leaves a fresh one, and leaves a signed-in one of any age.

---

### Task 12: Documentation

`docs/kakeibo_spec.md` §16 gains the new env vars, `README.md` gains a section on the suspendable loop (it is the most interview-relevant thing in the codebase), and `CLAUDE.md` gains the rule that `runTurn` takes a policy rather than a callback.

---

## Self-Review

**Spec coverage.** §2 identity → Tasks 6, 7. §3.3 new tables → Tasks 8, 9. §3.4 user columns → Task 6. §5 cost control → Task 9. §6 suspendable loop → Tasks 1–5. §10 env → Tasks 6, 9. Left for Plan C: §3.5 geolocation, §9 admin dashboard, deployment.

**Placeholder scan.** Tasks 8–12 are specified more tersely than 1–7 by design: they are conventional CRUD and wiring over patterns Plan A established, whereas the suspend/resume path is novel and gets full code. If an implementer finds Task 8 or 9 underspecified, that is a plan bug — expand it before writing code rather than guessing.

**Type consistency.** `ConfirmPolicy` is the parameter name in Tasks 1, 3, 4, 5. `SuspendedState` field names are identical in Tasks 1, 3, 4, 8. `repointOwner(from, to)` uses plain `string`, not `OwnerId`, because Better Auth hands over raw ids and validating them is `asOwnerId`'s job at the call site.

**The risk worth naming.** Task 5 changes every caller in one commit, exactly as Plan A's Task 8 did, and for the same reason: removing `confirm` from `RunTurnOptions` breaks all of them at once. Its safeguard is the same — the CLI must still gate a write and the injection suite must stay at 100%.

---

## What actually happened

All twelve tasks are implemented and merged. Where the work diverged from the
plan, it diverged for a reason worth recording.

**Task 5 was not finished.** The web chat route still passed `confirm`, so the
branch did not typecheck when this session picked it up. Completing it was the
first commit.

**`owner_id` gained its foreign key here rather than being deferred again.**
Plan A left `references "user"(id)` for Plan B because the table did not exist
yet; Task 6 creates it, so the constraint landed with it. That forced
`user.id` to be a uuid (`advanced.database.generateId: 'uuid'`), since nine
ledger tables carry `owner_id uuid` and Postgres will not join text to uuid, and
it forced every surface that writes without a session — seeding, the eval
harness, the test helpers — to create its fixed owner's principal first. The
alternative was widening every owner column to text and giving up `asOwnerId`'s
validation.

**The auth tables have their privileges revoked from `app_user`.** Not in the
plan. `0002_rls.sql`'s `ALTER DEFAULT PRIVILEGES` grants the application role
everything on tables created after it, and those four carry no `owner_id` for a
policy to scope by — so the application role would have been able to read every
visitor's email. Referential integrity is unaffected because Postgres runs it as
the referenced table's owner, which is asserted rather than assumed.

**`repointOwner` discards rather than merges when the target already has a
ledger.** The plan did not anticipate that `accounts` is unique on
`(owner_id, name)` and every ledger is a clone of the same corpus, so both sides
have a "Groceries" — repointing on top of one is a constraint violation, and
merging by name would double every figure in every report.

**`appendMessages` became `replaceHistory`.** The context manager rewrites
history when the window fills, swapping a run of older messages for a summary,
and an append-only table cannot express that. It also removes the need to
compute a delta at resume, which is not computable after an eviction.

**`consumeQuota` checks and charges in one call**, rather than the plan's pure
`checkQuota`. Split in two, a caller that forgets the second half has silently
granted an unlimited per-address quota and nothing fails. It also takes
`kind: 'message' | 'resume'`, because a resume was already charged when the turn
started and a turn nobody can finish leaves a write dangling.

**`ensureLedger` was missing from the plan entirely.** Task 10 cannot be
demonstrated without it: a new visitor's ledger is empty and the agent has
nothing to talk about. It clones the corpus lazily on the first request that
needs one, and deliberately without `deterministicIds` — those keys are derived
from the CSV row alone and carry no owner, so the second visitor cloned would
collide with the first on the transactions primary key.

**The reaper also sweeps `rate_limits`.** It is the one table with no
`owner_id`, which is deliberate, and which means nothing else would ever delete
a row from it.

**One bug was found and fixed by the end-to-end verification.** The resume path
and `executeToolUse` each recorded a `confirm` trace event for the same
decision, under different ids — which would have doubled every "writes allowed"
figure the admin dashboard computes from the timeline in Plan C.

Left for Plan C, unchanged: §3.5 geolocation, §9 admin dashboard, Turnstile,
deployment, and the sign-in UI.
