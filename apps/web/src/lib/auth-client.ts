import { anonymousClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/**
 * The browser client.
 *
 * No baseURL: the app is served from the same origin as its auth routes, and
 * hard-coding one is how a preview deployment ends up posting its sign-in to
 * production.
 */
export const authClient = createAuthClient({ plugins: [anonymousClient()] })
