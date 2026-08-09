import { randomUUID } from 'node:crypto'
import { ContextManager } from './context'
import { type MemoryStore, recallMemories } from './memory'
import { estimateCostUsd, estimateUncachedCostUsd } from './pricing'
import { SYSTEM_PROMPT, wrapToolData, wrapUserMemory } from './prompt'
import {
  type Channel,
  type ConfirmRequest,
  summarizeCall,
  type ToolContext,
  type ToolRegistry,
  truncate,
} from './registry'
import type { ConfirmPolicy, PendingConfirmation, ResumeInput, SuspendedState } from './suspend'
import { clipForTrace, type RunStatus, type TraceRunHandle, type Tracer } from './trace'
import type {
  CanonicalMessage,
  ContentBlock,
  ProviderAdapter,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from './types'

/**
 * The agent loop (spec 8.3). This is the whole product in one function, and it
 * is deliberately short enough to read in one sitting.
 *
 * Why it terminates: every iteration either ends the turn (the model emitted no
 * tool calls) or consumes one of a bounded number of iterations. There is no
 * path that adds iterations, and the iteration cap is enforced before the
 * provider is called again — so the worst case is MAX_ITERATIONS model calls
 * plus one forced no-tools completion, never an unbounded loop.
 *
 * Why tool errors do not crash it: a failing tool returns a tool_result with
 * is_error set, which is *data the model can read and react to*. Validation
 * failures come back as the validation message. The model then corrects itself
 * on the next iteration, which is exactly the behaviour you want and is
 * impossible if the exception propagates.
 *
 * Why all parallel results go back in one message: the provider requires the
 * number of functionResponse parts to equal the number of functionCall parts in
 * the turn being answered — splitting them across two turns is a hard 400. It
 * also keeps the model willing to emit parallel calls at all, since it sees them
 * answered as a batch.
 */

const MAX_ITERATIONS = 12
const MAX_OUTPUT_TOKENS = 16_000

export interface RunTurnOptions {
  userMessage: string
  history: CanonicalMessage[]
  adapter: ProviderAdapter
  registry: ToolRegistry
  tracer: Tracer
  model: string
  summarizerModel: string
  channel: Channel
  /** How this turn answers the write gate (spec §6). */
  confirmPolicy: ConfirmPolicy
  /** Present when picking a suspended turn back up. */
  resume?: ResumeInput
  system?: string
  memory?: MemoryStore
  /** Category names used for memory recall matching. */
  knownCategories?: string[]
  contextManager?: ContextManager
  onText?: (delta: string) => void
  onThought?: (delta: string) => void
  onToolCall?: (call: { id: string; name: string; args: unknown; tier: string }) => void
  onToolResult?: (result: { id: string; name: string; summary: string; isError: boolean }) => void
  signal?: AbortSignal
  maxIterations?: number
  toolChoice?: { mode: 'auto' | 'any' | 'none'; allowedNames?: string[] }
  /** Overrides the context budget; tests use it to force eviction cheaply. */
  budgetTokens?: number
}

export interface ToolCallRecord {
  id: string
  name: string
  args: unknown
  tier: string
  isError: boolean
  confirmed?: boolean
  latencyMs: number
  result: string
}

export interface TurnResult {
  runId: string
  text: string
  history: CanonicalMessage[]
  usage: Usage
  costUsdEst: number
  /** What the same tokens would have cost with no cache hits — the savings baseline. */
  uncachedCostUsdEst: number
  latencyMs: number
  status: RunStatus | 'suspended'
  /** Present when status is 'suspended': everything needed to resume. */
  suspended?: SuspendedState
  iterations: number
  toolCalls: ToolCallRecord[]
  /** Set when the turn ended on a block or an error. */
  errorMessage?: string
  evictions: number
  thoughtSummaries: string[]
}

export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const started = Date.now()
  const system = options.system ?? SYSTEM_PROMPT
  const tools = options.registry.declarations()
  const contextManager = options.contextManager ?? new ContextManager()
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS

  // Resume reopens the existing run so a suspended turn stays one trace.
  const run: TraceRunHandle = options.resume
    ? await options.tracer.resumeRun(options.resume.state.runId)
    : await options.tracer.startRun({
        provider: options.adapter.name,
        model: options.model,
        channel: options.channel,
      })

  const totals: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, thoughtTokens: 0 }
  const toolCalls: ToolCallRecord[] = []
  const thoughtSummaries: string[] = []
  let costUsdEst = 0
  let uncachedCostUsdEst = 0
  let evictions = 0
  let status: RunStatus | 'suspended' = 'ok'
  let errorMessage: string | undefined
  let finalText = ''

  let history: CanonicalMessage[] = []
  let iterations = 0
  let cacheRef: string | undefined

  if (options.resume) {
    const { state, decisions } = options.resume

    // Seed the totals from before the pause. Starting at zero would hide the
    // model calls that led to the confirmation from both the trace and the
    // budget cap — and turns involving a confirmation are the expensive ones.
    Object.assign(totals, state.usage)
    costUsdEst = state.costUsdEst
    iterations = state.iterations
    history = state.history

    const byId = new Map(decisions.map((d) => [d.id, d.allowed]))
    const writeResults: ToolResultBlock[] = []

    for (const item of state.pending) {
      const allowed = byId.get(item.id) === true
      await run.event({
        type: 'confirm',
        payload: { ...item, args: clipForTrace(item.args), allowed },
      })

      if (!allowed) {
        writeResults.push({
          type: 'tool_result',
          tool_use_id: item.id,
          name: item.tool,
          content: 'User declined. Do not retry without new instruction.',
        })
        toolCalls.push({
          id: item.id,
          name: item.tool,
          args: item.args,
          tier: 'write',
          isError: false,
          confirmed: false,
          latencyMs: 0,
          result: 'User declined. Do not retry without new instruction.',
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
    // responses positionally when ids are absent, so ordering is correctness
    // rather than cosmetics.
    const order = new Map<string, number>()
    const lastAssistant = history[history.length - 1]
    for (const [index, block] of (lastAssistant?.content ?? []).entries()) {
      if (block.type === 'tool_use') order.set(block.id, index)
    }
    const merged = [...state.completedResults, ...writeResults].sort(
      (a, b) => (order.get(a.tool_use_id) ?? 0) - (order.get(b.tool_use_id) ?? 0),
    )

    history = [...history, { role: 'user', content: merged }]
  } else {
    // On resume none of this applies: the user message was appended on the
    // suspended turn, the window was already fitted, and re-fitting could evict
    // the very assistant turn whose tool calls we are about to answer.
    // 1. Append the user message, with recalled memories riding on the same turn.
    //    Memories go *after* the stable prefix, never inside the system
    //    instruction, so injecting them cannot invalidate the cache (spec 8.4).
    const userBlocks: ContentBlock[] = [{ type: 'text', text: options.userMessage }]
    if (options.memory) {
      const recalled = await recallMemories(options.memory, {
        question: options.userMessage,
        knownCategories: options.knownCategories ?? [],
      })
      if (recalled.length > 0) {
        userBlocks.push({ type: 'text', text: wrapUserMemory(recalled.map((m) => m.content)) })
      }
    }

    history = [...options.history, { role: 'user', content: userBlocks }]

    // 2. Fit the window before the first call of the turn.
    const fit = await contextManager.fit(history, {
      system,
      tools,
      adapter: options.adapter,
      model: options.model,
      summarizerModel: options.summarizerModel,
      trace: run,
      ...(options.budgetTokens !== undefined ? { budgetTokens: options.budgetTokens } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    history = fit.messages
    if (fit.evicted) evictions++

    // Explicit context cache over the stable prefix (system + tools), if the
    // adapter supports one and the prefix is big enough to qualify (spec 5.5).
    cacheRef = (await options.adapter.ensureCache?.(options.model, system, tools)) ?? undefined
  }

  // 4. LOOP
  for (;;) {
    if (options.signal?.aborted) {
      status = 'aborted'
      errorMessage = 'Turn aborted.'
      break
    }

    // a. Model call.
    const result = await options.adapter.stream({
      model: options.model,
      system,
      messages: history,
      tools,
      maxTokens: MAX_OUTPUT_TOKENS,
      ...(cacheRef ? { cacheRef } : {}),
      ...(options.onText ? { onText: options.onText } : {}),
      ...(options.onThought ? { onThought: options.onThought } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
    })

    totals.inputTokens += result.usage.inputTokens
    totals.outputTokens += result.usage.outputTokens
    totals.cachedTokens += result.usage.cachedTokens
    totals.thoughtTokens += result.usage.thoughtTokens
    costUsdEst += estimateCostUsd({ model: options.model, ...result.usage })
    uncachedCostUsdEst += estimateUncachedCostUsd({ model: options.model, ...result.usage })

    const turnThoughts = result.message.content
      .filter((b) => b.type === 'thought_summary')
      .map((b) => (b as { text: string }).text)
    thoughtSummaries.push(...turnThoughts)

    await run.event({
      type: 'model_call',
      latencyMs: result.latencyMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedTokens: result.usage.cachedTokens,
      ...(turnThoughts.length > 0 ? { thoughtSummary: turnThoughts.join('\n\n') } : {}),
      payload: {
        iteration: iterations,
        model: options.model,
        modelVersion: result.modelVersion,
        stopReason: result.stopReason,
        replayed: result.replayed ?? false,
        cacheRef: cacheRef ?? null,
        messageCount: history.length,
        content: clipForTrace(result.message.content),
        ...(result.errorMessage ? { error: result.errorMessage } : {}),
      },
    })

    // b. Blocked: the refusal analogue. Record it, tell the user why, stop. No
    //    auto-retry — retrying a safety block is how you turn one refusal into a
    //    loop of them.
    if (result.stopReason === 'blocked') {
      status = 'blocked'
      errorMessage = result.errorMessage ?? 'The provider blocked this response.'
      finalText = `I could not answer that: ${errorMessage}`
      await run.event({ type: 'error', payload: { kind: 'blocked', message: errorMessage } })
      break
    }

    // c. Ran out of output budget mid-answer. Surfacing this is better than
    //    handing back a sentence that stops halfway and looks like an answer.
    if (result.stopReason === 'max_tokens') {
      status = 'error'
      errorMessage = 'The response hit the output token limit.'
      finalText = textOf(result.message.content)
      await run.event({ type: 'error', payload: { kind: 'max_tokens' } })
      break
    }

    if (result.stopReason === 'error') {
      status = options.signal?.aborted ? 'aborted' : 'error'
      errorMessage = result.errorMessage ?? 'Provider error.'
      await run.event({ type: 'error', payload: { kind: 'provider', message: errorMessage } })
      break
    }

    // d. Record what the model said, including the tool_use blocks with their
    //    provider signatures intact — dropping those breaks the next request.
    history = [...history, result.message]

    // e. No tool calls: the text is the answer.
    const toolUses = result.message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    if (toolUses.length === 0) {
      finalText = textOf(result.message.content)
      break
    }

    // f. Iteration cap. Rather than truncating mid-thought, feed the model a
    //    synthetic error per outstanding call and give it one final, tool-free
    //    turn to say something useful with what it already has.
    iterations++
    if (iterations > maxIterations) {
      history = [
        ...history,
        {
          role: 'user',
          content: toolUses.map(
            (use): ToolResultBlock => ({
              type: 'tool_result',
              tool_use_id: use.id,
              name: use.name,
              content: `Iteration limit of ${maxIterations} reached. No further tools will run.`,
              is_error: true,
            }),
          ),
        },
      ]
      await run.event({ type: 'error', payload: { kind: 'iteration_limit', iterations } })

      const final = await options.adapter.stream({
        model: options.model,
        system,
        messages: history,
        tools: [],
        maxTokens: MAX_OUTPUT_TOKENS,
        ...(cacheRef ? {} : {}),
        ...(options.onText ? { onText: options.onText } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      totals.inputTokens += final.usage.inputTokens
      totals.outputTokens += final.usage.outputTokens
      totals.cachedTokens += final.usage.cachedTokens
      costUsdEst += estimateCostUsd({ model: options.model, ...final.usage })
      uncachedCostUsdEst += estimateUncachedCostUsd({ model: options.model, ...final.usage })
      history = [...history, final.message]
      finalText = textOf(final.message.content)
      status = 'error'
      errorMessage = `Iteration limit (${maxIterations}) reached.`
      break
    }

    // g. Execute the batch.
    //
    //    Under a suspend policy a batch containing any write stops the turn.
    //    It cannot be answered piecemeal: the provider requires the number of
    //    functionResponse parts to equal the number of functionCall parts, so
    //    all writes in a batch suspend together. Reads in the same batch run
    //    now and their results are carried, rather than re-run on resume where
    //    the data could have shifted underneath the decision.
    if (options.confirmPolicy.mode === 'suspend') {
      const writes = toolUses.filter((use) => options.registry.get(use.name)?.tier === 'write')

      if (writes.length > 0) {
        const reads = toolUses.filter((use) => !writes.includes(use))
        const completedResults = await Promise.all(
          reads.map((use) => executeToolUse(use, options, run, toolCalls, true)),
        )

        const pending: PendingConfirmation[] = writes.map((use) => {
          const spec = options.registry.get(use.name)!
          const parsed = spec.input.safeParse(use.input)
          const args = parsed.success ? parsed.data : use.input
          return { id: use.id, tool: use.name, args, summary: summarizeCall(spec, args) }
        })

        for (const item of pending) {
          await run.event({
            type: 'confirm',
            payload: { ...item, args: clipForTrace(item.args), allowed: null, suspended: true },
          })
        }

        const latencyMs = Date.now() - started
        return {
          runId: run.id,
          text: textOf(result.message.content),
          history,
          usage: totals,
          costUsdEst,
          uncachedCostUsdEst,
          latencyMs,
          status: 'suspended',
          suspended: {
            runId: run.id,
            history,
            completedResults,
            pending,
            usage: { ...totals },
            costUsdEst,
            iterations,
          },
          iterations,
          toolCalls,
          evictions,
          thoughtSummaries,
        }
      }
    }

    const results = await Promise.all(
      toolUses.map((use) => executeToolUse(use, options, run, toolCalls)),
    )

    // h. All results in ONE user message. Never split.
    history = [...history, { role: 'user', content: results }]
  }

  const latencyMs = Date.now() - started
  await run.finish({ status, usage: totals, costUsdEst, latencyMs })

  return {
    runId: run.id,
    text: finalText,
    history,
    usage: totals,
    costUsdEst,
    uncachedCostUsdEst,
    latencyMs,
    status,
    iterations,
    toolCalls,
    ...(errorMessage ? { errorMessage } : {}),
    evictions,
    thoughtSummaries,
  }
}

async function executeToolUse(
  use: ToolUseBlock,
  options: RunTurnOptions,
  run: TraceRunHandle,
  record: ToolCallRecord[],
  /**
   * True when the caller has already ruled on this call: a read (which never
   * confirms) executed on the suspend path, or an approved write on resume.
   */
  skipConfirmation = false,
): Promise<ToolResultBlock> {
  const started = Date.now()
  const spec = options.registry.get(use.name)

  const emit = (content: string, isError: boolean, confirmed?: boolean): ToolResultBlock => {
    const latencyMs = Date.now() - started
    record.push({
      id: use.id,
      name: use.name,
      args: use.input,
      tier: spec?.tier ?? 'unknown',
      isError,
      ...(confirmed === undefined ? {} : { confirmed }),
      latencyMs,
      result: truncate(content, 500),
    })
    options.onToolResult?.({
      id: use.id,
      name: use.name,
      summary: truncate(content, 200),
      isError,
    })
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      name: use.name,
      content,
      ...(isError ? { is_error: true } : {}),
    }
  }

  if (!spec) {
    // Hallucinated tool name. Telling the model exactly what does exist turns a
    // dead end into a self-correction on the next iteration.
    const available = options.registry.names().join(', ')
    const message = `No tool named "${use.name}". Available tools: ${available}.`
    await run.event({
      type: 'tool_call',
      latencyMs: 0,
      payload: { name: use.name, error: 'unknown_tool' },
    })
    return emit(message, true)
  }

  options.onToolCall?.({ id: use.id, name: use.name, args: use.input, tier: spec.tier })

  // Schema re-validation at execution is the enforcement layer (spec 8.6.2).
  // Gemini has no server-side strict-schema guarantee, so a declaration is a
  // request, not a constraint — this is where the constraint actually lives.
  const parsed = spec.input.safeParse(use.input)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    const message = `Invalid arguments for ${use.name}: ${issues}. Fix the arguments and call it again.`
    await run.event({
      type: 'tool_call',
      latencyMs: Date.now() - started,
      payload: {
        name: use.name,
        args: clipForTrace(use.input),
        error: 'validation_failed',
        issues,
      },
    })
    return emit(message, true)
  }

  // Write tier pauses the loop for a human (spec 8.6.1).
  let confirmed: boolean | undefined
  if (spec.tier === 'write') {
    const request = {
      id: randomUUID(),
      tool: spec.name,
      tier: spec.tier,
      args: parsed.data,
      summary: summarizeCall(spec, parsed.data),
    }
    confirmed = skipConfirmation ? true : await decideByPolicy(options.confirmPolicy, request)
    await run.event({
      type: 'confirm',
      latencyMs: Date.now() - started,
      payload: { ...request, args: clipForTrace(request.args), allowed: confirmed },
    })
    if (!confirmed) {
      return emit('User declined. Do not retry without new instruction.', false, false)
    }
  }

  const ctx: ToolContext = {
    channel: options.channel,
    confirm: async () => decideByPolicy(options.confirmPolicy),
    ...(options.signal ? { signal: options.signal } : {}),
  }

  try {
    const output = await spec.handler(parsed.data, ctx)
    const rendered = renderToolOutput(output)
    await run.event({
      type: 'tool_call',
      latencyMs: Date.now() - started,
      payload: {
        name: use.name,
        tier: spec.tier,
        args: clipForTrace(parsed.data),
        result: clipForTrace(output),
        ...(confirmed === undefined ? {} : { confirmed }),
      },
    })
    // Everything a tool returns is untrusted data, including data the ledger
    // itself stores — the hostile strings in the seed set arrived through a CSV
    // import, so "it came from our own database" proves nothing (spec 8.6.3).
    return emit(wrapToolData(rendered), false, confirmed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await run.event({
      type: 'tool_call',
      latencyMs: Date.now() - started,
      payload: { name: use.name, args: clipForTrace(parsed.data), error: message },
    })
    return emit(`Tool ${use.name} failed: ${message}`, true, confirmed)
  }
}

/**
 * Applies the confirmation policy.
 *
 * 'suspend' returns false as a safety net only: the suspend branch in the loop
 * returns before any write reaches here, so this is unreachable in practice and
 * denying is the only safe reading if it ever is reached.
 */
async function decideByPolicy(policy: ConfirmPolicy, request?: ConfirmRequest): Promise<boolean> {
  switch (policy.mode) {
    case 'inline':
      return request ? policy.confirm(request) : false
    case 'auto-allow':
      return true
    default:
      return false
  }
}

function renderToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  return JSON.stringify(output, null, 2) ?? 'null'
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')
    .trim()
}
