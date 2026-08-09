import type { RunGeo } from '@kakeibo/core/trace'

/**
 * The visitor's approximate location, from the request itself.
 *
 * This is not the browser Geolocation API and never prompts: that prompt
 * exists for precise device location, which this deliberately is not. Vercel
 * resolves the address at the edge and hands over a city — a neighbourhood, not
 * an address — and the raw address is read, coarsened and discarded inside this
 * function. Nothing downstream ever sees it.
 *
 * Returns undefined rather than an object of nulls when there is nothing to
 * read, so a caller cannot accidentally store a row of blanks that looks like a
 * failed lookup instead of an absent one.
 */
export function requestGeo(request: Request): RunGeo | undefined {
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

  return Object.keys(geo).length > 0 ? geo : undefined
}
