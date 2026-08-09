import { env, loadEnv } from '@kakeibo/core/env'
import { adminDb, repointOwner, schema } from '@kakeibo/ledger'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { anonymous } from 'better-auth/plugins'

/**
 * The Better Auth server instance (spec §2).
 *
 * Every visitor is a user from their first request; anonymous ones are simply
 * users with no credentials attached yet. That collapses what would otherwise
 * be two principal types into one, and makes `owner_id` on a ledger row always
 * `user.id` — which is the property Plan A's scoping and RLS both rest on.
 */

loadEnv()

const config = env()

export const auth = betterAuth({
  // adminDb, not the app connection. Better Auth manages its own tables and
  // must not be subject to the ledger's row-level security: it looks a user up
  // by session token before any owner is known, which is exactly the query the
  // policies exist to refuse.
  database: drizzleAdapter(adminDb(), { provider: 'pg', schema }),
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL,
  emailAndPassword: { enabled: true },
  // Spread rather than declared with empty strings: Better Auth logs a warning
  // for a provider configured without credentials, and an unconfigured Google
  // is the normal local state rather than a mistake worth shouting about.
  ...(config.GOOGLE_CLIENT_ID
    ? {
        socialProviders: {
          google: {
            clientId: config.GOOGLE_CLIENT_ID,
            clientSecret: config.GOOGLE_CLIENT_SECRET,
          },
        },
      }
    : {}),
  advanced: {
    // user.id must be a uuid, because owner_id on nine ledger tables references
    // it and Postgres will not join text to uuid. Better Auth's default is a
    // 32-character random string, which would force every owner column to
    // widen to text and give up asOwnerId's validation. With the pg Drizzle
    // adapter this setting makes Better Auth omit the id entirely and let the
    // column's gen_random_uuid() default supply it.
    database: { generateId: 'uuid' },
  },
  plugins: [
    anonymous({
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        // The plugin deletes the anonymous user the moment this returns, and
        // owner_id cascades from it — so the ledger has to change hands here,
        // synchronously, rather than on the next request.
        await repointOwner(anonymousUser.user.id, newUser.user.id)
      },
    }),
  ],
})

/** Whether the sign-in UI should offer Google at all. */
export const googleEnabled = config.GOOGLE_CLIENT_ID !== ''
