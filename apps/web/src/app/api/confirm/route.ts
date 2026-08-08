import { resolveConfirmation } from '@/lib/session'

/**
 * POST /api/confirm { id, allow } — resolves the promise the agent loop is
 * blocked on inside a write-tier tool (spec 8.6.1).
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { id?: string; allow?: boolean }
  if (!body.id) return Response.json({ error: 'id is required' }, { status: 400 })

  const resolved = resolveConfirmation(body.id, body.allow === true)
  if (!resolved) {
    // Either already answered or timed out. Not an error worth failing on — the
    // UI just needs to stop showing the card.
    return Response.json({ ok: false, reason: 'no pending confirmation with that id' })
  }
  return Response.json({ ok: true })
}
