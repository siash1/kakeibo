import { GoogleGenAI } from '@google/genai'
import { env } from '../env'
import { hashRequest } from '../hash'
import {
  type CanonicalMessage,
  type CanonicalResult,
  KakeiboError,
  type ProviderAdapter,
  type StopReason,
  type StreamRequest,
  type ToolDef,
  type Usage,
} from '../types'
import {
  fromWireParts,
  toFunctionDeclarations,
  toWireContents,
  type WireContent,
  type WirePart,
} from './wire'

/**
 * The Gemini adapter. Uses @google/genai purely as a typed HTTP client:
 * `generateContentStream`, `countTokens`, `caches` — no chat sessions, no
 * automatic function calling, no tool runner (spec hard rule 2.1). The
 * `automaticFunctionCalling.disable` flag below is the belt to that braces:
 * even though we never register callable functions with the SDK, we tell it
 * explicitly not to run a loop of its own.
 */

/** Vertex finish reasons -> kakeibo's five stop reasons (spec 8.2). */
const BLOCKED_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'LANGUAGE',
])

export interface GeminiAdapterOptions {
  /** Explicit cache TTL. 30 minutes matches a realistic chat session (spec 5.5). */
  cacheTtlSeconds?: number
  /** Test seam so unit tests can drive the adapter without a network client. */
  client?: GeminiClient
}

/** The slice of GoogleGenAI this adapter actually uses. */
export interface GeminiClient {
  models: {
    // biome-ignore lint/suspicious/noExplicitAny: provider wire boundary (spec 2.2)
    generateContentStream(params: any): Promise<AsyncGenerator<any>>
    // biome-ignore lint/suspicious/noExplicitAny: provider wire boundary (spec 2.2)
    countTokens(params: any): Promise<any>
  }
  caches: {
    // biome-ignore lint/suspicious/noExplicitAny: provider wire boundary (spec 2.2)
    create(params: any): Promise<any>
  }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly name = 'gemini'
  private readonly client: GeminiClient
  private readonly cacheTtlSeconds: number
  /** cache key (model + system + tools) -> { name, createdAt, tokens } */
  private readonly caches = new Map<string, CacheEntry>()

  constructor(options: GeminiAdapterOptions = {}) {
    this.client = options.client ?? createClient()
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? 1800
  }

  async stream(req: StreamRequest): Promise<CanonicalResult> {
    const started = Date.now()
    const config = this.buildConfig(req)
    const contents = toWireContents(req.messages)

    let stream: AsyncGenerator<unknown>
    try {
      stream = await this.client.models.generateContentStream({
        model: req.model,
        contents,
        config,
      })
    } catch (error) {
      return errorResult(started, error)
    }

    const assembler = new PartAssembler()
    let finishReason: string | undefined
    let blockReason: string | undefined
    let usage: Usage = emptyUsage()
    let modelVersion: string | undefined

    try {
      for await (const rawChunk of stream) {
        // biome-ignore lint/suspicious/noExplicitAny: provider wire boundary (spec 2.2)
        const chunk = rawChunk as any
        if (req.signal?.aborted) break

        modelVersion ??= chunk.modelVersion
        if (chunk.usageMetadata) usage = readUsage(chunk.usageMetadata)
        if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason

        const candidate = chunk.candidates?.[0]
        if (!candidate) continue
        if (candidate.finishReason) finishReason = candidate.finishReason

        for (const part of (candidate.content?.parts ?? []) as WirePart[]) {
          const delta = assembler.push(part)
          if (delta?.kind === 'text') req.onText?.(delta.text)
          if (delta?.kind === 'thought') req.onThought?.(delta.text)
        }
      }
    } catch (error) {
      if (req.signal?.aborted) {
        return abortedResult(started, assembler, usage, modelVersion)
      }
      return errorResult(started, error)
    }

    if (req.signal?.aborted) return abortedResult(started, assembler, usage, modelVersion)

    const { content, toolUses } = fromWireParts(assembler.parts(), 0)
    const stopReason = normalizeStopReason(finishReason, blockReason, toolUses.length > 0)

    return {
      message: { role: 'assistant', content },
      stopReason,
      usage,
      latencyMs: Date.now() - started,
      modelVersion,
      ...(stopReason === 'blocked'
        ? { errorMessage: `Response blocked by the provider (${blockReason ?? finishReason}).` }
        : {}),
    }
  }

