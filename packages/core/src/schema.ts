import { z } from 'zod'
import type { JsonSchema } from './types'

/**
 * zod -> JSON Schema -> the narrow subset function declarations may contain.
 *
 * Gemini accepts an OpenAPI-3.0-flavoured Schema object, not full JSON Schema:
 * no `$ref`, no `additionalProperties`, no `allOf`/`oneOf`/`not`, no
 * `patternProperties`. Sending those is at best ignored and at worst a 400, so
 * the conversion is a whitelist, not a passthrough. Anything dropped that a
 * human would still want to know is folded into `description` instead, since
 * the description is the only channel the model actually reads.
 *
 * Note this is *declaration* only. It tells the model what shape to produce; it
 * enforces nothing. Enforcement is the zod re-validation at execution time
 * (spec 8.6.2) — Gemini has no server-side strict-schema guarantee.
 */

/** Keys we forward verbatim when the value is present and supported. */
const PASSTHROUGH = [
  'description',
  'enum',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'default',
] as const

/** Formats Gemini documents support, by type. Everything else is dropped. */
const SUPPORTED_FORMATS: Record<string, Set<string>> = {
  string: new Set(['enum', 'date-time']),
  number: new Set(['float', 'double']),
  integer: new Set(['int32', 'int64']),
}

type RawSchema = Record<string, unknown>

export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    // Inline everything: Gemini cannot follow $ref, so a shared sub-schema has
    // to be duplicated rather than referenced.
    reused: 'inline',
    cycles: 'throw',
    // A tool input that cannot be described (z.custom, z.function) becomes an
    // open `{}` rather than blowing up the whole registry at import time.
    unrepresentable: 'any',
  }) as RawSchema

  const defs = (raw.$defs ?? raw.definitions) as Record<string, RawSchema> | undefined
  return normalize(raw, defs ?? {}, new Set())
}

function normalize(
  node: RawSchema,
  defs: Record<string, RawSchema>,
  seen: Set<RawSchema>,
): JsonSchema {
  if (seen.has(node)) {
    // cycles:'throw' should prevent this; belt and braces so a bad schema
    // degrades to "any object" instead of recursing forever.
    return { type: 'object', description: 'recursive schema (elided)' }
  }

  const resolved = node.$ref ? resolveRef(String(node.$ref), defs) : node
  if (!resolved) return {}

  const nextSeen = new Set(seen).add(node)
  const out: JsonSchema = {}

  const type = pickType(resolved)
  if (type) out.type = type
  if (isNullable(resolved)) out.nullable = true

  for (const key of PASSTHROUGH) {
    const value = resolved[key]
    if (value !== undefined) Object.assign(out, { [key]: value })
  }

  // JSON Schema `const` has no Gemini equivalent; a single-value enum does.
  if (resolved.const !== undefined && out.enum === undefined) {
    out.enum = [resolved.const as string | number]
  }

  const format = resolved.format
  if (typeof format === 'string' && type) {
    if (SUPPORTED_FORMATS[type]?.has(format)) {
      out.format = format
    } else {
      // e.g. "uuid", "email", "date". The constraint still matters to the model,
      // so it survives as prose rather than being silently lost.
      out.description = appendHint(out.description, `format: ${format}`)
    }
  }

  if (resolved.pattern) {
    out.description = appendHint(out.description, `must match /${String(resolved.pattern)}/`)
  }

  const props = resolved.properties as Record<string, RawSchema> | undefined
  if (props) {
    out.properties = {}
    for (const [name, child] of Object.entries(props)) {
      out.properties[name] = normalize(child, defs, nextSeen)
    }
  }

  if (Array.isArray(resolved.required) && resolved.required.length > 0) {
    out.required = resolved.required as string[]
  }

  if (resolved.items) {
    out.items = normalize(resolved.items as RawSchema, defs, nextSeen)
  }

  // Unions. anyOf is the one composition keyword Gemini supports; oneOf/allOf
  // are not, so they are approximated by anyOf (a union the model may satisfy
  // loosely — zod re-validation catches the difference at execution).
  const union = (resolved.anyOf ?? resolved.oneOf) as RawSchema[] | undefined
  if (union) {
    const branches = union.filter((b) => b.type !== 'null').map((b) => normalize(b, defs, nextSeen))
    if (union.some((b) => b.type === 'null')) out.nullable = true
    if (branches.length === 1) {
      Object.assign(out, branches[0], out.description ? { description: out.description } : {})
    } else if (branches.length > 1) {
      out.anyOf = branches
    }
  }

  if (Array.isArray(resolved.allOf)) {
    // Flatten an intersection by merging members left to right. Imperfect, but
    // strictly better than emitting a keyword Gemini will reject.
    for (const member of resolved.allOf as RawSchema[]) {
      const flat = normalize(member, defs, nextSeen)
      out.type ??= flat.type
      if (flat.properties) out.properties = { ...out.properties, ...flat.properties }
      if (flat.required) out.required = [...(out.required ?? []), ...flat.required]
    }
  }

  return out
}

function resolveRef(ref: string, defs: Record<string, RawSchema>): RawSchema | undefined {
  const name = ref.replace(/^#\/(\$defs|definitions)\//, '')
  return defs[name]
}

function pickType(node: RawSchema): JsonSchema['type'] | undefined {
  const t = node.type
  if (typeof t === 'string') return t === 'null' ? 'null' : (t as JsonSchema['type'])
  if (Array.isArray(t)) {
    const first = t.find((x) => x !== 'null')
    return first as JsonSchema['type'] | undefined
  }
  // No declared type but it has properties -> it is an object.
  if (node.properties) return 'object'
  return undefined
}

function isNullable(node: RawSchema): boolean {
  return Array.isArray(node.type) && node.type.includes('null')
}

function appendHint(description: string | undefined, hint: string): string {
  return description ? `${description} (${hint})` : hint
}

/**
 * Function declarations must serialise byte-identically on every request or the
 * cached prefix is invalidated (spec 5.5). Object key order in JS is insertion
 * order, and the converter above builds keys in a fixed order, but a tool author
 * writing a literal schema could still perturb it — so sort on the way out.
 */
export function stableSchema(schema: JsonSchema): JsonSchema {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(schema).sort()) {
    const value = (schema as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, JsonSchema> = {}
      for (const name of Object.keys(value as object).sort()) {
        props[name] = stableSchema((value as Record<string, JsonSchema>)[name]!)
      }
      out[key] = props
    } else if (key === 'items') {
      out[key] = stableSchema(value as JsonSchema)
    } else if (key === 'anyOf') {
      out[key] = (value as JsonSchema[]).map(stableSchema)
    } else {
      out[key] = value
    }
  }
  return out as JsonSchema
}
