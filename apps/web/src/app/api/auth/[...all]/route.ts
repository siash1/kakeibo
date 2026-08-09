import { toNextJsHandler } from 'better-auth/next-js'
import { auth } from '@/lib/auth'

/**
 * Better Auth's own endpoints: sign-in, sign-up, sign-out, session, the
 * anonymous plugin's /sign-in/anonymous, and the OAuth callback.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const { GET, POST } = toNextJsHandler(auth)
