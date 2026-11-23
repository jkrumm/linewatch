import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTestDb } from '../db/test-db.js'
import {
  event,
  exportCursor,
  outage,
  probeCycle,
  probeSample,
  routerLineSample,
  routerWanSample,
  speedTest,
} from '../db/schema.js'
import { Exporter } from './exporter.js'
import { encodeLogs, encodeMetrics } from './otlp.js'
import type { Batch, Sink } from './otlp.js'
import type { MapContext } from './streams.js'

const ctx: MapContext = {
  scopeOf: (target) => (target === 'gateway' ? 'gateway' : target === 'mystery' ? null : 'wan'),
}

class RecordingSink implements Sink {
  batches: Batch[] = []
  failNext = 0
  async send(batch: Batch): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1
      throw new Error('agent down')
    }
    this.batches.push(batch)
  }
  get points() {
    return this.batches.flatMap((batch) => batch.points)
  }
  get logs() {
    return this.batches.flatMap((batch) => batch.logs)
  }
}

const T0 = 1_794_000_000_000

function sample(
  ts: number,
  target: string,
  overrides: Partial<typeof probeSample.$inferInsert> = {},
) {
  return {
    ts,
    target,
    addr: '203.0.113.1',
    sent: 20,
    received: 20,
    lossPct: 0,
    minMs: 4,
    medMs: 5,
    maxMs: 9,
    avgMs: 5.5,
    jitterMs: 0.7,
    ...overrides,
  }
}

function setup() {
  const db = createTestDb()
  const sink = new RecordingSink()
  const exporter = new Exporter(db, sink, ctx, 2)
  return { db, sink, exporter }
}

describe('OTLP encoding', () => {
  test('keeps the row timestamp as exact nanoseconds and the unit as metric metadata', () => {
    const body = encodeMetrics({ 'service.name': 'linewatch-app' }, [
      {
        name: 'line.probe.loss',
        unit: '%',
        tsMs: T0 + 123,
        value: 5,
        attrs: { target: 'gateway' },
      },
    ])
    const metric = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]
    expect(metric?.name).toBe('line.probe.loss')
    expect(metric?.unit).toBe('%')
    expect(metric?.gauge.dataPoints[0]).toMatchObject({
      timeUnixNano: String((T0 + 123) * 1_000_000),
      asDouble: 5,
      attributes: [{ key: 'target', value: { stringValue: 'gateway' } }],
    })
  })

  test('null and undefined attributes are absent, booleans and integers keep their type', () => {
    const body = encodeMetrics({}, [
      {
        name: 'm',
        unit: '1',
        tsMs: T0,
        value: 1,
        attrs: { a: null, b: undefined, home: false, mbit: 1000 },
      },
    ])
    const attributes = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.gauge.dataPoints[0]
    expect(attributes).toMatchObject({
      attributes: [
        { key: 'home', value: { boolValue: false } },
        { key: 'mbit', value: { intValue: '1000' } },
      ],
    })
  })

  test('a log record carries its event name as body and attribute', () => {
    const body = encodeLogs({}, [
      { name: 'line.outage.opened', tsMs: T0, severity: 'WARN', attrs: { scope: 'wan' } },
    ])
    const record = body.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]
    expect(record?.body).toEqual({ stringValue: 'line.outage.opened' })
    expect(record?.timeUnixNano).toBe(String(T0 * 1_000_000))
    expect(record?.attributes).toContainEqual({
      key: 'event.name',
      value: { stringValue: 'line.outage.opened' },
    })
  })
})

