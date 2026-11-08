/**
 * Pure placement logic. No I/O and no SQL: the caller gathers host health,
 * capacity and reservations, and inserts the reservation in the same SQLite
 * write transaction that applied this decision, so concurrent creates cannot
 * oversubscribe a host.
 */
import type { HostConfig } from './config'
import type { Capacity, HostRecord, Reserved } from './store'

export interface RequestedResources {
  vcpus: number
  memMiB: number
  diskMiB: number
}

export interface Overcommit {
  vcpu: number
  mem: number
}

export interface PlacementCandidate {
  config: HostConfig
  host: HostRecord
  reserved: Reserved
}

export const effectiveCapacity = (
  configured: Capacity,
  reported: Capacity | null
): Capacity =>
  reported === null
    ? configured
    : {
        vcpus: Math.min(configured.vcpus, reported.vcpus),
        memMiB: Math.min(configured.memMiB, reported.memMiB),
        diskMiB: Math.min(configured.diskMiB, reported.diskMiB),
        maxInstances: Math.min(configured.maxInstances, reported.maxInstances),
      }

export const isPlaceable = (candidate: PlacementCandidate): boolean =>
  candidate.host.health === 'healthy' &&
  !candidate.host.draining &&
  candidate.host.accepting

export interface FitResult {
  fits: boolean
  /** Resources that are short for this host (empty when it fits). */
  short: Array<'vcpus' | 'memMiB' | 'diskMiB' | 'instances'>
}

export const checkFit = (
  candidate: PlacementCandidate,
  requested: RequestedResources,
  overcommit: Overcommit
): FitResult => {
  const capacity = effectiveCapacity(
    candidate.config.capacity,
    candidate.host.reportedCapacity
  )
  const short: FitResult['short'] = []
  if (
    candidate.reserved.memMiB + requested.memMiB >
    capacity.memMiB * overcommit.mem
  ) {
    short.push('memMiB')
  }
  if (
    candidate.reserved.vcpus + requested.vcpus >
    capacity.vcpus * overcommit.vcpu
  ) {
    short.push('vcpus')
  }
  if (candidate.reserved.diskMiB + requested.diskMiB > capacity.diskMiB) {
    short.push('diskMiB')
  }
  if (candidate.reserved.instances + 1 > capacity.maxInstances) {
    short.push('instances')
  }
  return { fits: short.length === 0, short }
}

const freeMemory = (
  candidate: PlacementCandidate,
  overcommit: Overcommit
): number =>
  effectiveCapacity(candidate.config.capacity, candidate.host.reportedCapacity)
    .memMiB *
    overcommit.mem -
  candidate.reserved.memMiB

const freeVcpus = (
  candidate: PlacementCandidate,
  overcommit: Overcommit
): number =>
  effectiveCapacity(candidate.config.capacity, candidate.host.reportedCapacity)
    .vcpus *
    overcommit.vcpu -
  candidate.reserved.vcpus

/**
 * Pick the healthy, accepting, non-draining host with the most free memory
 * that still fits the request (spread placement).
 */
export const selectHost = (
  candidates: readonly PlacementCandidate[],
  requested: RequestedResources,
  overcommit: Overcommit
): PlacementCandidate | undefined => {
  const fitting = candidates.filter(
    candidate =>
      isPlaceable(candidate) && checkFit(candidate, requested, overcommit).fits
  )
  fitting.sort((a, b) => {
    const memDelta = freeMemory(b, overcommit) - freeMemory(a, overcommit)
    if (memDelta !== 0) return memDelta
    const vcpuDelta = freeVcpus(b, overcommit) - freeVcpus(a, overcommit)
    if (vcpuDelta !== 0) return vcpuDelta
    return a.host.id.localeCompare(b.host.id)
  })
  return fitting[0]
}

const RESOURCE_LABEL: Record<FitResult['short'][number], string> = {
  vcpus: 'vCPUs',
  memMiB: 'memory',
  diskMiB: 'disk',
  instances: 'instance slots',
}

/**
 * A player-facing explanation of why placement failed. Mentions only generic
 * resource names (host internals/ids are never needed to act on it).
 */
export const describeNoCapacity = (
  candidates: readonly PlacementCandidate[],
  requested: RequestedResources,
  overcommit: Overcommit
): string => {
  if (candidates.length === 0) {
    return 'no capacity: no hosts configured'
  }
  if (candidates.every(candidate => candidate.host.draining)) {
    return 'no capacity: all hosts are draining'
  }
  const placeable = candidates.filter(isPlaceable)
  if (placeable.length === 0) {
    if (candidates.every(candidate => candidate.host.health !== 'healthy')) {
      return 'no capacity: all hosts are unhealthy'
    }
    return 'no capacity: no host is accepting instances'
  }
  // Aggregate the resources that are short on *every* placeable host.
  const shortOnAll = new Set<FitResult['short'][number]>([
    'vcpus',
    'memMiB',
    'diskMiB',
    'instances',
  ])
  for (const candidate of placeable) {
    const { short } = checkFit(candidate, requested, overcommit)
    for (const resource of shortOnAll) {
      if (!short.includes(resource)) shortOnAll.delete(resource)
    }
  }
  if (shortOnAll.size > 0) {
    const labels = [...shortOnAll].map(resource => RESOURCE_LABEL[resource])
    return `no capacity: insufficient ${labels.join(', ')} for ${
      requested.vcpus
    } vCPU / ${requested.memMiB} MiB / ${requested.diskMiB} MiB`
  }
  return 'no capacity: no host has room for this instance'
}
