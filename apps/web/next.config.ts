import type { NextConfig } from 'next'

const config: NextConfig = {
  // The workspace packages ship TypeScript source rather than a build step, so
  // Next compiles them alongside the app.
  transpilePackages: ['@kakeibo/core', '@kakeibo/ledger', '@kakeibo/evals'],
  serverExternalPackages: ['pg'],
  experimental: {
    // The chat route streams for as long as a turn takes.
    proxyTimeout: 300_000,
  },
}

export default config
