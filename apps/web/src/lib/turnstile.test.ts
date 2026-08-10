import { resetEnvCache } from '@kakeibo/core/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { turnstileConfigured, verifyTurnstile } from './turnstile'

/*
 * `env()` memoises, so every case here has to forget it. Without the reset the
 * first call in the file freezes an empty secret for the whole run and the
 * three "once configured" cases silently exercise the unconfigured path — they
 * pass, and prove nothing.
 */
beforeEach(() => {
  delete process.env.TURNSTILE_SECRET_KEY
  resetEnvCache()
})

afterEach(() => {
  delete process.env.TURNSTILE_SECRET_KEY
  resetEnvCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('turnstile', () => {
  it('is inert when unconfigured, and says so', async () => {
    // The important half: with no secret set, an absent token still passes.
    // Otherwise every local run and every CI run fails on a challenge that
    // cannot be solved without a browser.
    expect(turnstileConfigured()).toBe(false)
    await expect(verifyTurnstile(undefined)).resolves.toBe(true)
  })

  it('rejects a missing token once configured', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret'
    resetEnvCache()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    expect(turnstileConfigured()).toBe(true)
    await expect(verifyTurnstile(undefined)).resolves.toBe(false)
    // No token means no reason to ask Cloudflare.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('passes a token Cloudflare accepts, and sends the address alongside it', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret'
    resetEnvCache()
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(verifyTurnstile('good-token', '203.0.113.7')).resolves.toBe(true)

    const [, init] = fetchSpy.mock.calls[0] as [string, { body: URLSearchParams }]
    expect(init.body.get('secret')).toBe('secret')
    expect(init.body.get('response')).toBe('good-token')
    expect(init.body.get('remoteip')).toBe('203.0.113.7')
  })

  it('fails closed when Cloudflare rejects, errors, or answers with a non-200', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret'
    resetEnvCache()

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: false }) }),
    )
    await expect(verifyTurnstile('bad-token')).resolves.toBe(false)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    await expect(verifyTurnstile('any-token')).resolves.toBe(false)

    // A verifier that cannot be reached must not read as a pass, or the layer
    // is removable by anyone who can break one request.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    await expect(verifyTurnstile('any-token')).resolves.toBe(false)
  })
})
