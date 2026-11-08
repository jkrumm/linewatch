import { useEffect, useState } from 'react'
import { PROBE_CYCLE_MS } from './range'

/**
 * Wall-clock `Date.now()` that re-renders its caller every `intervalMs` (one probe cycle by
 * default). Without a clock of its own the page only re-rendered when a query changed, and a failed
 * background refetch changes nothing — so with the API down an open tab kept computing ages from the
 * last render and kept saying "Up · just now".
 */
export function useNow(intervalMs: number = PROBE_CYCLE_MS): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
