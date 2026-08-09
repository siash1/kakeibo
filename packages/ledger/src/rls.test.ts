import { loadEnv } from '@kakeibo/core/env'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, withOwner } from './db'
import { asOwnerId } from './owner'
import { resetOwners } from './testing'

loadEnv()

const alice = asOwnerId('00000000-0000-4000-8000-00000000e111')
const bob = asOwnerId('00000000-0000-4000-8000-00000000e222')

beforeAll(async () => {
  await resetOwners(alice, bob)
}, 60_000)

afterAll(async () => {
  await closeDb()
})

/**
 * Drizzle wraps driver errors, and the wrapper's message is the SQL rather than
 * the reason. The Postgres RLS violation lives on the cause, so assertions have
 * to walk the chain — checking only `error.message` passes for the wrong reason
 * on any failed insert.
 */
function reasons(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    parts.push(current.message)
    current = (current as { cause?: unknown }).cause
  }
  return parts.join(' <- ')
}

describe('row-level security backstop', () => {
  it('is enabled on every owner-scoped table', async () => {
    const result = await withOwner(alice, (tx) =>
      tx.execute(sql`
        select tablename from pg_tables
        where schemaname = 'public'
          and tablename in ('accounts','transactions','postings','rules','budgets',
                            'memories','import_batches','trace_runs','trace_events')
          and rowsecurity = false
      `),
    )
    expect(result.rows).toEqual([])
  })

  it('hides rows from a query that forgot its where clause', async () => {
    // The whole point. An UNSCOPED select, as a careless repository function
    // would issue, must still return nothing belonging to another owner.
    await withOwner(alice, (tx) =>
      tx.execute(
        sql`insert into accounts (owner_id, name, type) values (${alice}, 'RLS Probe', 'expense')`,
      ),
    )

    const leaked = await withOwner(bob, (tx) =>
      tx.execute(sql`select * from accounts where name = 'RLS Probe'`),
    )
    expect(leaked.rows).toEqual([])
  })

  it('refuses to write a row belonging to someone else', async () => {
    // WITH CHECK, not USING. USING alone would let Bob INSERT a row stamped
    // with Alice's owner_id — he just could not read it back afterwards.
    let thrown: unknown
    try {
      await withOwner(bob, (tx) =>
        tx.execute(
          sql`insert into accounts (owner_id, name, type) values (${alice}, 'Forged', 'expense')`,
        ),
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown, 'the forged insert should have been rejected').toBeDefined()
    expect(reasons(thrown)).toMatch(/row-level security/i)
  })
})
