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
                            'memories','import_batches','trace_runs','trace_events',
                            'conversations','conversation_messages','suspended_turns')
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

describe('the auth tables are out of the application role reach', () => {
  it('refuses the application role a read of "user"', async () => {
    // These four tables carry no owner_id, so row-level security has nothing to
    // scope them by. Privileges are the only lever, and 0002's ALTER DEFAULT
    // PRIVILEGES would otherwise have granted app_user everything on tables
    // created after it. A SELECT here returns every visitor's email address.
    let thrown: unknown
    try {
      await withOwner(alice, (tx) => tx.execute(sql`select id from "user" limit 1`))
    } catch (error) {
      thrown = error
    }
    expect(thrown, 'the application role should not be able to read "user"').toBeDefined()
    expect(reasons(thrown)).toMatch(/permission denied/i)
  })

  it('still lets the application role write a ledger row for an owner it cannot read', async () => {
    // Postgres runs referential integrity as the referenced table's owner, so
    // revoking the privilege does not break the foreign key. If that were not
    // true, revoking would have made the whole application unable to write.
    await withOwner(alice, (tx) =>
      tx.execute(
        sql`insert into accounts (owner_id, name, type) values (${alice}, 'FK Probe', 'expense')`,
      ),
    )

    const rows = await withOwner(alice, (tx) =>
      tx.execute(sql`select name from accounts where name = 'FK Probe'`),
    )
    expect(rows.rows).toHaveLength(1)
  })

  it('refuses a ledger row whose owner has no principal', async () => {
    // The foreign key is what makes owner_id mean user.id. Without it an
    // invented uuid would silently own rows that no account can ever delete.
    const ghost = asOwnerId('00000000-0000-4000-8000-00000000e999')
    let thrown: unknown
    try {
      await withOwner(ghost, (tx) =>
        tx.execute(
          sql`insert into accounts (owner_id, name, type) values (${ghost}, 'Ghost', 'expense')`,
        ),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown, 'an owner with no user row should not be able to own anything').toBeDefined()
    expect(reasons(thrown)).toMatch(/foreign key/i)
  })
})
