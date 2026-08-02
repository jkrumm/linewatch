import { Anchor, Box, Collapse, Flex, Group, Stack, Text, UnstyledButton } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { Callout } from 'basalt-ui/content'
import type { CalloutKind } from 'basalt-ui/content'
import { VX } from 'basalt-ui/charts'
import { SECTION_LABEL, VERDICT_SECTION, sectionAnchor } from '../lib/verdict-section'
import { groupVerdicts, triageVerdicts } from '../lib/verdict-group'
import type { VerdictGroup } from '../lib/verdict-group'
import type { Evidence, Severity, Verdict } from '../lib/types'
import { useCompactMode } from '../lib/compact'

/** `ok` maps to `good`, basalt's success kind. The other three are one-to-one. */
const CALLOUT_KIND: Record<Severity, CalloutKind> = {
  critical: 'bad',
  warn: 'warn',
  info: 'info',
  ok: 'good',
}

/** The accent a compact row carries in place of the callout's coloured frame. */
const SEVERITY_COLOR: Record<Severity, string> = {
  critical: VX.status.bad,
  warn: VX.status.warn,
  info: VX.status.neutral,
  ok: VX.status.good,
}

/**
 * The rule engine's conclusions, rendered at three sizes.
 *
 * **No sentence in this file is authored here.** Every reading comes from `GET /api/verdicts`
 * (`src/lib/verdict.ts`), which templates each conclusion from the numbers it queried and refuses
 * to emit one at all when its guards do not pass. A component that phrased its own summary would
 * be an inference with no evidence behind it, which is the thing the whole verdict layer exists to
 * replace.
 *
 * What this file decides is *size*, and it used to get that wrong in one specific way: it drew the
 * first three `info` groups as full cards — title, conclusion, a grid of evidence, a "Withheld:"
 * line and a "Next:" line each. But `info` is the severity a rule uses when it fired **correctly**.
 * `router_disabled` is correct configuration restated every window; `carrier_resync_dated` states a
 * real dated event and keeps stating it for as long as that event is inside the selected range, so
 * on a 30 d window a three-week-old resync is a permanent fixture. The result was a screenful of
 * unchanging prose above every chart, every day — and a band nobody reads is a band that cannot
 * deliver the one `critical` card it exists for.
 *
 * So: `critical` keeps the full card, `warn` becomes one line that expands to the full card,
 * `info`/`ok` go behind a single closed toggle that names its own count. The rule that an
 * actionable finding is never hidden behind a disclosure is unchanged — see `triageVerdicts`.
 */
export function VerdictPanel({ verdicts }: { verdicts: Verdict[] | undefined }) {
  const [compact] = useCompactMode()
  if (verdicts === undefined) {
    /**
     * A THIRD state, and it must not borrow either of the other two's words.
     *
     * The page used to render this component only once the query resolved, so the whole band —
     * one dim line at its shortest, several full Callouts at its longest — vanished and returned
     * on every query-key rotation, dragging every section under it up and back down, and resetting
     * the `useDisclosure` in every `VerdictRow` and in `RoutineGroups` so an expanded finding shut
     * itself.
     *
     * It renders always now, and "not asked yet" gets its own sentence. It cannot reuse the
     * no-verdicts one below: that sentence draws a real and load-bearing distinction — no rule
     * reached a conclusion is not a clean bill of health — and putting it over a window nobody has
     * queried asserts a measured-and-silent result that was never measured.
     */
    return (
      <Text size="xs" c="dimmed">
        Evaluating this window…
      </Text>
    )
  }

  if (verdicts.length === 0) {
    // One dim line, not a callout. The distinction it draws is real and worth keeping — no rule
    // fired is not the same fact as a healthy line, because a rule with absent inputs stays silent
    // rather than guessing — but it is a caveat, and a caveat drawn at the same size as a finding
    // is what made this band unreadable in the first place.
    return (
      <Text size="xs" c="dimmed">
        No rule reached a conclusion over this range. Not a clean bill of health — a rule whose
        inputs are missing stays silent rather than guessing.
      </Text>
    )
  }

  const { critical, warn, routine } = triageVerdicts(groupVerdicts(verdicts))

  return (
    <Stack gap="xs">
      {/* Keyed by `group.id`, not by position: a per-row rule emits one verdict per row it fired
          on, so `throughput_exceeds_link` can legitimately appear more than once in one list (see
          `deriveVerdicts`) — but `groupVerdicts` collapses every same-id run into a single group
          before this ever renders, so the id is unique again here. */}
      {critical.map((group) => (
        <VerdictCallout key={group.id} group={group} />
      ))}
      {warn.map((group) => (
        <VerdictRow key={group.id} group={group} />
      ))}
      {/* Critical and warn are drawn in every mode — a finding that asks for something is never
          behind a switch, which is this band's whole contract. The routine group is the one
          compact mode drops, and only because `triageVerdicts` routes a finding there precisely
          when it needs no action; the row it draws says exactly that. See `lib/compact.tsx`. */}
      {!compact && routine.length > 0 && <RoutineGroups groups={routine} />}
    </Stack>
  )
}

