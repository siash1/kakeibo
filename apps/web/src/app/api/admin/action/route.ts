import { loadEnv } from '@kakeibo/core'
import { asOwnerId, blockOwner, pauseLiveChat } from '@kakeibo/ledger'
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
    // asOwnerId throws on anything that is not a uuid, and `user.id` always
    // is one — so this is validation, not a scoping check. Without it, a
    // malformed id reaches `eq(user.id, ownerId)` and Postgres raises 22P02,
    // which escaped as an unhandled 500 before this caught it.
    let ownerId: ReturnType<typeof asOwnerId>
    try {
      ownerId = asOwnerId(body.ownerId)
    } catch {
      return Response.json({ error: 'invalid ownerId' }, { status: 400 })
    }
    await blockOwner(session, ownerId, body.blocked === true)
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'unknown action' }, { status: 400 })
}
