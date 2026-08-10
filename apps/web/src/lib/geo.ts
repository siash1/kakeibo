import { readFileSync } from 'node:fs'
import { env } from '@kakeibo/core/env'
import type { RunGeo } from '@kakeibo/core/trace'
import { type CityResponse, Reader } from 'maxmind'

/**
 * The visitor's approximate location, from the request itself.
 *
 * This is not the browser Geolocation API and never prompts: that prompt exists
 * for precise device location, which this deliberately is not. What is stored
 * is a city — a neighbourhood, not an address — and the raw address is read,
 * coarsened and discarded inside this function. Nothing downstream ever sees it.
 *
 * Three sources, in order of trust:
 *
 *  1. **Vercel's edge headers.** Resolved at the edge, and unspoofable: Vercel
 *     derives them from the connection's public IP and overwrites anything the
 *     client sent.
 *  2. **Cloudflare's headers**, for a deployment sitting behind it. The free
 *     plan gives country only, which is why the local lookup below still runs
 *     to fill in a city.
 *  3. **A local database.** On a self-hosted origin no edge exists, so the
 *     address is looked up against an MMDB file on disk.
 *
 * The third one is why this is not simply an HTTP call to an IP-geolocation
 * service. `/privacy` promises that nothing about a visitor is shared with
 * anyone but Google's Gemini API; posting every visitor's address to a
 * geolocation vendor would make that page a lie in exchange for a dot on an
 * operator-only map. The lookup happens in this process, against a file, and
 * the address never leaves the machine.
 *
 * Returns undefined rather than an object of nulls when there is nothing to
 * read, so a caller cannot accidentally store a row of blanks that looks like a
 * failed lookup instead of an absent one.
 */

export function requestGeo(request: Request): RunGeo | undefined {
  return fromEdgeHeaders(request) ?? fromLocalDatabase(request)
}

/** Vercel first, then Cloudflare. Both are set by infrastructure, not clients. */
function fromEdgeHeaders(request: Request): RunGeo | undefined {
  const header = (name: string): string | undefined => {
    const raw = request.headers.get(name)
    if (!raw) return undefined
    // Vercel percent-encodes these, so "São Paulo" arrives as
    // "S%C3%A3o%20Paulo" and would be stored mojibaked forever.
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }

  const number = (name: string): number | undefined => {
    const raw = header(name)
    if (raw === undefined) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  const geo: RunGeo = {
    ...(header('x-vercel-ip-country') ? { country: header('x-vercel-ip-country')! } : {}),
    ...(header('x-vercel-ip-country-region')
      ? { region: header('x-vercel-ip-country-region')! }
      : {}),
    ...(header('x-vercel-ip-city') ? { city: header('x-vercel-ip-city')! } : {}),
    ...(number('x-vercel-ip-latitude') !== undefined
      ? { lat: number('x-vercel-ip-latitude')! }
      : {}),
    ...(number('x-vercel-ip-longitude') !== undefined
      ? { lon: number('x-vercel-ip-longitude')! }
      : {}),
  }
  if (Object.keys(geo).length > 0) return geo

  // Cloudflare. `cf-ipcity` and the coordinates exist only on paid plans, so on
  // the free tier this yields a country and nothing else — which is still worth
  // having, and the map simply has no point to draw.
  const cf: RunGeo = {
    ...(header('cf-ipcountry') && header('cf-ipcountry') !== 'XX'
      ? { country: header('cf-ipcountry')! }
      : {}),
    ...(header('cf-region-code') ? { region: header('cf-region-code')! } : {}),
    ...(header('cf-ipcity') ? { city: header('cf-ipcity')! } : {}),
    ...(number('cf-iplatitude') !== undefined ? { lat: number('cf-iplatitude')! } : {}),
    ...(number('cf-iplongitude') !== undefined ? { lon: number('cf-iplongitude')! } : {}),
  }
  return Object.keys(cf).length > 0 ? cf : undefined
}

/**
 * The reader, opened once and held for the life of the process.
 *
 * `undefined` means "not tried yet", `null` means "tried and unavailable" —
 * without that distinction a missing file is re-read on every single request.
 * Synchronous on purpose: `requestGeo` is called inline while assembling the
 * agent's dependencies, and making it async would turn one file read at startup
 * into an await on the hot path of every turn.
 */
let reader: Reader<CityResponse> | null | undefined

function lookupReader(): Reader<CityResponse> | null {
  if (reader !== undefined) return reader
  const path = env().GEOIP_DB_PATH
  if (path === '') {
    reader = null
    return reader
  }
  try {
    reader = new Reader<CityResponse>(readFileSync(path))
  } catch {
    // A missing or corrupt database is not an error worth failing a turn over.
    // The map loses its dots; nothing else in the app reads these columns.
    reader = null
  }
  return reader
}

function fromLocalDatabase(request: Request): RunGeo | undefined {
  const db = lookupReader()
  if (!db) return undefined

  // Leftmost entry is the client; the rest are proxies. Safe to trust only
  // because the reverse proxy in front of this app overwrites the header rather
  // than appending to it — see the Caddyfile in docs/deploy-hetzner.md. A proxy
  // that appends would let a visitor pick their own dot on the map.
  const forwarded = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip')
  const address = forwarded?.split(',')[0]?.trim()
  if (!address) return undefined

  let found: CityResponse | null
  try {
    found = db.get(address)
  } catch {
    return undefined
  }
  if (!found) return undefined

  const city = found.city?.names?.en
  const country = found.country?.iso_code ?? found.registered_country?.iso_code
  const region = found.subdivisions?.[0]?.iso_code
  const lat = found.location?.latitude
  const lon = found.location?.longitude

  const geo: RunGeo = {
    ...(country ? { country } : {}),
    ...(region ? { region } : {}),
    ...(city ? { city } : {}),
    ...(typeof lat === 'number' ? { lat } : {}),
    ...(typeof lon === 'number' ? { lon } : {}),
  }
  return Object.keys(geo).length > 0 ? geo : undefined
}

/** Test seam: forget the memoised reader so a changed path takes effect. */
export function resetGeoReader(): void {
  reader = undefined
}
