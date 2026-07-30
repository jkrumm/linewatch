import { SegmentedControl } from '@mantine/core'
import { RANGE_LABEL, type RangeOption } from '../lib/range'

/** Generic over `T` so a route offering a narrower option set (e.g. Speed's `1h`-less range) gets
 * an `onChange` callback typed to that same narrower set, not the full `RangeOption` union. */
export function RangeSelector<T extends RangeOption>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly T[]
  onChange: (value: T) => void
}) {
  return (
    <SegmentedControl
      value={value}
      onChange={(next) => onChange(next as T)}
      data={options.map((opt) => ({ label: RANGE_LABEL[opt], value: opt }))}
    />
  )
}
