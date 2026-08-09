import { env } from '@kakeibo/core/env'

/**
 * Cloudflare Turnstile, layer 4 of the cost ceiling (design spec §5).
 *
 * The first three layers count what a visitor has already spent. This one is
 * the only layer that costs an attacker anything *before* they spend the
 * owner's money, which is why it sits in front of the model call rather than
 * beside it.
 *
 * Unconfigured means disabled, deliberately. A challenge cannot be solved by a
 * headless test or a local `pnpm dev` without a real site key, so requiring one
 * would turn every chat test into a failure about Cloudflare. Production sets
 * both keys; nothing else does.
 *
 * It fails closed once configured: a rejection, a non-200, or a network error
 * talking to Cloudflare all reject the turn. The alternative — treating an
 * unreachable verifier as a pass — makes the layer removable by anyone who can
 * make one request fail.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Whether the gate is on at all. The widget mirrors this on the client. */
export function turnstileConfigured(): boolean {
  return env().TURNSTILE_SECRET_KEY !== ''
}

export async function verifyTurnstile(
  token: string | undefined,
  ip?: string | undefined,
): Promise<boolean> {
  const secret = env().TURNSTILE_SECRET_KEY
  if (secret === '') return true
  if (!token) return false

  const body = new URLSearchParams({ secret, response: token })
  // Cloudflare wants the address, not the salted hash the quota layer stores,
  // so this is the one place in the app that reads it unhashed — and it is
  // passed straight out rather than written down.
  if (ip) body.set('remoteip', ip)

  try {
    const response = await fetch(VERIFY_URL, { method: 'POST', body })
    if (!response.ok) return false
    const result = (await response.json()) as { success?: boolean }
    return result.success === true
  } catch {
    return false
  }
}
