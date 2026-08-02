import { queryOptions } from '@tanstack/react-query'
import {
  getEvents,
  getOutages,
  getProbeBuckets,
  getRouter,
  getSpeedSummary,
  getSpeedTests,
  getStatus,
  getThroughput,
  getVerdicts,
} from './api'
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

export const throughputQuery = (params: { from: number; to: number; bucket: ProbeBucketSeconds }) =>
  queryOptions({
    queryKey: ['throughput', params.bucket, params.from, params.to],
    queryFn: () => getThroughput(params),
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

/** The router poller runs every 10 minutes by default, but this refetches faster than that on
 * purpose: `ageMs`/`stale` are computed server-side at request time, so a cached response keeps
 * claiming the age it had when it was fetched. Staleness has to be the server's verdict, not a
 * client cache's memory of one. */
export const routerQuery = () =>
  queryOptions({
    queryKey: ['router'],
    queryFn: getRouter,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

export const verdictsQuery = (params: { from: number; to: number }) =>
  queryOptions({
    queryKey: ['verdicts', params.from, params.to],
    queryFn: () => getVerdicts(params),
    staleTime: 60_000,
  })

export const eventsQuery = (params: { from: number; to: number }) =>
  queryOptions({
    queryKey: ['events', params.from, params.to],
    queryFn: () => getEvents(params),
    staleTime: 60_000,
  })
