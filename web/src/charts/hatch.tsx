import { alpha } from 'basalt-ui/charts'

/**
 * A diagonal-hatch `<pattern>`, the dashboard's one visual vocabulary for **absence**.
 *
 * Absence needs a fill that cannot be confused with any intensity of a measured fill, because the
 * two states it separates — "nothing was measured here" and "everything measured here was fine" —
 * are the pair this dashboard is most dangerous when it blurs. A faint solid tint fails that: it
 * reads as a weak measurement. Hatching reads as "no data" at a glance and survives being placed
 * beside a colour ramp of the same hue.
 *
 * `id` must be unique per document; callers namespace it with their `chartId`.
 */
export function HatchPattern({
  id,
  color,
  opacity = 0.55,
  size = 6,
}: {
  id: string
  color: string
  /** Applied via `alpha()` on the stroke, never as an `opacity` attribute, so the hue keeps
   * resolving per colour scheme (the visx-charts palette rule). */
  opacity?: number
  size?: number
}) {
  return (
    <pattern
      id={id}
      width={size}
      height={size}
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(45)"
    >
      <line
        x1={0}
        y1={0}
        x2={0}
        y2={size}
        stroke={alpha(color, opacity)}
        strokeWidth={size / 3}
      />
    </pattern>
  )
}

export function hatchFill(id: string): string {
  return `url(#${id})`
}
