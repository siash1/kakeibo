import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    // The agent loop + DB integration tests are slower than the 5s default.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // DB-backed suites share one Postgres schema; run files serially.
    fileParallelism: false,
    setupFiles: ['tests/setup.ts'],
  },
})