describe('the live tail', () => {
  test('starts at what is recorded and exports only what arrives afterwards', async () => {
    const { db, sink, exporter } = setup()
    db.insert(probeSample).values(sample(T0, 'gateway')).run()
    exporter.ensureCursors()
    expect(await exporter.tick()).toBe(0)

    db.insert(probeSample)
      .values(sample(T0 + 30_000, 'gateway'))
      .run()
    expect(await exporter.tick()).toBe(1)
    expect(sink.points.every((point) => point.tsMs === T0 + 30_000)).toBe(true)
    expect(await exporter.tick()).toBe(0)
  })

  test('a probe row is eight gauges at its own timestamp with the cycle path attributes', async () => {
    const { db, sink, exporter } = setup()
    exporter.ensureCursors()
    db.insert(probeCycle)
      .values({ ts: T0, pathClass: 'ethernet', onHomeLine: 1, linkMbit: 1000 })
      .run()
    db.insert(probeSample)
      .values(sample(T0, 'cloudflare', { lossPct: 5, received: 19 }))
      .run()
    await exporter.tick()

    expect(sink.points.map((point) => point.name).sort()).toEqual([
      'line.probe.jitter',
      'line.probe.loss',
      'line.probe.received',
      'line.probe.rtt.avg',
      'line.probe.rtt.max',
      'line.probe.rtt.median',
      'line.probe.rtt.min',
      'line.probe.sent',
    ])
    const loss = sink.points.find((point) => point.name === 'line.probe.loss')
    expect(loss).toMatchObject({
      value: 5,
      tsMs: T0,
      attrs: {
        target: 'cloudflare',
        scope: 'wan',
        path_class: 'ethernet',
        on_home_line: true,
        link_mbit: 1000,
      },
    })
  })

  test('an unknown vantage stays unknown, and a 100% loss row emits no round-trip gauges', async () => {
    const { db, sink, exporter } = setup()
    exporter.ensureCursors()
    db.insert(probeCycle).values({ ts: T0, pathClass: 'wifi', onHomeLine: null }).run()
    db.insert(probeSample)
      .values(
        sample(T0, 'mystery', {
          received: 0,
          lossPct: 100,
          minMs: null,
          medMs: null,
          maxMs: null,
          avgMs: null,
          jitterMs: null,
        }),
      )
      .run()
    await exporter.tick()

    const names = sink.points.map((point) => point.name).sort()
    expect(names).toEqual(['line.probe.loss', 'line.probe.received', 'line.probe.sent'])
    const attrs = sink.points[0]?.attrs
    expect(attrs?.['on_home_line']).toBeNull()
    expect(attrs?.['scope']).toBeNull()
    expect(attrs?.['link_mbit']).toBeNull()
  })

  test('a refused batch leaves the cursor in place and the rows go out on the next tick', async () => {
    const { db, sink, exporter } = setup()
    exporter.ensureCursors()
    db.insert(probeSample).values(sample(T0, 'gateway')).run()

    sink.failNext = 1
    await expect(exporter.tick()).rejects.toThrow('agent down')
    expect(sink.batches).toHaveLength(0)

    expect(await exporter.tick()).toBe(1)
    expect(sink.points.length).toBeGreaterThan(0)
  })

  test('catches up a backlog larger than one batch, in order', async () => {
    const { db, sink, exporter } = setup()
    exporter.ensureCursors()
    for (let i = 0; i < 5; i += 1)
      db.insert(probeSample)
        .values(sample(T0 + i * 30_000, 'gateway'))
        .run()

    expect(await exporter.tick()).toBe(5)
    const stamps = sink.points
      .filter((point) => point.name === 'line.probe.sent')
      .map((p) => p.tsMs)
    expect(stamps).toEqual([0, 1, 2, 3, 4].map((i) => T0 + i * 30_000))
  })

  test('router line, WAN session, speed test and failed speed test', async () => {
    const { db, sink, exporter } = setup()
    exporter.ensureCursors()
    db.insert(routerLineSample)
      .values({
        ts: T0,
        carrier: 'gfast',
        status: 'Up',
        downSyncKbps: 100_000,
        upSyncKbps: 50_000,
        downCurrKbps: 90_000,
        upCurrKbps: 40_000,
        downNoiseMarginDb: 6.1,
        upNoiseMarginDb: null,
        downAttenuationDb: 12.5,
        showtimeStartS: 3600,
        erroredSecs: 2,
        severelyErroredSecs: 0,
      })
      .run()
    db.insert(routerWanSample)
      .values({
        ts: T0,
        connStatusV4: 'Connecting',
        connStatusV6: 'Connected',
        uptimeV4S: 0,
        uptimeV6S: 777,
      })
      .run()
    db.insert(speedTest)
      .values({
        ts: T0,
        backend: 'ookla',
        ok: true,
        downloadMbps: 94,
        uploadMbps: 40,
        pingMs: 5,
        latencyDownMs: 20,
      })
      .run()
    db.insert(speedTest)
      .values({ ts: T0 + 1, backend: 'ookla', ok: false, error: 'timeout' })
      .run()
    await exporter.tick()

    const byName = (name: string) => sink.points.filter((point) => point.name === name)
    expect(byName('line.router.sync_rate').map((p) => [p.attrs['direction'], p.value])).toEqual([
      ['down', 100_000],
      ['up', 50_000],
    ])
    // The row has no up margin: one point, not a zero.
    expect(byName('line.router.noise_margin')).toHaveLength(1)
    expect(byName('line.router.showtime')[0]?.value).toBe(3600)
    expect(byName('line.wan.connected').map((p) => [p.attrs['ip_version'], p.value])).toEqual([
      ['v4', 0],
      ['v6', 1],
    ])
    expect(
      byName('line.wan.session_uptime').find((p) => p.attrs['ip_version'] === 'v6')?.value,
    ).toBe(777)
    expect(byName('line.speedtest.download')[0]?.value).toBe(94)
    expect(byName('line.speedtest.loaded_latency')).toHaveLength(1)
    expect(sink.logs.map((log) => log.name)).toEqual(['line.speedtest.failed'])
  })

  test('an outage is a log at open, a log and a duration gauge at close — exported once each', async () => {
    const { db, sink, exporter } = setup()
    exporter.ensureCursors()
    const row = db
      .insert(outage)
      .values({ scope: 'wan', startedAt: T0, evidence: '["cloudflare"]' })
      .returning({ id: outage.id })
      .get()
    await exporter.tick()
    expect(sink.logs.map((log) => log.name)).toEqual(['line.outage.opened'])
    expect(sink.logs[0]?.tsMs).toBe(T0)

    db.update(outage)
      .set({ endedAt: T0 + 90_000, durationS: 90 })
      .run()
    await exporter.tick()
    await exporter.tick()

    expect(row.id).toBeGreaterThan(0)
    expect(sink.logs.map((log) => log.name)).toEqual(['line.outage.opened', 'line.outage.closed'])
    expect(sink.logs[1]?.tsMs).toBe(T0 + 90_000)
    const duration = sink.points.filter((point) => point.name === 'line.outage.duration')
    expect(duration).toEqual([
      expect.objectContaining({ value: 90, tsMs: T0 + 90_000, attrs: { scope: 'wan' } }),
    ])
  })

  test('only interventions leave the event table, with the evidence as attributes', async () => {
    const { db, sink, exporter } = setup()
    exporter.ensureCursors()
    db.insert(event).values({ ts: T0, kind: 'note', detail: '{"source":"x"}' }).run()
    db.insert(event)
      .values({
        ts: T0 + 5,
        kind: 'intervention',
        detail: JSON.stringify({
          source: 'watchdog',
          action: 'router_reconnect',
          outcome: 'executed',
        }),
      })
      .run()
    await exporter.tick()

    expect(sink.logs).toHaveLength(1)
    expect(sink.logs[0]).toMatchObject({
      name: 'line.intervention',
      tsMs: T0 + 5,
      attrs: { source: 'watchdog', action: 'router_reconnect', outcome: 'executed' },
    })
  })
})

