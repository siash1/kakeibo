import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toGeminiSchema } from './gemini/wire'
import { stableSchema, zodToJsonSchema } from './schema'

/** zod -> JSON Schema -> Gemini's OpenAPI-flavoured subset (spec 4, 8.6.2). */

describe('zodToJsonSchema', () => {
  it('converts a plain object with required and optional fields', () => {
    const schema = zodToJsonSchema(
      z.object({
        query: z.string().describe('search text'),
        limit: z.number().int().optional(),
      }),
    )

    expect(schema.type).toBe('object')
    expect(schema.properties?.query).toMatchObject({ type: 'string', description: 'search text' })
    expect(schema.properties?.limit).toMatchObject({ type: 'integer' })
    expect(schema.required).toEqual(['query'])
  })

  it('preserves enums, which are how the model learns the valid categories', () => {
    const schema = zodToJsonSchema(z.object({ category: z.enum(['Groceries', 'Dining']) }))
    expect(schema.properties?.category?.enum).toEqual(['Groceries', 'Dining'])
  })

  it('keeps a default in the declaration', () => {
    const schema = zodToJsonSchema(z.object({ limit: z.number().default(20) }))
    expect(schema.properties?.limit?.default).toBe(20)
  })

  it('demotes an unsupported string format into the description', () => {
    // Gemini accepts only "enum" and "date-time" as string formats. A uuid
    // format sent verbatim is at best ignored, so the constraint survives as
    // prose where the model will actually read it.
    const schema = zodToJsonSchema(z.object({ id: z.string().uuid() }))
    expect(schema.properties?.id?.format).toBeUndefined()
    expect(schema.properties?.id?.description).toContain('uuid')
  })

  it('carries a regex constraint into the description', () => {
    const schema = zodToJsonSchema(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }))
    expect(schema.properties?.month?.description).toContain('must match')
  })

  it('flattens a union into anyOf', () => {
    const schema = zodToJsonSchema(
      z.object({ period: z.union([z.string(), z.object({ from: z.string(), to: z.string() })]) }),
    )
    const period = schema.properties?.period
    expect(period?.anyOf).toHaveLength(2)
    expect(period?.anyOf?.[1]?.properties?.from).toMatchObject({ type: 'string' })
  })

  it('inlines a reused sub-schema instead of emitting $ref', () => {
    const inner = z.object({ value: z.string() })
    const schema = zodToJsonSchema(z.object({ a: inner, b: inner }))
    const json = JSON.stringify(schema)

    expect(json).not.toContain('$ref')
    expect(json).not.toContain('$defs')
    expect(schema.properties?.a?.properties?.value).toMatchObject({ type: 'string' })
    expect(schema.properties?.b?.properties?.value).toMatchObject({ type: 'string' })
  })

  it('handles arrays with typed items', () => {
    const schema = zodToJsonSchema(z.object({ ids: z.array(z.string()).min(1).max(500) }))
    expect(schema.properties?.ids?.type).toBe('array')
    expect(schema.properties?.ids?.items?.type).toBe('string')
  })

  it('marks a nullable field rather than emitting a type array', () => {
    const schema = zodToJsonSchema(z.object({ note: z.string().nullable() }))
    expect(schema.properties?.note?.nullable).toBe(true)
    expect(schema.properties?.note?.type).toBe('string')
  })
})

describe('stableSchema', () => {
  it('sorts keys at every depth so serialisation is byte-stable', () => {
    // Cache invalidation hunts start here: if two logically identical schemas
    // serialise differently, the cached prefix silently misses every request.
    const a = stableSchema({
      type: 'object',
      properties: { zebra: { type: 'string' }, alpha: { type: 'number' } },
      required: ['alpha'],
    })
    const b = stableSchema({
      required: ['alpha'],
      properties: { alpha: { type: 'number' }, zebra: { type: 'string' } },
      type: 'object',
    })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('is idempotent', () => {
    const once = stableSchema(zodToJsonSchema(z.object({ b: z.string(), a: z.number() })))
    expect(JSON.stringify(stableSchema(once))).toBe(JSON.stringify(once))
  })
})

describe('toGeminiSchema', () => {
  it('uppercases types the way the OpenAPI-flavoured Schema object expects', () => {
    const gemini = toGeminiSchema(
      zodToJsonSchema(z.object({ name: z.string(), count: z.number().int() })),
    )
    expect(gemini.type).toBe('OBJECT')
    const props = gemini.properties as Record<string, { type: string }>
    expect(props.name?.type).toBe('STRING')
    expect(props.count?.type).toBe('INTEGER')
  })

  it('emits no JSON Schema keyword Gemini rejects', () => {
    const gemini = toGeminiSchema(
      zodToJsonSchema(
        z.object({
          id: z.string().uuid(),
          tags: z.array(z.enum(['a', 'b'])),
          nested: z.object({ deep: z.string().optional() }),
        }),
      ),
    )
    const json = JSON.stringify(gemini)
    for (const banned of [
      '$ref',
      '$defs',
      '$schema',
      'additionalProperties',
      'oneOf',
      'allOf',
      'not',
      'patternProperties',
    ]) {
      expect(json).not.toContain(banned)
    }
  })
})
