import { loadEnv } from '@kakeibo/core'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { closeDb, getDb } from '../db'

loadEnv()

const migrationsFolder = new URL('../../drizzle', import.meta.url).pathname

async function main(): Promise<void> {
  console.log('Applying migrations from', migrationsFolder)
  await migrate(getDb(), { migrationsFolder })
  console.log('Migrations applied.')
  await closeDb()
}

main().catch(async (error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error)
  await closeDb()
  process.exit(1)
})
