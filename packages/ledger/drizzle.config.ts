import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://kakeibo:kakeibo@localhost:5433/kakeibo',
  },
  strict: true,
  verbose: true,
})
