import { config } from 'dotenv'

// Tests run against replay fixtures by default: no API keys, no cost (spec 8.2).
config({ path: new URL('../.env', import.meta.url).pathname, quiet: true })

process.env.REPLAY ??= '1'
process.env.DATABASE_URL ??= 'postgres://kakeibo:kakeibo@localhost:5433/kakeibo'
process.env.AGENT_MODEL ??= 'gemini-2.5-flash'
process.env.SUMMARIZER_MODEL ??= 'gemini-2.5-flash-lite'
process.env.JUDGE_MODEL ??= 'gemini-2.5-pro'
process.env.GEMINI_AUTH ??= 'vertex'
process.env.GCP_PROJECT_ID ??= 'replay-only'
