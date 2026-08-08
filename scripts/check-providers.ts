import { env, GeminiAdapter, loadEnv, resetEnvCache } from '@kakeibo/core'

/**
 * `pnpm check:providers` — the preflight (spec 5.4).
 *
 * Model IDs move faster than any document can. This resolves each role's
 * candidate chain against the account that is actually configured, prints what
 * worked, and hands back the .env lines to paste. Run it first, and run it again
 * whenever a request starts 404ing.
 *
 * If Vertex fails wholesale it retries in apikey mode, because "which auth path
 * do I actually have" is the other question this script exists to answer.
 */

interface Role {
  name: string
  envVar: string
  /** First available wins. */
  candidates: string[]
}

/**
 * Chains updated from the spec's placeholders to IDs that exist. The spec's
 * `gemini-3-flash` / `gemini-3-pro` were never published under those names;
 * the shipped 3.x line is 3.6/3.5/3.1 plus the original `-preview` tags. The
 * roles are unchanged: flash-tier loop, flash-lite summariser, pro-tier judge.
 */
const ROLES: Role[] = [
  {
    name: 'Agent loop',
    envVar: 'AGENT_MODEL',
    candidates: [
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
    ],
  },
  {
    name: 'Eviction summarizer',
    envVar: 'SUMMARIZER_MODEL',
    candidates: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'],
  },
  {
    name: 'Eval judge',
    envVar: 'JUDGE_MODEL',
    candidates: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro'],
  },
]

interface Probe {
  model: string
  ok: boolean
  latencyMs: number
  error?: string
  servedAs?: string
}

async function probe(adapter: GeminiAdapter, model: string): Promise<Probe> {
  const started = Date.now()
  try {
    const result = await adapter.stream({
      model,
      system: 'Reply with one word.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [],
      maxTokens: 16,
    })
    const latencyMs = Date.now() - started
    if (result.stopReason === 'error') {
      return { model, ok: false, latencyMs, error: result.errorMessage ?? 'unknown error' }
    }
    return {
      model,
      ok: true,
      latencyMs,
      ...(result.modelVersion ? { servedAs: result.modelVersion } : {}),
    }
  } catch (error) {
    return {
      model,
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runForAuth(mode: 'vertex' | 'apikey'): Promise<Map<string, Probe[]> | undefined> {
  process.env.GEMINI_AUTH = mode
  resetEnvCache()

  let adapter: GeminiAdapter
  try {
    adapter = new GeminiAdapter()
  } catch (error) {
    console.log(
      `  cannot construct a ${mode} client: ${error instanceof Error ? error.message : error}`,
    )
    return undefined
  }

  const results = new Map<string, Probe[]>()
  for (const role of ROLES) {
    const probes: Probe[] = []
    for (const model of role.candidates) {
      const result = await probe(adapter, model)
      probes.push(result)
      // First hit wins; no point paying for the rest of the chain.
      if (result.ok) break
    }
    results.set(role.envVar, probes)
  }
  return results
}

function printTable(results: Map<string, Probe[]>): void {
  const width = 30
  console.log(`\n  ${'MODEL'.padEnd(width)} ${'STATUS'.padEnd(8)} ${'LATENCY'.padEnd(9)} DETAIL`)
  console.log(`  ${'-'.repeat(width)} ${'-'.repeat(8)} ${'-'.repeat(9)} ${'-'.repeat(40)}`)
  for (const [envVar, probes] of results) {
    console.log(`  ${envVar}`)
    for (const p of probes) {
      const status = p.ok ? 'ok' : 'FAIL'
      const detail = p.ok
        ? p.servedAs && p.servedAs !== p.model
          ? `served as ${p.servedAs}`
          : ''
        : truncate(p.error ?? '', 70)
      console.log(
        `    ${p.model.padEnd(width - 2)} ${status.padEnd(8)} ${`${p.latencyMs}ms`.padEnd(9)} ${detail}`,
      )
    }
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

async function main(): Promise<void> {
  loadEnv()
  const configured = env()

  console.log('kakeibo provider preflight')
  console.log(`  auth mode : ${configured.GEMINI_AUTH}`)
  console.log(`  project   : ${configured.GCP_PROJECT_ID || '(unset)'}`)
  console.log(`  region    : ${configured.GCP_REGION}`)
  console.log(`  api key   : ${configured.GEMINI_API_KEY ? 'present' : 'absent'}`)

  let mode: 'vertex' | 'apikey' = configured.GEMINI_AUTH
  let results = await runForAuth(mode)
  let anyOk = results ? [...results.values()].some((probes) => probes.some((p) => p.ok)) : false

  if (!anyOk && mode === 'vertex' && configured.GEMINI_API_KEY) {
    console.log('\n  Vertex failed for every candidate. Retrying with GEMINI_AUTH=apikey…')
    mode = 'apikey'
    results = await runForAuth(mode)
    anyOk = results ? [...results.values()].some((probes) => probes.some((p) => p.ok)) : false
  }

  if (!results || !anyOk) {
    console.error('\n  No model responded on any auth path.')
    console.error('  Check: gcloud auth application-default login, GCP_PROJECT_ID, and that')
    console.error('  aiplatform.googleapis.com is enabled on the project.')
    process.exit(1)
  }

  printTable(results)

  console.log('\n  Resolved. Put these in .env:\n')
  console.log(`GEMINI_AUTH=${mode}`)
  if (mode === 'vertex') {
    console.log(`GCP_PROJECT_ID=${configured.GCP_PROJECT_ID}`)
    console.log(`GCP_REGION=${configured.GCP_REGION}`)
  }
  for (const [envVar, probes] of results) {
    const winner = probes.find((p) => p.ok)
    if (winner) {
      console.log(`${envVar}=${winner.model}`)
    } else {
      // The summariser falls back to the agent model rather than failing the
      // run: an eviction summary from a bigger model is a cost problem, not a
      // correctness one (spec 5.2).
      const fallback =
        envVar === 'SUMMARIZER_MODEL'
          ? results.get('AGENT_MODEL')?.find((p) => p.ok)?.model
          : undefined
      console.log(
        `# ${envVar}: no candidate responded${fallback ? ` — falling back to ${fallback}` : ''}`,
      )
      if (fallback) console.log(`${envVar}=${fallback}`)
    }
  }
  console.log()
}

main().catch((error) => {
  console.error('Preflight failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
