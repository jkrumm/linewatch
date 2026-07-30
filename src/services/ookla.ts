import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { speedTest } from '../db/schema.js'
import type * as schema from '../db/schema.js'

/**
 * Ookla speedtest CLI JSON shape (`speedtest --format=json --accept-license
 * --accept-gdpr`). Fields not confirmed against a live run of the CLI
 * (`bytes` under download/upload) are read defensively with `?.` so an
 * unexpected shape degrades to a null column rather than throwing.
 */
interface OoklaResult {
  ping: { latency: number; jitter: number }
  download: { bandwidth: number; bytes?: number; latency: { iqm: number } }
  upload: { bandwidth: number; bytes?: number; latency: { iqm: number } }
  packetLoss?: number
  isp: string
  interface: { externalIp: string }
  server: { id: number | string; name: string; location: string }
  result: { url: string }
}

const BYTES_PER_SEC_TO_MBPS = 8 / 1e6

/**
 * Runs one Ookla speed test and records a `speed_test` row — on success or
 * failure alike (docs/DESIGN.md: "a failed speed test is data, not an
 * exception to swallow").
 */
export async function runOoklaSpeedtest(db: BunSQLiteDatabase<typeof schema>): Promise<void> {
  const startedAt = Date.now()

  try {
    const proc = Bun.spawn(['speedtest', '--format=json', '--accept-license', '--accept-gdpr'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `speedtest exited with code ${exitCode}`)
    }

    const parsed = JSON.parse(stdout) as OoklaResult

    db.insert(speedTest)
      .values({
        ts: startedAt,
        backend: 'ookla',
        ok: true,
        downloadMbps: parsed.download.bandwidth * BYTES_PER_SEC_TO_MBPS,
        uploadMbps: parsed.upload.bandwidth * BYTES_PER_SEC_TO_MBPS,
        pingMs: parsed.ping.latency,
        jitterMs: parsed.ping.jitter,
        latencyDownMs: parsed.download.latency.iqm,
        latencyUpMs: parsed.upload.latency.iqm,
        packetLoss: parsed.packetLoss ?? null,
        serverName: parsed.server.name,
        serverLocation: parsed.server.location,
        serverId: String(parsed.server.id),
        isp: parsed.isp,
        externalIp: parsed.interface.externalIp,
        bytesDown: parsed.download.bytes ?? null,
        bytesUp: parsed.upload.bytes ?? null,
        resultUrl: parsed.result.url,
        durationS: (Date.now() - startedAt) / 1000,
        error: null,
      })
      .run()
  } catch (err) {
    db.insert(speedTest)
      .values({
        ts: startedAt,
        backend: 'ookla',
        ok: false,
        durationS: (Date.now() - startedAt) / 1000,
        error: err instanceof Error ? err.message : String(err),
      })
      .run()
  }
}
