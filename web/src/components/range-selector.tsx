import { SegmentedControl } from '@mantine/core'
import { RANGE_LABEL, type RangeOption } from '../lib/range'

/** Generic over `T` so a route offering a narrower option set (e.g. Speed's `1h`-less range) gets
 * an `onChange` callback typed to that same narrower set, not the full `RangeOption` union. */
export function RangeSelector<T extends RangeOption>({
  value,
  options,
  onChange,
  fullWidth,
}: {
  value: T
  options: readonly T[]
  onChange: (value: T) => void
  /** Forwarded to `SegmentedControl`. Below `sm` the selector gets its own row and fills it: five
   * labels sharing 334px is ~66px each, far above the ellipsis threshold, where sharing a row with
   * the brand and the toggle it was ~19px each. Kept a plain passthrough so the generic `T` is
   * untouched. */
  fullWidth?: boolean
}) {
  return (
    <SegmentedControl
      value={value}
      onChange={(next) => onChange(next as T)}
      data={options.map((opt) => ({ label: RANGE_LABEL[opt], value: opt }))}
      fullWidth={fullWidth}
    />
  )
}
