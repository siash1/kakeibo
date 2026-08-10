import type { MapPoint } from '@kakeibo/ledger'
import { Card, EmptyState } from '@/components/ui'

/**
 * Visitor activity on an equirectangular projection (spec §9.5).
 *
 * Inline SVG: no tile provider, no map library, no API key and no external
 * request, which keeps this page dependency-free and consistent with its genre.
 *
 * There are deliberately no coastlines. An accurate world outline is a data
 * file, and drawing one from memory would be inventing geography. If one is
 * wanted, add a vetted public-domain simplified world path as an asset and
 * render it behind the graticule.
 */
export function WorldMap({ points }: { points: MapPoint[] }) {
  if (points.length === 0) {
    // Local development resolves no addresses at all, so this is the normal
    // state before deployment rather than an error. Card-wrapped like every
    // other panel, so a map with no points still has a border rather than
    // floating loose on the page.
    return (
      <Card className="p-4">
        <EmptyState
          title="No located visits yet."
          hint="Locations come from the edge; there are none locally."
        />
      </Card>
    )
  }

  const width = 720
  const height = 360
  const project = (lat: number, lon: number) => ({
    x: ((lon + 180) / 360) * width,
    y: ((90 - lat) / 180) * height,
  })
  const busiest = Math.max(...points.map((point) => point.runs))

  return (
    <Card className="overflow-hidden p-4">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Visitor map"
      >
        <title>Approximate visitor locations, city level</title>
        {[-60, -30, 0, 30, 60].map((lat) => (
          <line
            key={lat}
            x1={0}
            x2={width}
            y1={project(lat, 0).y}
            y2={project(lat, 0).y}
            className={lat === 0 ? 'stroke-ink-700' : 'stroke-ink-800'}
            strokeWidth="0.5"
          />
        ))}
        {[-120, -60, 0, 60, 120].map((lon) => (
          <line
            key={lon}
            y1={0}
            y2={height}
            x1={project(0, lon).x}
            x2={project(0, lon).x}
            className={lon === 0 ? 'stroke-ink-700' : 'stroke-ink-800'}
            strokeWidth="0.5"
          />
        ))}
        {points.map((point) => {
          const { x, y } = project(point.lat, point.lon)
          // Area proportional to activity, so a city with four times the turns
          // looks four times as big rather than sixteen.
          const r = 2 + Math.sqrt(point.runs / busiest) * 8
          return (
            <g key={`${point.lat},${point.lon}`}>
              <circle
                cx={x}
                cy={y}
                r={r}
                className="fill-accent/25 stroke-accent"
                strokeWidth="0.75"
              />
              <title>{`${point.city ?? 'unknown'}, ${point.country ?? '??'}: ${point.runs} turn(s)`}</title>
            </g>
          )
        })}
      </svg>
    </Card>
  )
}
