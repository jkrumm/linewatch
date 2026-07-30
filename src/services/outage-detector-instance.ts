import { db } from '../db/client.js'
import { OutageDetector } from './outage-detector.js'

// One instance for the whole process — the ingest route is the only writer.
// Loaded eagerly so an in-flight outage survives a restart from the moment
// the first request lands (docs/DESIGN.md "outage").
export const outageDetector = new OutageDetector(db)
outageDetector.load()