/**
 * `group.conclusion`, never `group.id`. The id is a rule name — `throughput_exceeds_link`,
 * `sub_cycle_path_stall` — and titling a finding with one makes the reader decode a slug before
 * they can find out whether anything is wrong. The API sends no separate headline field (see
 * `Verdict` in `lib/types.ts`), and the conclusion is templated server-side by the rule that knows
 * the numbers, for the same reason nothing else in this file is authored here — so it doubles as
 * the title. `VerdictBody` does not repeat it underneath: unlike `VerdictRow` below, nothing here
 * clips it, so there is nothing left over to show in full.
 */
function VerdictCallout({ group }: { group: VerdictGroup }) {
  return (
    <Callout kind={CALLOUT_KIND[group.severity]} title={group.conclusion}>
      <VerdictBody group={group} />
    </Callout>
  )
}

/**
 * A finding drawn as one line, expanding in place to the same body the full card shows.
 *
 * Used for every `warn` and for each routine finding once the disclosure is open. Collapsed it
 * carries the severity accent, the rule's conclusion, and the occurrence count — enough to decide
 * whether to open it, and nothing that needs reading twice. The collapsed line is `lineClamp={2}`:
 * at 1548px one line holds ~115 characters of a templated conclusion; at 338px — the one tier where
 * an actionable `warn` is allowed to be collapsed at all — it holds ~40, so a single-line clamp cut
 * a real finding to a sentence fragment (`The line lost 4.2% of packets on ever…`). Two lines,
 * unconditionally, is the cost of keeping the row decidable at every width: the row must carry
 * enough to decide whether to open it, and the expanded body re-renders the conclusion unclamped
 * anyway, so the cost is one row-height on a wide screen. That clamp is still lossy, so — unlike
 * `VerdictCallout`, whose title is never clamped and whose body therefore does not repeat it — the
 * expanded body here shows the conclusion again in full, unclamped, before the rest of
 * `VerdictBody`. Opening the row costs the reader no information, only a click.
 */
function VerdictRow({ group }: { group: VerdictGroup }) {
  const [opened, { toggle }] = useDisclosure(false)
  const Chevron = opened ? IconChevronDown : IconChevronRight

  return (
    <Box
      style={{
        borderRadius: VX.radiusCard,
        border: `1px solid ${VX.divider}`,
        borderInlineStartWidth: 3,
        borderInlineStartColor: SEVERITY_COLOR[group.severity],
        overflow: 'hidden',
      }}
    >
      <UnstyledButton onClick={toggle} aria-expanded={opened} w="100%" px="sm" py={8}>
        <Group gap="xs" wrap="nowrap" align="center">
          <Chevron size={14} color={VX.faint} aria-hidden="true" />
          <Text size="sm" lineClamp={2} style={{ flex: 1, minWidth: 0 }}>
            {group.conclusion}
          </Text>
          {/* The count is on the collapsed row on purpose: "×4" is the difference between one event
              and a pattern, and it is the one fact the reader cannot recover without opening. */}
          {group.instances.length > 1 && (
            <Text size="xs" c="dimmed" ff="monospace">
              ×{group.instances.length}
            </Text>
          )}
        </Group>
      </UnstyledButton>
      <Collapse expanded={opened}>
        <Box px="sm" pb="sm" pl={34}>
          <Stack gap={8}>
            {/* Unclamped, unlike the collapsed line above — see the comment on this component. */}
            <Text size="sm">{group.conclusion}</Text>
            <VerdictBody group={group} />
          </Stack>
        </Box>
      </Collapse>
    </Box>
  )
}

/** Everything under a finding's headline, identical whichever size it was reached at. The
 * conclusion itself is not repeated here — `VerdictCallout` puts it in the `Callout`'s `title`
 * and `VerdictRow` renders it separately above this (see that component's doc comment) — so this
 * body starts at the evidence. */