describe('the watchdog outage summary', () => {
  test('is the one note that leaves the event table, as a log and a duration gauge', async () => {
    const { db, sink, exporter } = setup()
    exporter.ensureCursors()
    db.insert(event)
      .values({
        ts: T0,
        kind: 'note',
        detail: JSON.stringify({ source: 'watchdog', action: 'watchdog_blocked' }),
      })
      .run()
    db.insert(event)
      .values({
        ts: T0 + 10,
        kind: 'note',
        detail: JSON.stringify({
          source: 'watchdog',
          action: 'watchdog_outage_summary',
          outageClass: 'full_wan_down',
          endedBy: 'external',
          durationS: 1962,
          t0: T0 - 1_962_000,
          refused: 1,
          rungs: [{ rung: 'reconnect', ts: T0, atS: 192, outcome: 'refused' }],
        }),
      })
      .run()
    await exporter.tick()

    expect(sink.logs).toHaveLength(1)
    expect(sink.logs[0]).toMatchObject({
      name: 'line.watchdog.outage_summary',
      tsMs: T0 + 10,
      attrs: { outage_class: 'full_wan_down', ended_by: 'external', duration_s: 1962, refused: 1 },
    })
    expect(String(sink.logs[0]?.attrs['rungs'])).toContain('"outcome":"refused"')
    expect(sink.points).toEqual([
      expect.objectContaining({
        name: 'line.watchdog.outage.duration',
        value: 1962,
        attrs: { ended_by: 'external' },
      }),
    ])
  })
})

