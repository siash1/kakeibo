/**
 * kakeibo's canonical, provider-neutral message format (spec 8.1).
 *
 * Nothing in the loop, the context manager, the tracer or the tools knows what
 * Gemini's wire format looks like. Adapters translate at the edge. That is what
 * makes a future Claude/OpenAI adapter a drop-in rather than a rewrite.
 */

export type Role = 'user' | 'assistant'

/** Text the model produced, or the user typed. */
export interface TextBlock {
  type: 'text'
  text: string
}

/**
 * A tool the model wants to run.
 *
 * `id` is kakeibo's own correlation ID. Gemini 2.5 emits no ID on functionCall
 * parts at all; Gemini 3.x does emit one. The adapter uses the provider's ID
 * when present and synthesises a stable one otherwise, so the rest of the system
 * can always pair a call with its result by ID (spec 8.1).
 *
 * `providerMeta` carries opaque provider state that MUST survive the round trip.
 * For Gemini 3.x that is `thoughtSignature`: replaying a functionCall part
 * without its signature is a hard HTTP 400 ("Function call is missing a
 * thought_signature in functionCall parts"). It is deliberately opaque — the
 * core never reads it, only the adapter that produced it does.
 */
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  providerMeta?: Record<string, unknown>
}

/** The result of running a tool, fed back to the model as data. */
export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  /** Tool name, kept alongside the ID because Gemini pairs responses by name. */
  name: string
  content: string
  is_error?: boolean
}

/** A model's summarised reasoning, recorded only when TRACE_THINKING=1. */
export interface ThoughtSummaryBlock {
  type: 'thought_summary'
  text: string
  providerMeta?: Record<string, unknown>
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThoughtSummaryBlock

export interface CanonicalMessage {
  role: Role
  content: ContentBlock[]
}

/**
 * Normalised stop reasons (spec 8.2). Provider-specific finish reasons collapse
 * into these five so the loop's control flow never grows a provider branch.
 */
export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'blocked' | 'error'

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** Tokens served from cache (implicit or explicit) — the caching headline. */
  cachedTokens: number
  /** Reasoning tokens, billed as output but not present in the response text. */
  thoughtTokens: number
}

export interface CanonicalResult {
  message: CanonicalMessage
  stopReason: StopReason
  usage: Usage
  latencyMs: number
  /** Model ID the provider actually served, which may differ from the alias asked for. */
  modelVersion?: string
  /** Populated when stopReason is 'blocked' or 'error'. */
  errorMessage?: string
  /** True when this result came from a recorded fixture rather than the network. */
  replayed?: boolean
}

/**
 * A tool as the *model* sees it: name, description, and a JSON Schema for its
 * input. Execution lives elsewhere (see registry.ts) — this is only the
 * declaration that gets serialised into the request.
 */
export interface ToolDef {
  name: string
  description: string
  /** JSON Schema (draft-2020-12 subset). Adapters map it to their own dialect. */
  inputSchema: JsonSchema
}

export interface StreamRequest {
  model: string
  system: string
  messages: CanonicalMessage[]
  tools: ToolDef[]
  maxTokens: number
  /** Explicit CachedContent resource name, if one is active (spec 5.5). */
  cacheRef?: string
  /** Streaming text callback — deltas only, never the accumulated string. */
  onText?: (delta: string) => void
  /** Streaming thought-summary callback, when thought capture is enabled. */
  onThought?: (delta: string) => void
  signal?: AbortSignal
  /** Forces tool use for eval scenarios (spec 5.3). */
  toolChoice?: { mode: 'auto' | 'any' | 'none'; allowedNames?: string[] }
}

export interface ProviderAdapter {
  readonly name: string
  stream(req: StreamRequest): Promise<CanonicalResult>
  countTokens(
    model: string,
    system: string,
    messages: CanonicalMessage[],
    tools: ToolDef[],
  ): Promise<number>
  /** Creates/reuses an explicit context cache; returns its resource name (spec 5.5). */
  ensureCache?(model: string, system: string, tools: ToolDef[]): Promise<string | null>
}

/**
 * The JSON Schema subset kakeibo emits and Gemini understands. Narrow on
 * purpose: anything not expressible here is not expressible in a tool schema,
 * and finding that out at compile time beats finding out at request time.
 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: (string | number)[]
  format?: string
  nullable?: boolean
  anyOf?: JsonSchema[]
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  default?: unknown
}

export class KakeiboError extends Error {
  constructor(
    message: string,
    readonly code: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'KakeiboError'
  }
}
