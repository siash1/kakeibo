import { resetEnvCache } from '@kakeibo/core/env'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requestGeo, resetGeoReader } from './geo'

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/chat', { headers })
}

/*
 * Every case here runs with no database configured, which is the local and CI
 * state. The local-lookup branch is exercised on the deployed host instead —
 * a 150 MB MMDB file is not something to commit or download in CI, and a test
 * that stubbed the reader would assert the stub.
 */
beforeEach(() => {
  delete process.env.GEOIP_DB_PATH
  resetEnvCache()
  resetGeoReader()
})

afterEach(() => {
  delete process.env.GEOIP_DB_PATH
  resetEnvCache()
  resetGeoReader()
})

describe('requestGeo', () => {
  it('reads Vercel edge headers into a coarse location', () => {
    expect(
      requestGeo(
        req({
          'x-vercel-ip-country': 'IN',
          'x-vercel-ip-country-region': 'KA',
          'x-vercel-ip-city': 'Bengaluru',
          'x-vercel-ip-latitude': '12.9716',
          'x-vercel-ip-longitude': '77.5946',
        }),
      ),
    ).toEqual({
      country: 'IN',
      region: 'KA',
      city: 'Bengaluru',
      lat: 12.9716,
      lon: 77.5946,
    })
  })

  it('returns nothing at all when there are no headers and no database', () => {
    // Local development, and any request whose address nothing could resolve.
    // The columns are nullable for exactly this case.
    expect(requestGeo(req({}))).toBeUndefined()
  })

  it('decodes a percent-encoded city name', () => {
    // Vercel percent-encodes the city header, so "São Paulo" arrives as
    // "S%C3%A3o%20Paulo" and would otherwise be stored mojibaked forever.
    const geo = requestGeo(req({ 'x-vercel-ip-city': 'S%C3%A3o%20Paulo' }))
    expect(geo?.city).toBe('São Paulo')
  })

  it('drops coordinates it cannot parse rather than storing NaN', () => {
    const geo = requestGeo(
      req({ 'x-vercel-ip-country': 'IN', 'x-vercel-ip-latitude': 'not-a-number' }),
    )
    expect(geo).toEqual({ country: 'IN' })
  })

  it('falls back to Cloudflare headers when Vercel is not in front', () => {
    expect(
      requestGeo(req({ 'cf-ipcountry': 'IN', 'cf-region-code': 'KA', 'cf-ipcity': 'Bengaluru' })),
    ).toEqual({ country: 'IN', region: 'KA', city: 'Bengaluru' })
  })

  it('ignores Cloudflare’s XX, which means "unknown"', () => {
    // Cloudflare sends XX for addresses it cannot place — Tor exits, some
    // satellite ranges. Storing it would put a country named XX on the map.
    expect(requestGeo(req({ 'cf-ipcountry': 'XX' }))).toBeUndefined()
  })

  it('prefers Vercel over Cloudflare when both are present', () => {
    const geo = requestGeo(req({ 'x-vercel-ip-country': 'IN', 'cf-ipcountry': 'US' }))
    expect(geo).toEqual({ country: 'IN' })
  })

  it('does not attempt a lookup when no database is configured', () => {
    // The address is present and would resolve on the deployed host; with
    // GEOIP_DB_PATH empty it must be ignored rather than throwing.
    expect(requestGeo(req({ 'x-forwarded-for': '8.8.8.8' }))).toBeUndefined()
  })

  it('survives a database path that does not exist', () => {
    // A failed download must cost the map its dots and nothing else. If this
    // ever throws, every chat turn on the deployed site fails with it.
    process.env.GEOIP_DB_PATH = '/nonexistent/dbip-city-lite.mmdb'
    resetEnvCache()
    resetGeoReader()
    expect(requestGeo(req({ 'x-forwarded-for': '8.8.8.8' }))).toBeUndefined()
  })
})
