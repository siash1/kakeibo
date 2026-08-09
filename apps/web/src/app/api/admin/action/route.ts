import { loadEnv } from '@kakeibo/core'
import { blockOwner, pauseLiveChat } from '@kakeibo/ledger'
import { adminSession } from '@/lib/admin'

/**
 * POST /api/admin/action — the two operator writes (spec §9.4).
 *
 * 404 for anyone who is not the operator, never 403. A 403 confirms the route
 * exists, which is free reconnaissance for anyone probing a public site.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

loadEnv()

export async function POST(request: Request): Promise<Response> {
  const session = await adminSession()
  if (!session) return new Response('Not found', { status: 404 })

  const body = (await request.json()) as {
    action?: 'pause_live_chat' | 'block_owner'
    paused?: boolean
    ownerId?: string
    blocked?: boolean
  }

  if (body.action === 'pause_live_chat') {
    await pauseLiveChat(session, body.paused === true)
    return Response.json({ ok: true })
  }

  if (body.action === 'block_owner' && body.ownerId) {
    await blockOwner(session, body.ownerId, body.blocked === true)
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'unknown action' }, { status: 400 })
}
