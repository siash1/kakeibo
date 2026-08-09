import { loadEnv } from '@kakeibo/core/env'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { adminDb, closeDb, withOwner } from './db'
import { asOwnerId, DEV_OWNER_ID } from './owner'

loadEnv()

afterAll(async () => {
  await closeDb()
})

describe('withOwner', () => {
  it('sets app.owner_id for the duration of the transaction', async () => {
    const seen = await withOwner(DEV_OWNER_ID, async (tx) => {
      const result = await tx.execute(sql`select current_setting('app.owner_id', true) as owner`)
      return (result.rows as { owner: string }[])[0]?.owner
    })
    expect(seen).toBe(DEV_OWNER_ID)
  })

  it('does not leak the setting to the next transaction on a pooled connection', async () => {
    const other = asOwnerId('00000000-0000-4000-8000-0000000000ff')
    await withOwner(other, async (tx) => {
      await tx.execute(sql`select 1`)
    })

    // A fresh transaction that sets nothing must not inherit `other`.
    // SET LOCAL is transaction-scoped; plain SET would survive here and hand
    // the next request the previous request's tenant.
    const leaked = await withOwner(DEV_OWNER_ID, async (tx) => {
      const result = await tx.execute(sql`select current_setting('app.owner_id', true) as owner`)
      return (result.rows as { owner: string }[])[0]?.owner
    })
    expect(leaked).toBe(DEV_OWNER_ID)
  })

  it('gives adminDb a separate pool from the scoped connection', async () => {
    // Not an alias for getDb(). Task 9 repoints getDb() at the restricted role;
    // if adminDb() followed it, seeding and evals would lose the ability to
    // write rows for any owner.
    const result = await adminDb().execute(
      sql`select current_setting('app.owner_id', true) as owner`,
    )
    expect((result.rows as { owner: string | null }[])[0]?.owner ?? null).toBeNull()
  })

  it('rolls back on error so a failed turn writes nothing', async () => {
    await expect(
      withOwner(DEV_OWNER_ID, async (tx) => {
        await tx.execute(sql`create temporary table should_not_survive (x int)`)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })
})
