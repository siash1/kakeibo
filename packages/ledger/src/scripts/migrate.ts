import { loadEnv } from '@kakeibo/core/env'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { adminDb, closeDb } from '../db'

loadEnv()

const migrationsFolder = new URL('../../drizzle', import.meta.url).pathname

async function main(): Promise<void> {
  console.log('Applying migrations from', migrationsFolder)
  // adminDb, not getDb: DDL requires the owning role, and the app role
  // deliberately cannot run it.
  await migrate(adminDb(), { migrationsFolder })
  console.log('Migrations applied.')
  await closeDb()
}

main().catch(async (error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error)
  await closeDb()
  process.exit(1)
})
