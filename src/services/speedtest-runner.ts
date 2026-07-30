import { Cron } from 'croner'
import { db } from '../db/client.js'
import { config } from '../config.js'
import { runOoklaSpeedtest } from './ookla.js'

// Random per-firing offset so every deployment doesn't hit the top of the
// hour simultaneously (docs/DESIGN.md "Speed test: hourly").
const JITTER_MAX_MS = 5 * 60 * 1000

let running = false

async function runGuarded(): Promise<void> {
  if (running) {
    console.warn('[speedtest] skipped — a run is already in progress')
    return
  }
  running = true
  try {
    await runOoklaSpeedtest(db)
  } finally {
    running = false
  }
}

/** Starts the hourly (jittered) speed-test cron. Call once at boot. */
export function startSpeedtestScheduler(): Cron {
  return new Cron(config.speedtestCron, () => {
    const jitterMs = Math.floor(Math.random() * JITTER_MAX_MS)
    setTimeout(() => void runGuarded(), jitterMs)
  })
}

/**
 * Fires a speed test immediately, outside the schedule. Fire-and-forget: a
 * real run takes 10s–1min+ of network traffic, so the caller (the manual
 * trigger route) gets an immediate ack rather than blocking the HTTP
 * response on it. Returns false without starting anything if a run — cron or
 * manual — is already in progress.
 */
export function triggerSpeedtestNow(): boolean {
  if (running) return false
  void runGuarded()
  return true
}
