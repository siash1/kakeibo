import type {
  CanonicalMessage,
  CanonicalResult,
  ContentBlock,
  ProviderAdapter,
  StopReason,
  StreamRequest,
  ToolDef,
  Usage,
} from './types'

/**
 * Test doubles.
 *
 * A scripted adapter is the only way to test the loop's error paths honestly.
 * The live model is *good* at avoiding invalid tool calls — it reads the enum in
 * the declaration and refuses before calling — which means a real conversation
 * cannot reliably exercise "the model sent nonsense and the loop fed the
 * validation failure back". Scripting the provider makes that path
 * deterministic, and CI runs it for free.
 */

export interface ScriptedTurn {
  /** Blocks the "model" emits for this call. */
  content: ContentBlock[]
  stopReason?: StopReason
  usage?: Partial<Usage>
  errorMessage?: string
}

export class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'scripted'
  /** Every request the loop made, in order — assert against this. */
  readonly requests: StreamRequest[] = []
  private index = 0

  constructor(
    private readonly script: ScriptedTurn[],
    private readonly options: { tokensPerCall?: number; cachedTokens?: number } = {},
  ) {}

  async stream(req: StreamRequest): Promise<CanonicalResult> {
    this.requests.push(structuredClone(stripCallbacks(req)))
    const turn = this.script[this.index++]

    if (!turn) {
      // Running off the end of the script means the loop iterated more than the
      // test expected. Failing loudly beats hanging or looping.
      throw new Error(
        `ScriptedAdapter exhausted after ${this.index - 1} call(s); the loop asked for another.`,
      )
    }

    for (const block of turn.content) {
      if (block.type === 'text') req.onText?.(block.text)
      if (block.type === 'thought_summary') req.onThought?.(block.text)
    }

    const hasToolUse = turn.content.some((b) => b.type === 'tool_use')
    return {
      message: { role: 'assistant', content: turn.content },
      stopReason: turn.stopReason ?? (hasToolUse ? 'tool_use' : 'end'),
      usage: {
        inputTokens: this.options.tokensPerCall ?? 100,
        outputTokens: 20,
        cachedTokens: this.options.cachedTokens ?? 0,
        thoughtTokens: 0,
        ...turn.usage,
      },
      latencyMs: 1,
      modelVersion: 'scripted-1.0',
      ...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
    }
  }

  async countTokens(
    _model: string,
    system: string,
    messages: CanonicalMessage[],
    _tools: ToolDef[],
  ): Promise<number> {
    // Deterministic and roughly proportional to real length, so budget tests can
    // reason about it without a network call.
    return Math.ceil((system.length + JSON.stringify(messages).length) / 4)
  }

  async ensureCache(): Promise<string | null> {
    return null
  }

  get callCount(): number {
    return this.index
  }
}

function stripCallbacks(
  req: StreamRequest,
): Omit<StreamRequest, 'onText' | 'onThought' | 'signal'> {
  const { onText: _onText, onThought: _onThought, signal: _signal, ...rest } = req
  return rest
}

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

export function toolUseBlock(id: string, name: string, input: unknown): ContentBlock {
  return { type: 'tool_use', id, name, input }
}

/** Pulls the tool_result blocks out of the message the loop sent back. */
export function toolResultsOf(message: CanonicalMessage | undefined) {
  return (message?.content ?? []).filter((b) => b.type === 'tool_result')
}
