import { env } from './env'
import { wrapContextSummary } from './prompt'
import { estimateTokens } from './replay'
import type { TraceRunHandle } from './trace'
import type { CanonicalMessage, ProviderAdapter, ToolDef } from './types'

/**
 * Sliding-window context management with summarise-and-evict (spec 8.4).
 *
 * The only genuinely tricky part is *what a unit of eviction is*. It is not a
 * message. A tool call and its results are one indivisible thing: the provider
 * rejects a history where a functionCall part has no matching functionResponse,
 * so dropping "the oldest message" can produce a conversation the API refuses to
 * accept at all. Eviction therefore works on turn groups — a real user message
 * plus every assistant message and tool-result message that followed it before
 * the next real user message.
 *
 * Four things are never evicted: the system instruction (it is not in this list
 * at all, it rides on the request config), the tool declarations (likewise), the
 * pinned summary, and the most recent `KEEP_RECENT_TURNS` groups.
 */

const KEEP_RECENT_TURNS = 6
const SUMMARY_MARKER = '<context_summary>'

export interface FitResult {
  messages: CanonicalMessage[]
  /** True when the window actually moved on this turn. */
  evicted: boolean
  tokensBefore: number
  tokensAfter: number
  /** Groups removed from the window. */
  evictedTurns: number
  summary?: string
}

export interface FitOptions {
  system: string
  tools: ToolDef[]
  adapter: ProviderAdapter
  model: string
  summarizerModel: string
  trace?: TraceRunHandle
  /** Overrides CONTEXT_BUDGET_TOKENS; used by tests to force eviction cheaply. */
  budgetTokens?: number
  signal?: AbortSignal
}

export class ContextManager {
  /**
   * Real countTokens at turn start and after any eviction; the chars/4 estimate
   * in between. Both are recorded so the estimate's error is a measured number
   * rather than a claim (spec 8.4, metric in 18).
   */
  lastRealCount = 0
  lastEstimate = 0

  async fit(history: CanonicalMessage[], options: FitOptions): Promise<FitResult> {
    const budget = options.budgetTokens ?? env().CONTEXT_BUDGET_TOKENS
    const tokensBefore = await this.count(history, options)

    if (tokensBefore <= budget) {
      return {
        messages: history,
        evicted: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        evictedTurns: 0,
      }
    }

    const groups = groupTurns(history)
    const pinned = groups[0] && isSummaryGroup(groups[0]) ? groups[0] : undefined
    const body = pinned ? groups.slice(1) : groups

    // Nothing to give: everything left is either pinned or inside the recent
    // window. Running anyway and letting the provider complain is better than
    // silently dropping context the loop promised to keep.
    if (body.length <= KEEP_RECENT_TURNS) {
      return {
        messages: history,
        evicted: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        evictedTurns: 0,
      }
    }

    const evictable = body.slice(0, body.length - KEEP_RECENT_TURNS)
    const kept = body.slice(body.length - KEEP_RECENT_TURNS)

    const previousSummary = pinned ? extractSummary(pinned) : undefined
    const summary = await this.summarize(evictable, previousSummary, options)

    const messages: CanonicalMessage[] = [
      ...summaryGroup(summary),
      ...kept.flatMap((g) => g.messages),
    ]

    const tokensAfter = await this.count(messages, options)

    await options.trace?.event({
      type: 'summary_eviction',
      payload: {
        evictedTurns: evictable.length,
        evictedMessages: evictable.reduce((n, g) => n + g.messages.length, 0),
        keptTurns: kept.length,
        tokensBefore,
        tokensAfter,
        budget,
        summary,
      },
    })

    return {
      messages,
      evicted: true,
      tokensBefore,
      tokensAfter,
      evictedTurns: evictable.length,
      summary,
    }
  }

  /** Cheap between-call estimate; the loop uses this to decide when to re-count. */
  estimate(history: CanonicalMessage[], system: string, tools: ToolDef[]): number {
    this.lastEstimate = estimateTokens(system, history, tools)
    return this.lastEstimate
  }

  /** Estimate error as a fraction of the real count, or null before a real count exists. */
  estimateError(): number | null {
    if (this.lastRealCount === 0) return null
    return (this.lastEstimate - this.lastRealCount) / this.lastRealCount
  }

