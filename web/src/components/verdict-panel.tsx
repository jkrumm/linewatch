import { SimpleGrid, Stack, Text } from '@mantine/core'
import { Callout } from 'basalt-ui/content'
import type { CalloutKind } from 'basalt-ui/content'
import type { Evidence, Severity, Verdict } from '../lib/types'

/** `ok` maps to `good`, basalt's success kind. The other three are one-to-one. */
const CALLOUT_KIND: Record<Severity, CalloutKind> = {
  critical: 'bad',
  warn: 'warn',
  info: 'info',
  ok: 'good',
}

/**
 * The rule engine's conclusions, rendered.
 *
 * **No sentence in this file is authored here.** Every reading comes from `GET /api/verdicts`
 * (`src/lib/verdict.ts`), which templates each conclusion from the numbers it queried and refuses
 * to emit one at all when its guards do not pass. A component that phrased its own summary would
 * be an inference with no evidence behind it, which is the thing the whole verdict layer exists to
 * replace.
 *
 * The panel's only judgment is what to do with `uncertainty`, and the answer is: always show it.
 */
export function VerdictPanel({ verdicts }: { verdicts: Verdict[] }) {
  if (verdicts.length === 0) {
    // Deliberately `info`, not `good`. An empty catalogue result and a healthy line are different
    // facts: no rule fired, which includes every rule that fell silent because its inputs were
    // missing. A green "all clear" here would manufacture the reassurance the rules withheld.
    return (
      <Callout kind="info" title="No verdicts for this window">
        No rule produced a conclusion over this range. That is not a clean bill of health — a rule
        with absent inputs stays silent rather than guessing.
      </Callout>
    )
  }

  return (
    <Stack gap="sm">
      {/* Keyed by position, not by `id`: a per-row rule emits one verdict per row it fired on, so
          `throughput_exceeds_link` legitimately appears twice in one list (see `deriveVerdicts`).
          Keying on the id collides there, and React reconciles two verdicts about two different
          speed tests as one — the second one's numbers can be dropped on a refetch. The list is
          server-ordered and rebuilt whole on every fetch, so the index is stable within a render. */}
      {verdicts.map((verdict, index) => (
        <VerdictCallout key={`${verdict.id}-${index}`} verdict={verdict} />
      ))}
    </Stack>
  )
}

function VerdictCallout({ verdict }: { verdict: Verdict }) {
  return (
    <Callout kind={CALLOUT_KIND[verdict.severity]} title={verdict.id}>
      <Stack gap={8}>
        <Text size="sm">{verdict.conclusion}</Text>
        <EvidenceList evidence={verdict.evidence} />
        {/*
          `uncertainty` is the sentence saying why a cause was withheld — typically that link
          coverage could not rule out a host-side transition. Dropping it turns a deliberate refusal
          into apparent silence, and a conclusion read without its caveat is an inference presented
          as a measurement. It sits above `action` because the action usually follows from it.
        */}
        {verdict.uncertainty !== null && (
          <Text size="sm" fs="italic">
            Withheld: {verdict.uncertainty}
          </Text>
        )}
        {verdict.action !== null && (
          <Text size="sm" c="dimmed">
            Next: {verdict.action}
          </Text>
        )}
      </Stack>
    </Callout>
  )
}

/** `evidence` is non-empty by construction server-side — a verdict that cannot cite its numbers
 * cannot be built — so this renders unconditionally rather than guarding on length. */
function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="xs" verticalSpacing={2}>
      {evidence.map((item) => (
        <Text key={item.label} size="xs" c="dimmed">
          {item.label}:{' '}
          <Text span ff="monospace" size="xs">
            {item.value}
          </Text>
        </Text>
      ))}
    </SimpleGrid>
  )
}
