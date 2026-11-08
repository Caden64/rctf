/**
 * Internal seams between the parallel work-streams. Owners implement the
 * interface named in ARCHITECTURE.md; consumers depend ONLY on these types, so
 * each side can be tested with fakes. Changing a signature here requires the
 * integration owner (lead) to approve.
 */
import type {
  AgentInfo,
  AgentInstance,
  AgentInstanceSpec,
  ControllerInstanceDetails,
  CreateInstanceRequest,
  ExtendInstanceRequest,
  ExposeKindValue,
  GuestMetadata,
  HostSummary,
  InstanceKey,
  Readiness,
  ErrorCode,
} from '@rctf/firecracker-protocol'

// ===========================================================================
// Agent-side: networking (track 3)  --  src/agent/net/*
// ===========================================================================

export interface NetExposeRequest {
  kind: ExposeKindValue
  hostPrefix: string
  /** Guest port. */
  port: number
}

/**
 * Everything the host needs to know to attach one VM. Serialisable JSON
 * (persisted by the instance manager in the agent state dir; contains NO secrets).
 */
export interface NetLease {
  instanceId: string
  /** Host tap device, e.g. `fctap<n>`; <= 15 chars. */
  tapName: string
  /** Host side of the point-to-point /30. */
  hostIp: string
  guestIp: string
  prefixLength: number
  guestMac: string
  /** The full expose list (kind, hostPrefix, guest port) so every route can be rebuilt from the lease alone after a restart. */
  expose: NetExposeRequest[]
  /** index into the expose array -> public host TCP port (only for tcp/raw kinds). */
  publicPorts: Record<number, number>
  /** index into the expose array -> public hostname (only for http/https/tcp-ssl). */
  publicHostnames: Record<number, string>
  egress: boolean
}

export interface PublicEndpoint {
  kind: ExposeKindValue
  host: string
  port: number
}

export interface NetworkManager {
  /**
   * Create the tap + addresses + isolation/anti-spoof firewall rules and reserve
   * public ports/hostnames. Idempotent per instanceId (returns the existing
   * lease). On any failure everything created so far is rolled back.
   * Must fail with `NetworkCapacityError` when the IP pool or port range is exhausted.
   */
  allocate(req: {
    instanceId: string
    egress: boolean
    expose: NetExposeRequest[]
  }): Promise<NetLease>
  /** Install public routing (DNAT / Traefik files). Idempotent. Called once the VM process is up. */
  publish(lease: NetLease, expose: NetExposeRequest[]): Promise<void>
  /** Remove public routing only (e.g. VM died) but keep the lease. Idempotent. */
  unpublish(instanceId: string): Promise<void>
  /** Remove EVERYTHING for the instance (routes, rules, tap, ports, ips). Idempotent, tolerant of partial state. */
  release(instanceId: string): Promise<void>
  /** Endpoints in `expose` order. Pure function of lease. */
  endpoints(lease: NetLease, expose: NetExposeRequest[]): PublicEndpoint[]
  /**
   * Called once on agent start with every lease the manager still considers
   * alive. Rebuild in-memory allocators from them, re-assert rules/routes for
   * those, and remove every host network artifact (taps, nft rules, Traefik
   * files, port reservations) that belongs to no listed lease.
   * Returns ids of artifacts that were removed as orphans.
   */
  restore(leases: NetLease[]): Promise<{ removedOrphans: string[] }>
  /** Cheap self-check used in /v1/info (nft present, ip_forward on, ...). */
  preflight(): Promise<Record<string, boolean>>
}

export class NetworkCapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkCapacityError'
  }
}

// ===========================================================================
// Agent-side: VM lifecycle (track 2)  --  src/agent/vm/*
// ===========================================================================

export interface VmLaunchRequest {
  instanceId: string
  image: string
  vcpus: number
  memMiB: number
  diskMiB: number
  kernelArgs?: string
  lease: NetLease
  /** Contains secrets (flags). Hand to MMDS only. */
  metadata: GuestMetadata
}

/**
 * Persisted by the instance manager (JSON, no secrets). Must be sufficient to
 * re-attach to a running VM after an agent restart and to tell a stale pid
 * from a recycled one.
 */
export interface VmHandle {
  instanceId: string
  pid: number
  /** `/proc/<pid>/stat` field 22 (starttime ticks) captured at launch; defeats pid reuse. */
  pidStartTicks: number
  /** Absolute path of the Firecracker API unix socket. */
  apiSocket: string
  /** Per-instance working dir (jail root / drive copies). */
  dir: string
}

export interface PreflightResult {
  checks: Record<string, boolean>
  images: string[]
}