  async countTokens(
    model: string,
    system: string,
    messages: CanonicalMessage[],
    tools: ToolDef[],
  ): Promise<number> {
    const contents = toWireContents(messages)
    // countTokens rejects an empty contents array; a turn is never really empty
    // in the loop, but the context manager probes with one during eviction.
    const safeContents: WireContent[] =
      contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: '' }] }]
    try {
      const response = await this.client.models.countTokens({
        model,
        contents: safeContents,
        config: {
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          tools:
            tools.length > 0
              ? [{ functionDeclarations: toFunctionDeclarations(tools) }]
              : undefined,
        },
      })
      return Number(response?.totalTokens ?? 0)
    } catch (error) {
      throw new KakeiboError(
        `countTokens failed: ${describeError(error)}`,
        'count_tokens_failed',
        error,
      )
    }
  }

  /**
   * Creates (or reuses) an explicit context cache holding the stable prefix:
   * system instruction + tool declarations. Both are byte-stable across a
   * session by construction, which is the whole precondition for caching.
   *
   * Returns null rather than throwing when the prefix is below the model's
   * minimum cacheable size or the model does not support explicit caching — the
   * loop then runs on implicit caching alone, which is a degradation in cost,
   * not in correctness.
   */
  async ensureCache(model: string, system: string, tools: ToolDef[]): Promise<string | null> {
    if (!env().EXPLICIT_CACHE) return null

    const key = hashRequest({ model, system, tools })
    const existing = this.caches.get(key)
    // Refresh a little before expiry so a long turn cannot straddle the edge.
    if (existing && Date.now() - existing.createdAt < (this.cacheTtlSeconds - 120) * 1000) {
      return existing.name
    }

    try {
      const cached = await this.client.caches.create({
        model,
        config: {
          systemInstruction: { parts: [{ text: system }] },
          tools:
            tools.length > 0
              ? [{ functionDeclarations: toFunctionDeclarations(tools) }]
              : undefined,
          ttl: `${this.cacheTtlSeconds}s`,
          displayName: `kakeibo-${key.slice(0, 12)}`,
        },
      })
      const name = cached?.name
      if (typeof name !== 'string') return null
      const entry: CacheEntry = {
        name,
        createdAt: Date.now(),
        tokens: Number(cached?.usageMetadata?.totalTokenCount ?? 0),
      }
      this.caches.set(key, entry)
      return name
    } catch (error) {
      // Most common cause by far: "Cached content is too small". Surfacing it as
      // a warning rather than an error keeps the hunt visible without breaking
      // the run (spec 5.5 says to pad the prefix if this happens).
      lastCacheError = describeError(error)
      return null
    }
  }

  /** Token-hours of explicit cache storage held so far, for cost estimation. */
  cacheStorageTokenHours(): number {
    let total = 0
    for (const entry of this.caches.values()) {
      total += (entry.tokens * (Date.now() - entry.createdAt)) / 3_600_000
    }
    return total
  }

  private buildConfig(req: StreamRequest): Record<string, unknown> {
    const { THINKING_LEVEL, TRACE_THINKING } = env()
    const config: Record<string, unknown> = {
      maxOutputTokens: req.maxTokens,
      // Never let the SDK run its own tool loop — kakeibo's loop is the product.
      automaticFunctionCalling: { disable: true, maximumRemoteCalls: 0 },
    }

    if (req.cacheRef) {
      // With an explicit cache the system instruction and tools live *inside*
      // the cached content; re-sending them alongside is rejected as duplicate.
      config.cachedContent = req.cacheRef
    } else {
      if (req.system) config.systemInstruction = { parts: [{ text: req.system }] }
      if (req.tools.length > 0) {
        config.tools = [{ functionDeclarations: toFunctionDeclarations(req.tools) }]
      }
    }

    if (req.toolChoice && req.tools.length > 0) {
      config.toolConfig = {
        functionCallingConfig: {
          mode: req.toolChoice.mode.toUpperCase(),
          ...(req.toolChoice.allowedNames
            ? { allowedFunctionNames: req.toolChoice.allowedNames }
            : {}),
        },
      }
    }

    const thinkingConfig: Record<string, unknown> = {}
    if (TRACE_THINKING) thinkingConfig.includeThoughts = true
    if (THINKING_LEVEL) thinkingConfig.thinkingLevel = THINKING_LEVEL.toUpperCase()
    if (Object.keys(thinkingConfig).length > 0) config.thinkingConfig = thinkingConfig

    if (req.signal) config.abortSignal = req.signal
    return config
  }
}

interface CacheEntry {
  name: string
  createdAt: number
  tokens: number
}

/** Last explicit-cache failure message, surfaced by the cache report script. */
let lastCacheError: string | undefined
export function lastExplicitCacheError(): string | undefined {
  return lastCacheError
}

