import type { ChartTooltipRow } from 'basalt-ui/charts'
import { VX } from 'basalt-ui/tokens'

/**
 * What "not measured" is painted in on every band chart, chosen to differ from EVERY measured
 * state's colour.
 *
 * basalt-ui 2.8.0 dropped the hatch ("absent-state paint is a flat fill") and 2.9.0 states the
 * condition this constant exists to meet: the absent colour must differ from every measured
 * state's colour, not only by alpha. Clean is `VX.neutral` and loss/down are `VX.badSolid`, and
 * `neutral` is a grey — so a grey absent colour (`VX.faint`, `VX.muted`, the same token at another
 * alpha) would tell "nothing was recorded" from "recorded, no loss" by opacity alone, the exact
 * pair a strip must never let a reader confuse. The accent is the one chromatic hue on the page
 * that no measured state uses. Each strip's test pins the inequality for its own states.
 */
export const ABSENT_COLOR = VX.accent
/** One strength for both strips, so their "not measured" reads as one colour. */
export const ABSENT_ALPHA = 0.45

/**
 * The fold basis row, named whenever more than one source bucket stands behind a drawn band. A
 * genuinely partial fold gets its own clause: the band already paints the absent share, and the
 * tooltip has to say the same thing in words for a reader who cannot judge a few px of colour by
 * eye. Empty for an unfolded band.
 */
export function foldedFromRows(foldedFrom: number, unmeasuredMembers: number): ChartTooltipRow[] {
  if (foldedFrom <= 1) return []
  const partial = unmeasuredMembers > 0 && unmeasuredMembers < foldedFrom
  return [
    {
      label: 'Folded from',
      value: partial
        ? `${foldedFrom} buckets, ${unmeasuredMembers} not measured`
        : `${foldedFrom} buckets`,
      color: VX.neutral,
    },
  ]
}