  private async count(history: CanonicalMessage[], options: FitOptions): Promise<number> {
    this.lastEstimate = estimateTokens(options.system, history, options.tools)
    try {
      const real = await options.adapter.countTokens(
        options.model,
        options.system,
        history,
        options.tools,
      )
      this.lastRealCount = real
      return real
    } catch {
      // countTokens is a network call and can fail on its own. Falling back to
      // the estimate keeps the turn alive; the alternative is failing a user's
      // question because a *measurement* failed.
      return this.lastEstimate
    }
  }

  private async summarize(
    groups: TurnGroup[],
    previousSummary: string | undefined,
    options: FitOptions,
  ): Promise<string> {
    const transcript = groups
      .flatMap((g) => g.messages)
      .map(renderForSummary)
      .filter((line) => line.length > 0)
      .join('\n')

    const instruction = [
      previousSummary
        ? 'Here is a running summary of an earlier part of a conversation, followed by the next part of the transcript. Produce ONE merged summary covering both.'
        : 'Summarise this part of a conversation between a user and their personal finance agent.',
      '',
      'Keep, in compact prose:',
      '- what the user asked about and any figures the agent reported',
      '- decisions made, writes confirmed or declined, and rules or budgets set',
      '- stated preferences and constraints',
      '- anything still open',
      '',
      'Drop pleasantries and tool mechanics. Do not invent anything. Under 250 words.',
      '',
      previousSummary ? `EXISTING SUMMARY:\n${previousSummary}\n` : '',
      `TRANSCRIPT:\n${transcript}`,
    ].join('\n')

    const result = await options.adapter.stream({
      model: options.summarizerModel,
      system: 'You compress conversation history faithfully and briefly.',
      messages: [{ role: 'user', content: [{ type: 'text', text: instruction }] }],
      tools: [],
      maxTokens: 1200,
      ...(options.signal ? { signal: options.signal } : {}),
    })

    const text = result.message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .trim()

    // A failed summariser must not take the turn down with it. Losing detail is
    // survivable; losing the whole conversation is not.
    if (!text) {
      return previousSummary ?? `[${groups.length} earlier turns were evicted; summary unavailable]`
    }
    return text
  }
}

export interface TurnGroup {
  messages: CanonicalMessage[]
}

/**
 * Splits history into turn groups. A group starts at a *real* user message —
 * one whose content is not tool results — and runs to just before the next one.
 */
export function groupTurns(messages: CanonicalMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  let current: CanonicalMessage[] = []

  for (const message of messages) {
    if (isRealUserTurn(message) && current.length > 0) {
      groups.push({ messages: current })
      current = []
    }
    current.push(message)
  }
  if (current.length > 0) groups.push({ messages: current })
  return groups
}

function isRealUserTurn(message: CanonicalMessage): boolean {
  return message.role === 'user' && !message.content.some((b) => b.type === 'tool_result')
}

function isSummaryGroup(group: TurnGroup): boolean {
  const first = group.messages[0]
  if (first?.role !== 'user') return false
  return first.content.some((b) => b.type === 'text' && b.text.startsWith(SUMMARY_MARKER))
}

function extractSummary(group: TurnGroup): string | undefined {
  const first = group.messages[0]
  const block = first?.content.find((b) => b.type === 'text' && b.text.startsWith(SUMMARY_MARKER))
  if (block?.type !== 'text') return undefined
  return block.text.replace(/^<context_summary>\n?/, '').replace(/\n?<\/context_summary>$/, '')
}

/**
 * The summary is prepended as the first *user* turn, with a stub assistant turn
 * after it (spec 8.4). The stub matters: a history that opens user-user confuses
 * models that expect alternation, and the acknowledgement makes the summary read
 * as established context rather than as a question awaiting an answer.
 */
function summaryGroup(summary: string): CanonicalMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: wrapContextSummary(summary) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] },
  ]
}

function renderForSummary(message: CanonicalMessage): string {
  const parts = message.content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text
        case 'tool_use':
          return `[called ${block.name} with ${JSON.stringify(block.input)}]`
        case 'tool_result':
          return `[${block.name} returned: ${block.content.slice(0, 400)}]`
        default:
          return ''
      }
    })
    .filter(Boolean)
  if (parts.length === 0) return ''
  return `${message.role === 'user' ? 'USER' : 'AGENT'}: ${parts.join(' ')}`
}
