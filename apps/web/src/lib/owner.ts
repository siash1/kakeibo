import { asOwnerId, hashIp, type OwnerId } from '@kakeibo/ledger'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'

/**
 * The single door from an HTTP request to an OwnerId.
 *
 * Anonymous visitors are signed in transparently on first contact, so every
 * request that reaches a route handler has an owner and no route ever branches
 * on "logged in or not". The design's first success criterion is a real
 * question answered against a real ledger in under ten seconds from landing;
 * a sign-up form in the way of that is the thing being avoided.
 *
 * Sign-in has to happen in a route handler rather than anywhere else, because
 * it sets a cookie and only route handlers and server actions can. `setCookie`
 * is handed back for the caller to put on its own response — including a
 * streaming one, where the headers go out long before the body ends.
 */

export interface ResolvedOwner {
  owner: OwnerId
  isAnonymous: boolean
  email: string
  /** Present only when this request created the session. Forward it verbatim. */
  setCookie?: string
}

export async function resolveOwner(request: Request): Promise<ResolvedOwner> {
  const existing = await auth.api.getSession({ headers: request.headers })
  if (existing) {
    return {
      owner: asOwnerId(existing.user.id),
      isAnonymous: existing.user.isAnonymous === true,
      email: existing.user.email,
    }
  }

  // asResponse, because the Set-Cookie header is the point: the JSON body alone
  // would give us a user id whose session the browser never learns about, and
  // the next request would mint another one.
  const response = await auth.api.signInAnonymous({ headers: request.headers, asResponse: true })
  const body = (await response.json()) as { user?: { id?: string; email?: string } }
  if (!body.user?.id) {
    throw new Error(`Anonymous sign-in failed: ${response.status}`)
  }

  return {
    owner: asOwnerId(body.user.id),
    isAnonymous: true,
    email: body.user.email ?? '',
    ...(response.headers.get('set-cookie')
      ? { setCookie: response.headers.get('set-cookie') as string }
      : {}),
  }
}

/**
 * The owner of whoever is looking at a server-rendered page, if there is one.
 *
 * Deliberately does not sign anyone in. A server component cannot set a cookie,
 * so a page that tried would mint a user per render and hand out none of their
 * sessions. Pages that need an owner render an empty state instead, which is
 * also the honest thing to show someone who has not talked to the agent yet.
 */
export async function viewerOwner(): Promise<ResolvedOwner | undefined> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) return undefined
  return {
    owner: asOwnerId(session.user.id),
    isAnonymous: session.user.isAnonymous === true,
    email: session.user.email,
  }
}

/**
 * The visitor's address, hashed, or undefined when there is no address to read.
 *
 * Vercel sets `x-forwarded-for` at the edge; locally nothing does, and the
 * per-IP layer simply does not apply. The leftmost entry is the client — the
 * rest are proxies, and reading the wrong one would key every visitor behind
 * the same proxy to one bucket.
 *
 * The raw value never leaves this function: hashIp salts and dates it, so what
 * reaches the database cannot be turned back into an address.
 */
export function requestIpHash(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip')
  const ip = forwarded?.split(',')[0]?.trim()
  return ip ? hashIp(ip) : undefined
}
