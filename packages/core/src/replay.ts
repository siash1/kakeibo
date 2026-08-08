import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from './env'
import { hashRequest, stableStringify } from './hash'
import {
  type CanonicalMessage,
  type CanonicalResult,
  type ContentBlock,
  KakeiboError,
  type ProviderAdapter,
  type StreamRequest,
  type ToolDef,
} from './types'

/**
 * Record/replay wrapper (spec 8.2).
 *
 * RECORD=1 saves every (request -> response) pair to fixtures/. REPLAY=1 serves
 * them back with no network and no key, which is what lets CI run the whole
 * agent loop for free on every push.
 *
 * The subtlety is the fixture key. A naive hash of the request is *not* stable:
 * Gemini 3.x stamps every functionCall with a random ID and an opaque
 * thoughtSignature, both of which land in the assistant message and therefore in
 * the next request. Hash those and every recording produces a fresh key that
 * never matches again. So the key is computed over a canonicalised request with
 * provider-assigned identity stripped and tool_use IDs renumbered positionally.
 */

export interface ReplayOptions {
  fixtureDir?: string
  mode?: 'record' | 'replay' | 'passthrough'
}

interface Fixture {
  /** Human-readable context so a fixture diff is reviewable. */
  request: {
    model: string
    system: string
    messages: CanonicalMessage[]
    tools: string[]
  }
  result: CanonicalResult
  recordedAt: string
}

export class ReplayAdapter implements ProviderAdapter {
  readonly name: string
  private readonly inner: ProviderAdapter
  private readonly dir: string
  private readonly mode: 'record' | 'replay' | 'passthrough'
  private readonly tokenCounts = new Map<string, number>()

  constructor(inner: ProviderAdapter, options: ReplayOptions = {}) {
    this.inner = inner
    this.name = inner.name
    this.dir = options.fixtureDir ?? defaultFixtureDir()
    this.mode = options.mode ?? resolveMode()
  }

  async stream(req: StreamRequest): Promise<CanonicalResult> {
    if (this.mode === 'passthrough') return this.inner.stream(req)

    const key = fixtureKey(req)
    const path = join(this.dir, `${key}.json`)

    if (this.mode === 'replay') {
      if (!existsSync(path)) {
        throw new KakeiboError(
          `No fixture for this request (${key}).\n` +
            `Model: ${req.model}, ${req.messages.length} message(s), ${req.tools.length} tool(s).\n` +
            'Re-record with: RECORD=1 pnpm eval:smoke',
          'fixture_missing',
        )
      }
      const fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture
      replayStreamCallbacks(fixture.result.message.content, req)
      return { ...fixture.result, replayed: true }
    }

    const result = await this.inner.stream(req)
    mkdirSync(this.dir, { recursive: true })
    const fixture: Fixture = {
      request: {
        model: req.model,
        system: req.system,
        messages: req.messages,
        tools: req.tools.map((t) => t.name),
      },
      result,
      recordedAt: new Date().toISOString(),
    }
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`)
    return result
  }

  async countTokens(
    model: string,
    system: string,
    messages: CanonicalMessage[],
    tools: ToolDef[],
  ): Promise<number> {
    if (this.mode === 'passthrough') return this.inner.countTokens(model, system, messages, tools)

    const key = hashRequest({
      kind: 'countTokens',
      model,
      system,
      messages: canonicalizeMessages(messages),
      tools: tools.map((t) => t.name),
    })
    const path = join(this.dir, `tokens-${key}.json`)

    if (this.mode === 'replay') {
      if (this.tokenCounts.has(key)) return this.tokenCounts.get(key)!
      if (existsSync(path))
        return (JSON.parse(readFileSync(path, 'utf8')) as { totalTokens: number }).totalTokens
      // Token counting is advisory, not semantic: a missing fixture falls back
      // to the same chars/4 estimate the context manager uses between counts,
      // rather than failing a replay run over an unrecorded probe.
      return estimateTokens(system, messages, tools)
    }

    const total = await this.inner.countTokens(model, system, messages, tools)
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify({ totalTokens: total }, null, 2)}\n`)
    this.tokenCounts.set(key, total)
    return total
  }

  async ensureCache(model: string, system: string, tools: ToolDef[]): Promise<string | null> {
    // Explicit caching is a live-API optimisation; replayed runs have no cache
    // to point at, and recording one would bake a resource name that expires.
    if (this.mode === 'replay') return null
    return this.inner.ensureCache ? this.inner.ensureCache(model, system, tools) : null
  }
}

function resolveMode(): 'record' | 'replay' | 'passthrough' {
  const { RECORD, REPLAY } = env()
  if (RECORD) return 'record'
  if (REPLAY) return 'replay'
  return 'passthrough'
}

function defaultFixtureDir(): string {
  return join(process.cwd().replace(/\/(packages|apps)\/[^/]+$/, ''), 'fixtures')
}

export function fixtureKey(req: StreamRequest): string {
  return hashRequest({
    model: req.model,
    system: req.system,
    messages: canonicalizeMessages(req.messages),
    tools: req.tools.map((t) => ({ name: t.name, schema: t.inputSchema })),
    toolChoice: req.toolChoice ?? null,
  })
}

/**
 * Strips provider-assigned identity so the same logical conversation hashes the
 * same way on every run: no random call IDs, no thought signatures, tool_use and
 * tool_result correlated by ordinal instead.
 */
export function canonicalizeMessages(messages: CanonicalMessage[]): unknown {
  let counter = 0
  const idMap = new Map<string, string>()

  return messages.map((message) => ({
    role: message.role,
    content: message.content.flatMap((block): unknown[] => {
      switch (block.type) {
        case 'text':
          return [{ type: 'text', text: block.text }]
        case 'tool_use': {
          const stable = `t${counter++}`
          idMap.set(block.id, stable)
          return [{ type: 'tool_use', id: stable, name: block.name, input: block.input }]
        }
        case 'tool_result':
          return [
            {
              type: 'tool_result',
              id: idMap.get(block.tool_use_id) ?? block.tool_use_id,
              name: block.name,
              content: block.content,
              is_error: block.is_error ?? false,
            },
          ]
        case 'thought_summary':
          // Thought prose is non-deterministic and never replayed back to the
          // model, so it must not participate in the key.
          return []
        default:
          return []
      }
    }),
  }))
}

/** Replays recorded text through the streaming callbacks so UIs behave identically. */
function replayStreamCallbacks(content: ContentBlock[], req: StreamRequest): void {
  for (const block of content) {
    if (block.type === 'text') req.onText?.(block.text)
    if (block.type === 'thought_summary') req.onThought?.(block.text)
  }
}

/** chars/4 — the same cheap estimate the context manager uses between real counts. */
export function estimateTokens(
  system: string,
  messages: CanonicalMessage[],
  tools: ToolDef[],
): number {
  const chars =
    system.length +
    stableStringify(messages).length +
    stableStringify(tools.map((t) => t.inputSchema)).length
  return Math.ceil(chars / 4)
}
