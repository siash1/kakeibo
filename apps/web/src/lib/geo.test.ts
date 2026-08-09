import { describe, expect, it } from 'vitest'
import { requestGeo } from './geo'

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/chat', { headers })
}

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

  it('returns nothing at all when the headers are absent', () => {
    // Local development, and any request whose address the edge could not
    // resolve. The columns are nullable for exactly this case.
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
})
