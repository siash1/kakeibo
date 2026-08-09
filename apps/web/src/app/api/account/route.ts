import { deleteUser } from '@kakeibo/ledger'
import { auth } from '@/lib/auth'

/**
 * DELETE /api/account — the visitor erases themselves.
 *
 * One statement does all of it: deleting the `"user"` row cascades through
 * every `owner_id` and takes the ledger, the conversation, the traces and any
 * suspended turn with it (CLAUDE.md rule 7). `link.test.ts` asserts that
 * cascade table by table, because this endpoint is the promise `/privacy`
 * makes and the cascade is the only thing keeping it.
 *
 * It reads the session directly rather than going through `resolveOwner`,
 * which signs an anonymous visitor in when there is none. A DELETE that
 * silently created an account and then deleted it would return a cheerful 200
 * having touched nothing of the caller's.
 *
 * The session cookie is left pointing at a row that no longer exists — Better
 * Auth's `session` table cascades from `"user"` too — so the next request reads
 * as signed out and the visitor lands back where a first-time visitor lands,
 * which is the correct end state.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return Response.json({ error: 'no session' }, { status: 401 })

  const deleted = await deleteUser(session.user.id)
  return Response.json({ deleted })
}
