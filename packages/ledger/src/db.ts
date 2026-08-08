import { env } from '@kakeibo/core/env'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

export type Db = NodePgDatabase<typeof schema>

let pool: pg.Pool | undefined
let db: Db | undefined

export function getDb(): Db {
  if (!db) {
    pool = new pg.Pool({ connectionString: env().DATABASE_URL, max: 8 })
    db = drizzle(pool, { schema })
  }
  return db
}

export function getPool(): pg.Pool {
  getDb()
  return pool!
}

export async function closeDb(): Promise<void> {
  await pool?.end()
  pool = undefined
  db = undefined
}

export { schema }
