import type { z } from 'zod'
import { stableSchema, zodToJsonSchema } from './schema'
import type { ToolDef } from './types'

/**
 * One tool registry, three surfaces (spec 12): the agent loop, the MCP server
 * and the eval harness all import *this* object. A tool added here appears in
 * all three with no further wiring, and none of them can drift from the others
 * because there is nothing to keep in sync.
 */

export type ToolTier = 'read' | 'write'
export type Channel = 'cli' | 'web' | 'mcp' | 'eval'

export interface ConfirmRequest {
  id: string
  tool: string
  tier: ToolTier
  args: unknown
  /** One-line, human-readable description of what will change. */
  summary: string
}

/** Resolved by whichever surface is driving: y/n prompt, SSE card, or script. */
export type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>

export interface ToolContext {
  channel: Channel
  signal?: AbortSignal
  /** Only called for write-tier tools; read-tier never pauses. */
  confirm: ConfirmFn
}

export interface ToolSpec<TInput = unknown> {
  name: string
  description: string
  tier: ToolTier
  input: z.ZodType<TInput>
  /**
   * A one-liner shown in the confirmation prompt. Write tools must describe the
   * change in the user's terms — "set Groceries budget for 2025-03 to ₹12,000"
   * beats dumping the JSON args at them.
   */
  summarize?: (input: TInput) => string
  handler: (input: TInput, ctx: ToolContext) => Promise<unknown>
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec<unknown>>()
  /** Memoised declarations: identical bytes on every request keep caches warm. */
  private declarationCache: ToolDef[] | undefined

  register<T>(spec: ToolSpec<T>): this {
    if (this.tools.has(spec.name)) {
      throw new Error(`Tool "${spec.name}" is already registered`)
    }
    this.tools.set(spec.name, spec as unknown as ToolSpec<unknown>)
    this.declarationCache = undefined
    return this
  }

  registerAll(specs: ToolSpec<unknown>[]): this {
    for (const spec of specs) this.register(spec)
    return this
  }

  get(name: string): ToolSpec<unknown> | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): ToolSpec<unknown>[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  names(): string[] {
    return this.list().map((t) => t.name)
  }

  /**
   * Tool declarations for the provider, sorted by name and with schema keys
   * sorted too. Deterministic serialisation is a caching precondition (spec
   * 5.5): a Map iteration order that shifts between processes would silently
   * invalidate the cached prefix on every restart.
   */
  declarations(): ToolDef[] {
    if (!this.declarationCache) {
      this.declarationCache = this.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: stableSchema(zodToJsonSchema(tool.input as z.ZodType)),
      }))
    }
    return this.declarationCache
  }

  /** A registry limited to some tools — how the MCP server gates writes (spec 12). */
  subset(predicate: (spec: ToolSpec<unknown>) => boolean): ToolRegistry {
    const next = new ToolRegistry()
    for (const spec of this.list()) {
      if (predicate(spec)) next.register(spec)
    }
    return next
  }

  readOnly(): ToolRegistry {
    return this.subset((spec) => spec.tier === 'read')
  }
}

export function summarizeCall(spec: ToolSpec<unknown>, input: unknown): string {
  if (spec.summarize) {
    try {
      return spec.summarize(input)
    } catch {
      // A broken summariser must never block a tool call.
    }
  }
  return `${spec.name}(${truncate(JSON.stringify(input ?? {}), 160)})`
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
