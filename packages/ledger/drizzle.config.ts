import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  // Both modules, because they are one database: the ledger's tables carry a
  // foreign key into Better Auth's `user`, and drizzle-kit cannot emit that
  // constraint from a schema path that only sees one side of it.
  schema: ['./src/schema.ts', './src/auth-schema.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://kakeibo:kakeibo@localhost:5433/kakeibo',
  },
  strict: true,
  verbose: true,
})
