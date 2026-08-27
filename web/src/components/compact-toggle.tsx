import { ActionIcon, Tooltip } from '@mantine/core'
import { IconLayoutList, IconLayoutRows } from '@tabler/icons-react'
import { dashboard } from '../lib/dashboard-store'

/**
 * The toggle, drawn beside the theme switch because it belongs to the same family: a per-reader
 * display preference that changes nothing about what was measured.
 *
 * The icon names the state you get by pressing it, not the state you are in — the same convention
 * basalt's `ThemeToggle` uses — and the tooltip says it in words, because an icon pair whose
 * difference is line spacing is not self-evident either way round.
 *
 * **No `size`.** It rides `PageBar.actions` as a `kind: 'custom'` node, and the bar's own `CtlSlot`
 * resolves the `ctl` tier for every control in it (law C5) — the `size="lg"` this used to carry was
 * a 34px button in a 30px row.
 */
export function CompactToggle() {
  const [compact, setCompact] = dashboard.field.compact.use()
  const label = compact ? 'Show detail' : 'Compact — charts and findings only'

  return (
    <Tooltip label={label} events={{ hover: true, focus: true, touch: true }}>
      <ActionIcon
        variant="default"
        aria-label={label}
        aria-pressed={compact}
        onClick={() => setCompact(!compact)}
      >
        {compact ? <IconLayoutList size={18} /> : <IconLayoutRows size={18} />}
      </ActionIcon>
    </Tooltip>
  )
}