export interface VmDriver {
  /**
   * Prepare per-instance writable storage (copy/reflink of the image rootfs; the
   * base image is never written), spawn Firecracker (jailer in prod), configure
   * boot source, drives, NIC (tap from lease), MMDS (metadata), machine config,
   * resource rate limiters, and start the VM. Returns once InstanceStart succeeded.
   * On ANY failure it must kill the process and remove the per-instance storage
   * before throwing (no leaks). Never logs `request.metadata`.
   */
  launch(request: VmLaunchRequest): Promise<VmHandle>
  /** pid exists AND start ticks match AND cmdline is firecracker for this instance. */
  isAlive(handle: VmHandle): Promise<boolean>
  /** Resolves when readiness passes; rejects on timeout / VM death / abort. */
  waitReady(
    handle: VmHandle,
    probe: { readiness: Readiness; guestIp: string; timeoutMs: number },
    signal?: AbortSignal
  ): Promise<void>
  /** Graceful (CtrlAltDel) then SIGKILL after graceMs; waits for exit. Idempotent. Keeps storage. */
  stop(handle: VmHandle, opts: { graceMs: number }): Promise<void>
  /** Remove all per-instance storage/jail/sockets for the id. Idempotent. Process must already be dead (it kills if not). */
  destroy(instanceId: string): Promise<void>
  /**
   * Ids of everything the driver finds on disk or as running firecracker
   * processes (including ones the manager does not know) for orphan cleanup.
   */
  listInstanceIds(): Promise<string[]>
  /**
   * Re-attach to a process found for `instanceId` at startup (after restart).
   * Returns undefined if none is running.
   */
  adopt(instanceId: string): Promise<VmHandle | undefined>
  preflight(): Promise<PreflightResult>
}

// ===========================================================================
// Agent-side: instance manager (track 4)  --  src/agent/manager.ts
// ===========================================================================

export interface InstanceManager {
  /** Idempotent per spec.id; spec mismatch => ProtocolError('spec_mismatch'). */
  create(spec: AgentInstanceSpec): Promise<AgentInstance>
  get(id: string): Promise<AgentInstance | undefined>
  list(): Promise<AgentInstance[]>
  /** max(current, expiresAtMs). Throws ProtocolError('not_found'|'expired'). */
  extend(id: string, expiresAtMs: number): Promise<AgentInstance>
  /** Idempotent. Resolves when everything is released. Throws not_found for unknown ids. */
  delete(id: string): Promise<AgentInstance>
  info(): Promise<AgentInfo>
  /** Startup: adopt live VMs, clean orphans, resume pending teardowns. */
  start(): Promise<void>
  stop(): Promise<void>
}

// ===========================================================================
// Controller-side (tracks 4/5)  --  src/controller/*
// ===========================================================================

/** Client of the host agent HTTP API. Real impl: HttpAgentClient. */
export interface AgentClient {
  readonly hostId: string
  info(): Promise<AgentInfo>
  list(): Promise<AgentInstance[]>
  create(spec: AgentInstanceSpec): Promise<AgentInstance>
  get(id: string): Promise<AgentInstance | undefined>
  extend(id: string, expiresAtMs: number): Promise<AgentInstance>
  /** Idempotent: unknown id resolves as stopped. */
  delete(id: string): Promise<void>
}

/** Thrown by AgentClient: transport failure, timeout or 5xx (host may be down). */
export class AgentUnreachableError extends Error {
  constructor(
    readonly hostId: string,
    message: string
  ) {
    super(message)
    this.name = 'AgentUnreachableError'
  }
}

/** Thrown by AgentClient for a well-formed agent error response. */
export class AgentRejectedError extends Error {
  constructor(
    readonly hostId: string,
    readonly code: ErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AgentRejectedError'
  }
}

/** Business logic behind the controller HTTP API. Throws ProtocolError. */
export interface ControllerService {
  create(req: CreateInstanceRequest): Promise<ControllerInstanceDetails>
  get(key: InstanceKey): Promise<ControllerInstanceDetails>
  delete(key: InstanceKey): Promise<ControllerInstanceDetails>
  extend(req: ExtendInstanceRequest): Promise<ControllerInstanceDetails>
  listHosts(): Promise<HostSummary[]>
  drainHost(hostId: string): Promise<HostSummary>
  undrainHost(hostId: string): Promise<HostSummary>
  /** Forget a lost host; releases its reservations; its instances become `stopped`. */
  removeHost(hostId: string): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

// ===========================================================================
// Shared utilities
// ===========================================================================

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * The ONLY way privileged host commands (ip, nft, cp, mkfs, jailer, ...) are run.
 * argv array, no shell. Tests inject a recording/failing fake.
 */
export interface CommandRunner {
  run(
    argv: readonly string[],
    opts?: { timeoutMs?: number; stdin?: string }
  ): Promise<CommandResult>
}

/** Injectable time source (ms since epoch) so expiry/race tests are deterministic. */
export type Clock = () => number
