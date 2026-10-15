import { describe, expect, test } from 'bun:test'
import {
  AVAILABILITY_BUCKET_SECONDS,
  FULL_INTENSITY_LOSS_PCT,
  availabilityCells,
  cellRows,
} from './availability-heatmap'
import type { ProbeBucket } from '../lib/types'

const HOUR_MS = AVAILABILITY_BUCKET_SECONDS * 1000
const DAY_MS = 86_400_000
// Noon UTC on a fixed day, so a 48 h window spans 2-3 local days in any zone.
const FROM = Date.UTC(2026, 5, 10, 12)

const bucket = (bucketStart: number, over: Partial<ProbeBucket> = {}): ProbeBucket => ({
  bucket: bucketStart,
  target: 'cloudflare',
  medianMs: 12,
  p5Ms: 10,
  p95Ms: 14,
  minMs: 9,
  maxMs: 15,
  maxLossPct: 0,
  lossPct: 0,
  downCycles: 0,
  count: 120,
  ...over,
})

describe('availabilityCells', () => {
  test('one cell per hour of the WINDOW, whatever the response holds', () => {
    const { cells, rows } = availabilityCells([], FROM, FROM + 2 * DAY_MS - 1)
    expect(cells).toHaveLength(48)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(cells.every((c) => c.bucket === null)).toBe(true)
  })

  test('an hour nothing was recorded in is absent, a recorded one carries its bucket', () => {
    const { cells } = availabilityCells([bucket(FROM + 3 * HOUR_MS)], FROM, FROM + DAY_MS - 1)
    expect(cells.filter((c) => c.bucket !== null)).toHaveLength(1)
    expect(cells.filter((c) => c.bucket === null)).toHaveLength(23)
  })
})

describe('cellRows', () => {
  test('an absent cell says "Not measured" with the expected cycle count, never a clean reading', () => {
    const rows = cellRows({ row: 'r', col: '00', bucket: null }, 120)
    expect(rows).toEqual([
      expect.objectContaining({ label: 'Not measured', value: '0 of 120 expected cycles' }),
    ])
  })

  test('a measured cell reports the worst cycle, the down count and the coverage', () => {
    const rows = cellRows(
      { row: 'r', col: '00', bucket: bucket(0, { maxLossPct: 40, downCycles: 2, count: 118 }) },
      120,
    )
    expect(rows.map((r) => r.label)).toEqual(['Worst cycle', 'Cycles fully down', 'Measured'])
    expect(rows[2]?.value).toBe('118 of 120 expected cycles')
  })
})

test('the ramp is absolute: full colour is a fixed loss share, not the data max', () => {
  expect(FULL_INTENSITY_LOSS_PCT).toBe(5)
})