describe('the backfill', () => {
  test('replays exactly what the live tail did not, once, and is resumable', async () => {
    const { db, sink, exporter } = setup()
    for (let i = 0; i < 5; i += 1)
      db.insert(probeSample)
        .values(sample(T0 + i * 30_000, 'gateway'))
        .run()
    exporter.ensureCursors()
    // Rows that arrive after the first start belong to the live tail.
    db.insert(probeSample)
      .values(sample(T0 + 5 * 30_000, 'gateway'))
      .run()

    // Fail on the second batch: the first is accepted and remembered.
    let calls = 0
    const flaky: Sink = {
      send: async (batch) => {
        calls += 1
        if (calls === 2) throw new Error('agent down')
        await sink.send(batch)
      },
    }
    const first = new Exporter(db, flaky, ctx, 2)
    await expect(first.backfill({ delayMs: 0 })).rejects.toThrow('agent down')

    const reports = await exporter.backfill({ delayMs: 0 })
    expect(reports.find((r) => r.stream === 'probe')?.rows).toBe(3)

    await exporter.tick()
    const stamps = sink.points
      .filter((point) => point.name === 'line.probe.sent')
      .map((point) => point.tsMs)
      .sort((a, b) => a - b)
    expect(stamps).toEqual([0, 1, 2, 3, 4, 5].map((i) => T0 + i * 30_000))

    const done = db.select().from(exportCursor).all()
    expect(done.every((row) => row.backfilledAt !== null)).toBe(true)

    // A finished backfill sends nothing more.
    const again = await exporter.backfill({ delayMs: 0 })
    expect(again.every((report) => report.rows === 0)).toBe(true)
  })

  test('a closed outage that predates the first start is backfilled with both of its events', async () => {
    const { db, sink, exporter } = setup()
    db.insert(outage)
      .values({
        scope: 'gateway',
        startedAt: T0,
        endedAt: T0 + 60_000,
        durationS: 60,
        evidence: '[]',
      })
      .run()
    exporter.ensureCursors()
    await exporter.backfill({ delayMs: 0 })

    expect(sink.logs.map((log) => log.name).sort()).toEqual([
      'line.outage.closed',
      'line.outage.opened',
    ])
    await exporter.tick()
    expect(sink.logs).toHaveLength(2)
  })
})

describe('the export is off without an endpoint', () => {
  const realFetch = globalThis.fetch
  let calls = 0
  beforeAll(() => {
    globalThis.fetch = (() => {
      calls += 1
      return Promise.reject(new Error('no network in this test'))
    }) as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
  })

  test('startExport does nothing: no timer, no request, no cursor row', async () => {
    process.env['LINEWATCH_DB'] = ':memory:'
    process.env['LINEWATCH_TOKEN'] ??= 'test-token-not-the-real-one'
    delete process.env['LINEWATCH_OTLP_ENDPOINT']
    const { startExport } = await import('./index.js')
    const { db } = await import('../db/client.js')

    expect(startExport()).toBeNull()
    expect(db.select().from(exportCursor).all()).toHaveLength(0)
    expect(calls).toBe(0)
  })
})
