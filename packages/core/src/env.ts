import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

let loaded = false

/**
 * Loads .env once, walking up from cwd so the CLI, the eval runner and the web
 * app all find the same file no matter which package they were started from.
 */
export function loadEnv(): void {
  if (loaded) return
  loaded = true
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    loadDotenv({ path: `${dir}/.env`, quiet: true })
    const parent = dir.replace(/\/[^/]+$/, '')
    if (parent === dir || parent === '') break
    dir = parent
  }
}

const boolish = z
  .union([z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false'), z.literal('')])
  .transform((v) => v === '1' || v === 'true')

const EnvSchema = z.object({
  GEMINI_AUTH: z.enum(['vertex', 'apikey']).default('vertex'),
  GCP_PROJECT_ID: z.string().default(''),
  GCP_REGION: z.string().default('global'),
  GEMINI_API_KEY: z.string().default(''),

  AGENT_MODEL: z.string().default('gemini-3.6-flash'),
  SUMMARIZER_MODEL: z.string().default('gemini-3.5-flash-lite'),
  JUDGE_MODEL: z.string().default('gemini-3.1-pro-preview'),
  THINKING_LEVEL: z.string().default(''),
  TRACE_THINKING: boolish.default(false),

  DATABASE_URL: z.string().default('postgres://kakeibo:kakeibo@localhost:5433/kakeibo'),
  /**
   * Application connection, as a role that does NOT own the tables so
   * row-level security applies to it. Empty falls back to DATABASE_URL, which
   * is what keeps local development working before the RLS migration lands.
   */
  APP_DATABASE_URL: z.string().default(''),
  CONTEXT_BUDGET_TOKENS: z.coerce.number().int().positive().default(60_000),
  ALLOW_WRITES: boolish.default(false),
  PORT: z.coerce.number().int().default(3000),

  /**
   * Auth (spec §2). Better Auth reads BETTER_AUTH_SECRET and BETTER_AUTH_URL
   * from process.env itself; they are declared here so that every environment
   * variable this repo needs is described in one schema, and so a missing
   * secret is a startup error rather than a silently insecure default.
   *
   * Google's pair may be empty: email/password and anonymous sign-in need no
   * external setup, and the sign-in UI hides the Google button when the client
   * id is absent.
   */
  BETTER_AUTH_SECRET: z.string().default(''),
  BETTER_AUTH_URL: z.string().default('http://localhost:3000'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),

  /**
   * Cost control (spec §5). Four layers, cheapest first, and the defaults are
   * derived rather than guessed: a cached web turn measures at ~$0.0045, so a
   * $20/month ceiling is $0.667/day, which is about 148 live turns.
   *
   * The per-IP cap is deliberately higher than the anonymous per-owner quota.
   * Offices, universities and mobile carriers put many genuine visitors behind
   * one address, and a cap equal to the anonymous quota would let the first
   * visitor lock out everyone else in the building.
   */
  ANON_DAILY_MESSAGE_QUOTA: z.coerce.number().int().positive().default(8),
  USER_DAILY_MESSAGE_QUOTA: z.coerce.number().int().positive().default(25),
  IP_DAILY_MESSAGE_QUOTA: z.coerce.number().int().positive().default(20),
  GLOBAL_DAILY_BUDGET_USD: z.coerce.number().positive().default(0.667),
  /**
   * Salts the per-IP key so raw addresses are never stored. Empty is allowed
   * and means local development; in production an empty salt makes the stored
   * hashes a plain rainbow-table lookup of the IPv4 space.
   */
  RATE_LIMIT_SALT: z.string().default(''),

  /** Fixture modes (spec 8.2). RECORD writes fixtures, REPLAY reads them. */
  RECORD: boolish.default(false),
  REPLAY: boolish.default(false),
  /** Explicit context caching can be disabled to measure the delta (spec 5.5). */
  EXPLICIT_CACHE: boolish.default(true),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | undefined

export function env(): Env {
  if (cached) return cached
  loadEnv()
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment:\n${issues}\n\nCopy .env.example to .env and fill it in.`)
  }
  cached = parsed.data
  return cached
}

/** Test helper: forget the memoised env so a mutated process.env takes effect. */
export function resetEnvCache(): void {
  cached = undefined
}