/**
 * Reassembles streamed parts into whole ones.
 *
 * Streaming splits text across chunks but delivers functionCall parts intact.
 * A thoughtSignature may arrive on a part carrying nothing else, in which case
 * it belongs to the functionCall that follows — hence `pendingSignature`.
 */
class PartAssembler {
  private readonly out: WirePart[] = []
  private pendingSignature: string | undefined

  push(part: WirePart): { kind: 'text' | 'thought'; text: string } | undefined {
    if (part.functionCall) {
      const signature = part.thoughtSignature ?? this.pendingSignature
      this.pendingSignature = undefined
      this.out.push({
        functionCall: part.functionCall,
        ...(signature ? { thoughtSignature: signature } : {}),
      })
      return undefined
    }

    if (typeof part.text === 'string' && part.text.length > 0) {
      const kind = part.thought ? 'thought' : 'text'
      const last = this.out[this.out.length - 1]
      const lastKind =
        last && last.text !== undefined ? (last.thought ? 'thought' : 'text') : undefined
      if (last && lastKind === kind) {
        last.text = (last.text ?? '') + part.text
        if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature
      } else {
        this.out.push({
          text: part.text,
          ...(part.thought ? { thought: true } : {}),
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        })
      }
      return { kind, text: part.text }
    }

    if (part.thoughtSignature) this.pendingSignature = part.thoughtSignature
    return undefined
  }

  parts(): WirePart[] {
    return this.out
  }
}

function normalizeStopReason(
  finishReason: string | undefined,
  blockReason: string | undefined,
  hasToolUse: boolean,
): StopReason {
  if (blockReason) return 'blocked'
  if (finishReason && BLOCKED_REASONS.has(finishReason)) return 'blocked'
  if (finishReason === 'MAX_TOKENS') return 'max_tokens'
  if (finishReason === 'MALFORMED_FUNCTION_CALL') return 'error'
  if (hasToolUse) return 'tool_use'
  if (finishReason === 'STOP' || finishReason === undefined) return 'end'
  return 'error'
}

// biome-ignore lint/suspicious/noExplicitAny: provider wire boundary (spec 2.2)
function readUsage(meta: any): Usage {
  return {
    inputTokens: Number(meta.promptTokenCount ?? 0),
    outputTokens: Number(meta.candidatesTokenCount ?? 0) + Number(meta.thoughtsTokenCount ?? 0),
    cachedTokens: Number(meta.cachedContentTokenCount ?? 0),
    thoughtTokens: Number(meta.thoughtsTokenCount ?? 0),
  }
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, thoughtTokens: 0 }
}

function errorResult(started: number, error: unknown): CanonicalResult {
  return {
    message: { role: 'assistant', content: [] },
    stopReason: 'error',
    usage: emptyUsage(),
    latencyMs: Date.now() - started,
    errorMessage: describeError(error),
  }
}

function abortedResult(
  started: number,
  assembler: PartAssembler,
  usage: Usage,
  modelVersion: string | undefined,
): CanonicalResult {
  const { content } = fromWireParts(assembler.parts(), 0)
  return {
    message: { role: 'assistant', content },
    stopReason: 'error',
    usage,
    latencyMs: Date.now() - started,
    modelVersion,
    errorMessage: 'aborted',
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function createClient(): GeminiClient {
  const { GEMINI_AUTH, GCP_PROJECT_ID, GCP_REGION, GEMINI_API_KEY } = env()

  if (GEMINI_AUTH === 'apikey') {
    if (!GEMINI_API_KEY) {
      throw new KakeiboError('GEMINI_AUTH=apikey but GEMINI_API_KEY is empty.', 'missing_api_key')
    }
    return new GoogleGenAI({ apiKey: GEMINI_API_KEY }) as unknown as GeminiClient
  }

  if (!GCP_PROJECT_ID) {
    throw new KakeiboError(
      'GEMINI_AUTH=vertex but GCP_PROJECT_ID is empty. Run `pnpm check:providers`.',
      'missing_project',
    )
  }
  // The SDK warns on every construction when it sees an API key in the
  // environment alongside an explicit Vertex project. Both are legitimately set
  // here — the key is the documented fallback path (spec 5.1) — so the warning
  // is noise. Hide the key for the length of the constructor call only.
  const savedKey = process.env.GEMINI_API_KEY
  const savedGoogleKey = process.env.GOOGLE_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
  try {
    return new GoogleGenAI({
      vertexai: true,
      project: GCP_PROJECT_ID,
      location: GCP_REGION,
    }) as unknown as GeminiClient
  } finally {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = savedKey
    if (savedGoogleKey === undefined) delete process.env.GOOGLE_API_KEY
    else process.env.GOOGLE_API_KEY = savedGoogleKey
  }
}
