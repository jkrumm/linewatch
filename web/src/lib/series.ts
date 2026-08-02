import { defineSeries, groupTokens } from 'basalt-ui/tokens'

/**
 * The app's series dictionary — one entry, and the reason it exists is measurable.
 *
 * linewatch registered none for most of its life, and `DESIGN.md` called that "empty, and correct":
 * every mark is a single-series metric drawn neutral, the one earned accent, or a status verdict.
 * The throughput chart broke that. It draws THREE things that must be told apart by colour —
 * download, upload, and never-measured — and the palette has only two values that far apart. The
 * first attempt spent `VX.status.bad` on upload, so every bar of ordinary outbound traffic read as
 * a fault. The second moved it to `VX.line`, which fixed the false alarm and left two real
 * problems, both of them numbers rather than opinions (dark scheme, against `--vx-surface-panel`
 * `#2b2b2e`):
 *
 * | Token | Hex | Contrast |
 * |-|-|-|
 * | `--vx-accent` (download) | `#a2c3f0` | 7.8:1 |
 * | `--vx-line` (upload) | `#e4e4e7` | 11.1:1 |
 * | `--vx-neutral` (not measured) | `#d4d4d8` | 9.6:1 |
 *
 * Near-white is the loudest thing available on a dark panel, so as a dense mass of bars the
 * NEUTRAL series out-shouted the earned accent — and upload sat 6% in luminance from
 * never-measured, i.e. two of the three legend swatches were one grey. (It works on `speed-chart`
 * because there `VX.line` is a 1px line, not a fill.) That is categorical separation going unmet,
 * which is exactly the case `defineSeries` is reserved for.
 *
 * **Only `upload` is registered, not the pair.** Download is already the accent by decision, stated
 * in `DESIGN.md` ("spent on the internet band and the download line"). Giving it a second home here
 * would put one colour in two places for the two to drift apart in. So the pair is
 * `VX.accent` + `series.upload`, and only the half that had nowhere to live gets a row.
 *
 * **The hue is basalt's teal family, and the shortlist it won was two long.** Warm hues are out —
 * amber, orange and rose all mean something on this page, and a series that borrows a status hue is
 * the bug this row exists to fix. Another blue is out: it would sit in the accent's own family and
 * fail to separate from it at 1px, which is half the problem. That leaves violet and teal, and teal
 * is the one that is here. (Violet shipped first and was rejected on taste — recorded because
 * "why not violet" is otherwise the obvious question this file cannot answer.)
 *
 * Teal is a distinct family from the forest green `VX.status.good` is drawn in — basalt's own rule
 * makes that split explicitly ("positive deltas use `color="green"` (forest green), not `teal`
 * (vivid turquoise)") — so a teal bar does not read as a verdict. One shade deeper on light and one
 * lighter on dark per the token rule: `#13c9ba` measures 6.8:1 against the dark panel, near enough
 * the accent's 7.8:1 that upload carries the same weight as download rather than more.
 *
 * Neither teal nor violet is an off-identity accent, despite both appearing in the guard's banned
 * list: that kind polices Mantine `color=` props, and the tokens rule routes categorical colour
 * through `defineSeries` precisely so it need not borrow one.
 */
const SERIES_MAP = defineSeries({
  upload: { light: '#007067', dark: '#13c9ba' },
})

/** `var(--vx-app-upload)` — read this in a chart, never the hex above. */
export const series = groupTokens('app', SERIES_MAP)

/**
 * Handed to `BasaltProvider`'s `paletteOptions.groups` in `main.tsx`.
 *
 * Keyed by CSS-var PREFIX (`'app-'`, with the trailing dash), which `groupTokens('app', …)` above
 * assumes. Drift between the two emits token refs pointing at variables the palette stylesheet
 * never declares — no tsc error, a silently unstyled chart at runtime.
 */
export const paletteGroups = { 'app-': SERIES_MAP }