function VerdictBody({ group }: { group: VerdictGroup }) {
  return (
    <Stack gap={8}>
      <EvidenceList evidence={group.evidence} />
      {/*
        `uncertainty` is the sentence saying why a cause was withheld — typically that link
        coverage could not rule out a host-side transition. Dropping it turns a deliberate refusal
        into apparent silence, and a conclusion read without its caveat is an inference presented
        as a measurement. It sits above `action` because the action usually follows from it.
      */}
      {group.uncertainty !== null && (
        <Text size="sm" fs="italic">
          Withheld: {group.uncertainty}
        </Text>
      )}
      {group.action !== null && (
        <Text size="sm" c="dimmed">
          Next: {group.action}
        </Text>
      )}
      <OtherOccurrences group={group} />
      <EvidenceLink id={group.id} />
    </Stack>
  )
}

/**
 * Where on the page the numbers behind this finding are drawn.
 *
 * The sections used to be tabs, and this map used to drive a dot on the closed ones — a mark saying
 * "there is something in here" without saying what. Now that every section is on the page at once
 * the mark is unnecessary and the *link* is the useful half: a finding that cites `Coverage 41%`
 * should be one click from the chart that shows the gap, not four sections of scrolling away.
 *
 * A rule no section claims renders no link rather than a broken one. The page says so separately,
 * loudly, once — see `unmappedVerdictIds`; it is a defect in the dashboard, not a finding about the
 * line, and it must not be reported inside a finding as though it were.
 */
function EvidenceLink({ id }: { id: string }) {
  const section = VERDICT_SECTION[id]
  if (section === undefined) return null
  return (
    <Anchor href={`#${sectionAnchor(section)}`} size="xs">
      See the {SECTION_LABEL[section]} section ↓
    </Anchor>
  )
}

/**
 * The line that replaces three near-identical cards with one: named occurrences, not a sentence
 * about them. Renders nothing for a group of 1 — that group must be indistinguishable in render
 * from an ungrouped verdict.
 *
 * Only a count label and the other instances' own `conclusion` strings are shown. No connective
 * prose beyond the label: this layer selects, it does not write a new sentence describing the
 * repetition.
 */
function OtherOccurrences({ group }: { group: VerdictGroup }) {
  if (group.instances.length <= 1) return null

  // The representative is whichever instance supplied `group.conclusion`/etc — the first one at
  // the group's (worst) severity. Everything else in `instances` is an "other occurrence".
  const representativeIndex = group.instances.findIndex((instance) => instance.severity === group.severity)
  const others = group.instances.filter((_, index) => index !== representativeIndex)

  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        +{others.length} more occurrence{others.length === 1 ? '' : 's'} of this finding:
      </Text>
      {others.map((instance, index) => (
        <Text key={`${group.id}-other-${index}`} size="xs" c="dimmed" pl="sm">
          {instance.conclusion}
        </Text>
      ))}
    </Stack>
  )
}

/**
 * Every `info`/`ok` finding, behind one closed toggle.
 *
 * Closed by default and holding *all* of them, not a tail beyond some budget — see
 * `triageVerdicts` for why an eagerly-rendered informational finding is what killed this band's
 * readership. The toggle names the exact count so nothing reads as simply gone, and each finding
 * inside opens to the same body a callout would show. Nothing here is `critical`/`warn`;
 * `triageVerdicts` cannot put those in this tier.
 */
function RoutineGroups({ groups }: { groups: VerdictGroup[] }) {
  const [opened, { toggle }] = useDisclosure(false)
  const Chevron = opened ? IconChevronDown : IconChevronRight

  return (
    <Stack gap="xs">
      <UnstyledButton onClick={toggle} aria-expanded={opened}>
        <Group gap={6} wrap="nowrap">
          <Chevron size={14} color={VX.faint} aria-hidden="true" />
          <Text size="xs" c="dimmed">
            {groups.length} routine finding{groups.length === 1 ? '' : 's'} — nothing to act on
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={opened}>
        <Stack gap="xs">
          {groups.map((group) => (
            <VerdictRow key={group.id} group={group} />
          ))}
        </Stack>
      </Collapse>
    </Stack>
  )
}

/** `evidence` is non-empty by construction server-side — a verdict that cannot cite its numbers
 * cannot be built — so this renders unconditionally rather than guarding on length. */
function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  // A wrapping `Group`, not an inline `display: grid` with an auto-fit template. The grid gave each
  // item a 180px column, which on a long evidence set left a ragged half-empty last row and on a
  // narrow viewport forced a single column of very short strings. Evidence items are `label: value`
  // pairs of wildly different widths — they read better packed than aligned, and packing is what a
  // wrapping flex row does natively.
  return (
    <Flex wrap="wrap" columnGap="xs" rowGap={2}>
      {evidence.map((item) => (
        <Text key={item.label} size="xs" c="dimmed">
          {item.label}:{' '}
          <Text span ff="monospace" size="xs">
            {item.value}
          </Text>
        </Text>
      ))}
    </Flex>
  )
}
