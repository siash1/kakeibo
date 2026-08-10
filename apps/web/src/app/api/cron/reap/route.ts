import { env } from '@kakeibo/core/env'
import { reap } from '@kakeibo/ledger'

/**
 * GET /api/cron/reap — the nightly sweep, on a schedule Vercel owns.
 *
 * Authenticated by `CRON_SECRET`, which Vercel sends as a bearer token on every
 * cron invocation. Without the check this is an unauthenticated endpoint that
 * deletes rows, reachable by anyone who guesses the path.
 *
 * It answers 404 rather than 401 to a bad token, the same way `/admin` does: a
 * 401 confirms the route exists and is worth grinding on, and this one deletes
 * things.
 *
 * The secret is read from `process.env` rather than the parsed schema because
 * Vercel sets it on the project rather than in `.env`, and because an empty
 * value has to mean "no check" for local development — which is also why
 * `docs/deploy.md` lists it as required in production.
 *
 * It returns the counts so a failed sweep is visible in Vercel's log rather
 * than silent.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  // Touch the env schema so a misconfigured deployment fails here rather than
  // halfway through a delete.
  env()

  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'not found' }, { status: 404 })
  }

  const result = await reap()
  return Response.json(result)
}
