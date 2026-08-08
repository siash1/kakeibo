import type { CanonicalMessage, ContentBlock, JsonSchema, ToolDef, ToolUseBlock } from '../types'

/**
 * Canonical format <-> Gemini wire format (spec 8.1).
 *
 * Three things here are not obvious and were established empirically against
 * the live API rather than read off a doc page:
 *
 * 1. **Correlation IDs.** Gemini 2.5 emits `functionCall` parts with no `id` at
 *    all; Gemini 3.x does emit one. kakeibo needs a stable ID either way, so the
 *    adapter takes the provider's when offered and mints `call_<n>_<name>`
 *    otherwise. Pairing on the way back is by ID when we have a real one and by
 *    ordinal position when we do not — `functionResponse.id` turns out to be
 *    optional on the wire, but the *count and order* of response parts is not.
 *
 * 2. **Thought signatures are load-bearing.** Gemini 3.x attaches an opaque
 *    `thoughtSignature` to (usually only the first) functionCall part. Replaying
 *    that turn without it is a hard 400: "Function call is missing a
 *    thought_signature in functionCall parts." So the signature rides along on
 *    the canonical ToolUseBlock in `providerMeta` and is restored on the way
 *    out. The core never looks at it.
 *
 * 3. **Parallel results must not be split.** The API rejects a turn where the
 *    number of functionResponse parts differs from the number of functionCall
 *    parts it is answering. That is the wire-level reason for spec 8.3h.
 */

// The wire types are structurally what @google/genai exposes, restated locally
// so nothing outside this directory has to import provider types.
export interface WirePart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> }
  functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> }
}

export interface WireContent {
  role: 'user' | 'model'
  parts: WirePart[]
}

export function synthesizeToolUseId(index: number, name: string): string {
  return `call_${index}_${name}`
}

/**
 * Canonical messages -> Gemini `contents`.
 *
 * Roles map assistant->model, user->user. tool_result blocks live on a user
 * message in the canonical format and become functionResponse parts, which is
 * also where Gemini expects them.
 */
export function toWireContents(messages: CanonicalMessage[]): WireContent[] {
  const out: WireContent[] = []
  for (const message of messages) {
    const parts = message.content.flatMap(blockToParts)
    if (parts.length === 0) continue
    out.push({ role: message.role === 'assistant' ? 'model' : 'user', parts })
  }
  return out
}

function blockToParts(block: ContentBlock): WirePart[] {
  switch (block.type) {
    case 'text':
      return block.text.length > 0 ? [{ text: block.text }] : []

    case 'tool_use': {
      const part: WirePart = {
        functionCall: {
          name: block.name,
          args: (block.input ?? {}) as Record<string, unknown>,
        },
      }
      // Only echo an ID the provider actually gave us. Sending a synthesised ID
      // that the model never issued makes pairing worse, not better.
      const providerId = block.providerMeta?.providerCallId
      if (typeof providerId === 'string' && providerId.length > 0) {
        part.functionCall!.id = providerId
      }
      const signature = block.providerMeta?.thoughtSignature
      if (typeof signature === 'string' && signature.length > 0) {
        part.thoughtSignature = signature
      }
      return [part]
    }

    case 'tool_result': {
      const part: WirePart = {
        functionResponse: {
          name: block.name,
          // The tool's payload is always wrapped in an object: Gemini requires
          // `response` to be a struct, and a bare string or array is rejected.
          response: block.is_error ? { error: block.content } : { result: block.content },
        },
      }
      const providerId = block.tool_use_id.startsWith('call_') ? undefined : block.tool_use_id
      if (providerId) part.functionResponse!.id = providerId
      return [part]
    }

    case 'thought_summary':
      // Thought summaries are recorded for the trace viewer, never replayed:
      // the signature is what the model needs back, not the prose.
      return []

    default: {
      const _exhaustive: never = block
      return _exhaustive
    }
  }
}

/**
 * Gemini candidate parts -> canonical assistant message.
 *
 * `startIndex` seeds the synthesised correlation IDs so they stay unique across
 * the several model calls that make up one turn.
 */
export function fromWireParts(
  parts: WirePart[],
  startIndex: number,
): { content: ContentBlock[]; toolUses: ToolUseBlock[] } {
  const content: ContentBlock[] = []
  const toolUses: ToolUseBlock[] = []
  let index = startIndex

  for (const part of parts) {
    if (part.functionCall) {
      const name = part.functionCall.name ?? 'unknown_tool'
      const providerCallId = part.functionCall.id
      const providerMeta: Record<string, unknown> = {}
      if (providerCallId) providerMeta.providerCallId = providerCallId
      if (part.thoughtSignature) providerMeta.thoughtSignature = part.thoughtSignature

      const block: ToolUseBlock = {
        type: 'tool_use',
        id: providerCallId ?? synthesizeToolUseId(index, name),
        name,
        input: part.functionCall.args ?? {},
        ...(Object.keys(providerMeta).length > 0 ? { providerMeta } : {}),
      }
      content.push(block)
      toolUses.push(block)
      index++
      continue
    }

    if (typeof part.text === 'string' && part.text.length > 0) {
      if (part.thought) {
        content.push({
          type: 'thought_summary',
          text: part.text,
          ...(part.thoughtSignature
            ? { providerMeta: { thoughtSignature: part.thoughtSignature } }
            : {}),
        })
      } else {
        content.push({ type: 'text', text: part.text })
      }
    }
  }

  return { content, toolUses }
}

/** Gemini's Schema object is OpenAPI-flavoured: types are UPPERCASE. */
export function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (schema.type) out.type = schema.type.toUpperCase()
  if (schema.description) out.description = schema.description
  if (schema.nullable) out.nullable = true
  if (schema.enum) out.enum = schema.enum.map(String)
  if (schema.format) out.format = schema.format
  if (schema.minimum !== undefined) out.minimum = schema.minimum
  if (schema.maximum !== undefined) out.maximum = schema.maximum
  if (schema.minItems !== undefined) out.minItems = schema.minItems
  if (schema.maxItems !== undefined) out.maxItems = schema.maxItems
  if (schema.properties) {
    const props: Record<string, unknown> = {}
    for (const [name, child] of Object.entries(schema.properties)) {
      props[name] = toGeminiSchema(child)
    }
    out.properties = props
  }
  if (schema.required?.length) out.required = schema.required
  if (schema.items) out.items = toGeminiSchema(schema.items)
  if (schema.anyOf) out.anyOf = schema.anyOf.map(toGeminiSchema)
  return out
}

export function toFunctionDeclarations(tools: ToolDef[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.inputSchema),
  }))
}
