import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The MCP server, exercised over a real stdio transport with the real SDK client
 * (spec 12). Spawning the process is the point: the interesting failures here —
 * a barrel import dragging a provider SDK in, stdout polluted by a log line,
 * write tools leaking past the gate — are all invisible to an in-process test.
 *
 * Runs against the seeded ledger and makes no model calls, so it is free.
 */

const serverEntry = fileURLToPath(new URL('./index.ts', import.meta.url))
const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))

let open: { client: Client; transport: StdioClientTransport } | undefined

async function connect(allowWrites: boolean): Promise<Client> {
  const transport = new StdioClientTransport({
    command: tsx,
    args: [serverEntry],
    env: {
      ...(process.env as Record<string, string>),
      ALLOW_WRITES: allowWrites ? '1' : '0',
    },
  })
  const client = new Client({ name: 'kakeibo-test', version: '0.1.0' })
  await client.connect(transport)
  open = { client, transport }
  return client
}

afterEach(async () => {
  await open?.client.close()
  open = undefined
})

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return content.map((part) => part.text ?? '').join('')
}

describe('MCP server', () => {
  it('exposes only read tools when started read-only', async () => {
    const client = await connect(false)
    const { tools } = await client.listTools()

    expect(tools.map((t) => t.name).sort()).toEqual([
      'convert_currency',
      'detect_recurring',
      'flag_anomalies',
      'get_budget_status',
      'get_spend_report',
      'list_accounts',
      'search_transactions',
    ])
    // Annotations let a client show the right affordance without guessing.
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
  })

  it('exposes all twelve tools when started with ALLOW_WRITES=1', async () => {
    const client = await connect(true)
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(12)
    expect(tools.map((t) => t.name)).toContain('set_budget')
  })

  it('answers a real question from the seeded ledger', async () => {
    const client = await connect(false)
    const result = await client.callTool({
      name: 'get_spend_report',
      arguments: { period: '2025-03', group_by: 'category' },
    })

    const payload = JSON.parse(textOf(result)) as {
      groups: { group: string; amountMinor: number; formatted: string }[]
    }
    const groceries = payload.groups.find((g) => g.group === 'Groceries')
    expect(groceries?.amountMinor).toBe(2_335_000)
    expect(groceries?.formatted).toBe('₹23,350.00')
  })

  it('re-validates arguments rather than trusting the declared schema', async () => {
    const client = await connect(false)
    const result = await client.callTool({
      name: 'get_spend_report',
      arguments: { period: 'March' },
    })

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('YYYY-MM')
  })

  it('refuses a write tool when read-only, and says why', async () => {
    const client = await connect(false)
    const result = await client.callTool({
      name: 'set_budget',
      arguments: { category: 'Dining', month: '2025-07', amount_minor: 800_000 },
    })

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('ALLOW_WRITES=1')
  })

  it('names the tools that do exist when asked for one that does not', async () => {
    const client = await connect(false)
    const result = await client.callTool({ name: 'get_spend_repot', arguments: {} })

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('get_spend_report')
  })

  it('serves the domain instructions to the client', async () => {
    const client = await connect(false)
    expect(client.getInstructions()).toContain('double-entry')
  })
})
