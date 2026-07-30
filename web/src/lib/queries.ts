import { queryOptions } from '@tanstack/react-query'
import { getOutages, getProbeBuckets, getSpeedSummary, getSpeedTests, getStatus } from './api'
import type { ProbeBucketSeconds, TargetName } from './types'

/** `staleTime` matches the collector's 30s probe cycle (DESIGN.md "Cadence") — no point polling
 * faster than new data can exist. */
export const statusQuery = () =>
  queryOptions({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

export const probeBucketsQuery = (params: {
  from: number
  to: number
  target: TargetName
  bucket: ProbeBucketSeconds
}) =>
  queryOptions({
    queryKey: ['probes', params.target, params.bucket, params.from, params.to],
    queryFn: () => getProbeBuckets(params),
    staleTime: 60_000,
  })

export const outagesQuery = (params: { from: number; to: number; minDuration?: number }) =>
  queryOptions({
    queryKey: ['outages', params.from, params.to, params.minDuration ?? 0],
    queryFn: () => getOutages(params),
    staleTime: 60_000,
  })

export const speedTestsQuery = (params: { from: number; to: number }) =>
  queryOptions({
    queryKey: ['speedtests', params.from, params.to],
    queryFn: () => getSpeedTests(params),
    staleTime: 60_000,
  })

export const speedSummaryQuery = (days: number) =>
  queryOptions({
    queryKey: ['speedtests-summary', days],
    queryFn: () => getSpeedSummary(days),
    staleTime: 60_000,
  })
