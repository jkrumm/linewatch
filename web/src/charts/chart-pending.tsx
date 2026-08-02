import { VX } from 'basalt-ui/charts'

/**
 * The third state a windowed chart can be in — not "measured, nothing was there," which is what
 * feeding an unresolved query's `buckets ?? []` default straight to a chart used to draw.
 *
 * `densifyBuckets`/`throughputPoints` fill every slot in the requested window with `null` the
 * moment they are called, whether or not the request behind `buckets` has even landed — so an
 * ungated chart painted a fully-hatched "measured, and nothing was there" band on every cold load
 * and every range change, which is the exact shape the FOUNDING RULE forbids (an absent
 * measurement must never render as a present one). This renders in its place: same footprint as
 * the chart it stands in for (`height` matches the caller's own computed height, so nothing jumps
 * once the query resolves), and it claims nothing about the window — only that nobody has asked
 * about it yet.
 *
 * Mantine-free like the rest of `charts/` (`basalt/visx-boundary`) — a plain `<div>` with a `VX.*`
 * token is what that boundary allows here, the same escape hatch the hatch pattern and the other
 * absent-state markup in this directory already use. The theme guard's `raw-html-layout` normally
 * wants a Mantine `Flex`/`Group` for a centred row instead of an inline `display: flex` — the
 * guard's own escape hatch, `theme-allow`, is the correct answer here rather than a workaround: the
 * one Mantine layout primitive it wants is exactly what this Mantine-free directory cannot import.
 */
export function ChartPending({ height }: { height: number }) {
  return (
    <div
      style={{
        height,
        display: 'flex', // theme-allow: charts/ is Mantine-free, so Flex/Group is unavailable — same
        // exception basalt-ui's own Donut takes for its center-hole label.
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span style={{ color: VX.faint, fontSize: VX.text.sm }}>Waiting for this window’s data…</span>
    </div>
  )
}
