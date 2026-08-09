import { env } from '@kakeibo/core/env'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as authSchema from './auth-schema'
import type { OwnerId } from './owner'
import * as ledgerSchema from './schema'

/**
 * One schema object over two modules. `auth-schema.ts` is regenerated from the
 * Better Auth config and `schema.ts` is written by hand, but they are one
 * database — and Better Auth's Drizzle adapter has to find `user`, `session`,
 * `account` and `verification` in whatever object it is handed.
 */
const schema = { ...ledgerSchema, ...authSchema }

export type Db = NodePgDatabase<typeof schema>

/** The transaction handle repository functions receive from `withOwner`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

let pool: pg.Pool | undefined
let db: Db | undefined

/**
 * The application connection.
 *
 * Prefers `APP_DATABASE_URL` when configured. That role does not own the
 * tables, so row-level security applies to it — which is the whole point of
 * having a second role.
 */
export function getDb(): Db {
  if (!db) {
    pool = new pg.Pool({
      connectionString: env().APP_DATABASE_URL || env().DATABASE_URL,
      max: 8,
    })
    db = drizzle(pool, { schema })
  }
  return db
}

export function getPool(): pg.Pool {
  getDb()
  return pool!
}

/**
 * Runs `fn` inside a transaction with `app.owner_id` set, which is what the
 * row-level security policies read.
 *
 * `SET LOCAL`, not `SET`. LOCAL is scoped to the transaction, so when the
 * pooler hands this connection to the next request the setting is already
 * gone. Plain `SET` persists for the life of the connection and would let one
 * request inherit the previous request's tenant — which behind a pooler is a
 * cross-tenant data leak that appears only under concurrency, i.e. in
 * production and never in a test.
 */
export async function withOwner<T>(owner: OwnerId, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    // set_config's third argument is `is_local`; true makes it SET LOCAL.
    // Parameterised rather than interpolated: owner reaches SQL directly.
    await tx.execute(sql`select set_config('app.owner_id', ${owner}, true)`)
    return fn(tx)
  })
}

let adminPool: pg.Pool | undefined
let adminDbInstance: Db | undefined

/**
 * The unscoped connection: migrations, `pnpm db:seed`, the eval harness, and —
 * in Plan C — the admin module, which is the only part of the application
 * allowed to touch it.
 *
 * Its OWN pool on DATABASE_URL, deliberately not `getDb()`. getDb() points at
 * the restricted `app_user` role, and if adminDb() were an alias for it,
 * seeding and evals would silently become subject to RLS — unable to write
 * rows for any owner but the one currently set, which is the single thing they
 * exist to do.
 */
export function adminDb(): Db {
  if (!adminDbInstance) {
    adminPool = new pg.Pool({ connectionString: env().DATABASE_URL, max: 4 })
    adminDbInstance = drizzle(adminPool, { schema })
  }
  return adminDbInstance
}

export async function closeDb(): Promise<void> {
  await pool?.end()
  await adminPool?.end()
  pool = undefined
  db = undefined
  adminPool = undefined
  adminDbInstance = undefined
}

export { schema }
