/**
 * A hand-rolled OTLP/HTTP JSON encoder and sender. The wire format needed here is
 * two request bodies (gauges and log records), so this is smaller than pulling in
 * the OpenTelemetry SDK and its transitive tree, and it carries no global state.
 *
 * The receiver is the host's own collector on loopback, which owns the key,
 * `host.name` and the on-disk queue. This file never sees either.
 */

export type AttrValue = string | number | boolean
/** `null` and `undefined` drop the attribute: absent means unknown, never a default. */
export type Attrs = Record<string, AttrValue | null | undefined>

/** One gauge reading at the row's own instant, never the export instant. */
export interface Point {
  name: string
  /** UCUM-style unit, carried as OTLP metric metadata. */
  unit: string
  tsMs: number
  value: number
  attrs: Attrs
}

/** One log record: an event name, the evidence as attributes, at the row's own instant. */
export interface LogEvent {
  name: string
  tsMs: number
  severity: 'INFO' | 'WARN'
  attrs: Attrs
}

export interface Batch {
  points: Point[]
  logs: LogEvent[]
}

export interface Sink {
  /** Resolves once the agent has accepted the batch; rejects otherwise. */
  send(batch: Batch): Promise<void>
}

export type Resource = Record<string, string>

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }

interface KeyValue {
  key: string
  value: AnyValue
}

function anyValue(value: AttrValue): AnyValue {
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { boolValue: value }
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
}

function encodeAttrs(attrs: Attrs): KeyValue[] {
  const out: KeyValue[] = []
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    out.push({ key, value: anyValue(value) })
  }
  return out
}

/** OTLP/JSON carries 64-bit times as decimal strings; ms × 1e6 stays exact in BigInt. */
function nanos(tsMs: number): string {
  return (BigInt(Math.trunc(tsMs)) * 1_000_000n).toString()
}

const SCOPE = { name: 'linewatch' }

function resourceOf(resource: Resource) {
  return { attributes: encodeAttrs(resource) }
}

/** Points grouped per metric (name + unit), every point as a double gauge. */
export function encodeMetrics(resource: Resource, points: Point[]) {
  const byMetric = new Map<string, { name: string; unit: string; dataPoints: unknown[] }>()
  for (const point of points) {
    if (!Number.isFinite(point.value)) continue
    const key = `${point.name}\u0000${point.unit}`
    let metric = byMetric.get(key)
    if (!metric) {
      metric = { name: point.name, unit: point.unit, dataPoints: [] }
      byMetric.set(key, metric)
    }
    metric.dataPoints.push({
      timeUnixNano: nanos(point.tsMs),
      asDouble: point.value,
      attributes: encodeAttrs(point.attrs),
    })
  }
  return {
    resourceMetrics: [
      {
        resource: resourceOf(resource),
        scopeMetrics: [
          {
            scope: SCOPE,
            metrics: [...byMetric.values()].map((metric) => ({
              name: metric.name,
              unit: metric.unit,
              gauge: { dataPoints: metric.dataPoints },
            })),
          },
        ],
      },
    ],
  }
}

const SEVERITY = { INFO: 9, WARN: 13 } as const

export function encodeLogs(resource: Resource, logs: LogEvent[]) {
  return {
    resourceLogs: [
      {
        resource: resourceOf(resource),
        scopeLogs: [
          {
            scope: SCOPE,
            logRecords: logs.map((log) => ({
              timeUnixNano: nanos(log.tsMs),
              severityNumber: SEVERITY[log.severity],
              severityText: log.severity,
              body: { stringValue: log.name },
              attributes: encodeAttrs({ 'event.name': log.name, ...log.attrs }),
            })),
          },
        ],
      },
    ],
  }
}

/** Per request: a probe batch is ~4k points, which is ~1 MB of JSON. */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * POSTs to `<endpoint>/v1/metrics` and `<endpoint>/v1/logs`. A 2xx is acceptance:
 * from there the agent's disk queue owns the data. A `partialSuccess` with
 * rejections is counted and logged, not retried — the same bytes would be rejected
 * again, and holding the cursor back would stall every row behind it.
 */
export class OtlpHttpSink implements Sink {
  private readonly base: string
  rejected = 0

  constructor(
    endpoint: string,
    private readonly resource: Resource,
  ) {
    this.base = endpoint.replace(/\/+$/, '')
  }

  async send(batch: Batch): Promise<void> {
    if (batch.points.length > 0) {
      await this.post('/v1/metrics', encodeMetrics(this.resource, batch.points))
    }
    if (batch.logs.length > 0) {
      await this.post('/v1/logs', encodeLogs(this.resource, batch.logs))
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await fetch(this.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`${path} answered ${response.status}`)
    }
    const text = await response.text()
    if (text === '') return
    try {
      const partial = (JSON.parse(text) as { partialSuccess?: Record<string, unknown> })
        .partialSuccess
      const rejected = Number(
        partial?.['rejectedDataPoints'] ?? partial?.['rejectedLogRecords'] ?? 0,
      )
      if (rejected > 0) {
        this.rejected += rejected
        console.warn(
          `[otlp] ${path} rejected ${rejected} items: ${String(partial?.['errorMessage'] ?? '')}`,
        )
      }
    } catch {
      // A body that is not JSON on a 2xx is still an acceptance.
    }
  }
}
