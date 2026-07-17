import { isAbsolute, resolve, sep } from "node:path";
import { BoundedMap } from "@crish/shared-utils";
import { createId } from "./session";

/** 读快照 session 维度上限：按 session 聚合的路径快照，防止跨 session 累积。 */
const MAX_READ_SNAPSHOT_SESSIONS = 100;
/** 单 session 内读快照路径上限：防止超长 session 中路径快照单调增长。 */
const MAX_READ_SNAPSHOTS_PER_SESSION = 1000;

export type LeaseScope = { type: "workspace" } | { type: "files"; paths: string[] };
export type NormalizedLeaseScope = { type: "workspace" } | { type: "files"; paths: string[] };

export interface MutationLeaseOwner {
  runId?: string;
  sessionId?: string;
  toolCallId?: string;
  toolName?: string;
  cwd?: string;
  targetSummary?: string;
}

export interface MutationLease {
  token: string;
  owner?: MutationLeaseOwner;
  scope: NormalizedLeaseScope;
  createdAt: string;
  expiresAt: string;
  ttlMs: number;
}

export interface WorkspaceMutationCoordinatorOptions {
  workspaceRoot?: string;
  defaultTtlMs?: number;
  idFactory?: () => string;
  now?: () => Date | number;
  caseSensitivePaths?: boolean;
}

export interface AcquireMutationLeaseRequest {
  scope: LeaseScope;
  owner?: MutationLeaseOwner;
  ttlMs?: number;
  wait?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type AcquireMutationLeaseFailureReason = "conflict" | "timeout" | "aborted";

export type AcquireMutationLeaseResult =
  | { ok: true; lease: MutationLease }
  | {
      ok: false;
      reason: AcquireMutationLeaseFailureReason;
      conflictingLeases: MutationLease[];
    };

export type ReleaseMutationLeaseResult = { ok: true; lease: MutationLease } | { ok: false; reason: "not_found" };
export type RenewMutationLeaseResult = { ok: true; lease: MutationLease } | { ok: false; reason: "not_found" };

export interface RenewMutationLeaseOptions {
  ttlMs?: number;
}

export interface WithMutationLeaseRequest extends AcquireMutationLeaseRequest {
  heartbeatIntervalMs?: number;
  renewTtlMs?: number;
}

export class WorkspaceMutationLeaseError extends Error {
  readonly reason: AcquireMutationLeaseFailureReason;
  readonly conflictingLeases: MutationLease[];

  constructor(result: Extract<AcquireMutationLeaseResult, { ok: false }>) {
    super(`Unable to acquire workspace mutation lease: ${result.reason}`);
    this.name = "WorkspaceMutationLeaseError";
    this.reason = result.reason;
    this.conflictingLeases = result.conflictingLeases;
  }
}

interface ActiveMutationLease extends MutationLease {
  createdAtMs: number;
  expiresAtMs: number;
}

interface WaitingMutationLeaseRequest {
  scope: NormalizedLeaseScope;
  owner?: MutationLeaseOwner;
  ttlMs: number;
  resolve: (result: AcquireMutationLeaseResult) => void;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

const DEFAULT_LEASE_TTL_MS = 30_000;
const MAX_TOKEN_ATTEMPTS = 20;

export class WorkspaceMutationCoordinator {
  private readonly workspaceRoot?: string;
  private readonly defaultTtlMs: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date | number;
  private readonly caseSensitivePaths: boolean;
  private readonly leases = new Map<string, ActiveMutationLease>();
  private readonly readSnapshots = new BoundedMap<string, BoundedMap<string, string>>(MAX_READ_SNAPSHOT_SESSIONS);
  private waiters: WaitingMutationLeaseRequest[] = [];
  private expiryTimer?: ReturnType<typeof setTimeout>;

  constructor(options: WorkspaceMutationCoordinatorOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined;
    this.defaultTtlMs = normalizePositiveMs(options.defaultTtlMs ?? DEFAULT_LEASE_TTL_MS, "defaultTtlMs");
    this.idFactory = options.idFactory ?? (() => createId("lease"));
    this.now = options.now ?? (() => Date.now());
    this.caseSensitivePaths = options.caseSensitivePaths ?? process.platform !== "win32";
  }

  acquire(request: AcquireMutationLeaseRequest): Promise<AcquireMutationLeaseResult> {
    const scope = this.normalizeScope(request.scope);
    const ttlMs = normalizePositiveMs(request.ttlMs ?? this.defaultTtlMs, "ttlMs");
    this.expireDueLeases();

    if (request.signal?.aborted) {
      return Promise.resolve({ ok: false, reason: "aborted", conflictingLeases: [] });
    }

    if (this.canGrant(scope, this.waiters)) {
      return Promise.resolve({ ok: true, lease: this.grantLease(scope, request.owner, ttlMs) });
    }

    if (!request.wait) {
      return Promise.resolve({
        ok: false,
        reason: "conflict",
        conflictingLeases: this.conflictingActiveLeases(scope)
      });
    }

    const timeoutMs = request.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      throw new Error("timeoutMs must be a non-negative finite number");
    }
    if (timeoutMs === 0) {
      return Promise.resolve({
        ok: false,
        reason: "timeout",
        conflictingLeases: this.conflictingActiveLeases(scope)
      });
    }

    return new Promise<AcquireMutationLeaseResult>((resolvePromise) => {
      const waiter: WaitingMutationLeaseRequest = {
        scope,
        owner: cloneOwner(request.owner),
        ttlMs,
        resolve: resolvePromise,
        signal: request.signal
      };

      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          this.removeWaiter(waiter);
          this.settleWaiter(waiter, {
            ok: false,
            reason: "timeout",
            conflictingLeases: this.conflictingActiveLeases(scope)
          });
        }, timeoutMs);
        unrefTimer(waiter.timeout);
      }

      if (request.signal) {
        waiter.abortHandler = () => {
          this.removeWaiter(waiter);
          this.settleWaiter(waiter, { ok: false, reason: "aborted", conflictingLeases: [] });
        };
        request.signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }

      this.waiters.push(waiter);
    });
  }

  release(token: string): ReleaseMutationLeaseResult {
    this.expireDueLeases();
    const lease = this.leases.get(token);
    if (!lease) {
      return { ok: false, reason: "not_found" };
    }

    this.leases.delete(token);
    this.drainWaiters();
    this.scheduleExpiryTimer();
    return { ok: true, lease: cloneLease(lease) };
  }

  renew(token: string, options: RenewMutationLeaseOptions = {}): RenewMutationLeaseResult {
    this.expireDueLeases();
    const lease = this.leases.get(token);
    if (!lease) {
      return { ok: false, reason: "not_found" };
    }

    const ttlMs = normalizePositiveMs(options.ttlMs ?? lease.ttlMs, "ttlMs");
    const nowMs = this.nowMs();
    const renewed: ActiveMutationLease = {
      ...lease,
      ttlMs,
      expiresAt: toIso(nowMs + ttlMs),
      expiresAtMs: nowMs + ttlMs
    };
    this.leases.set(token, renewed);
    this.scheduleExpiryTimer();
    return { ok: true, lease: cloneLease(renewed) };
  }

  async withLease<TResult>(
    request: WithMutationLeaseRequest,
    operation: (lease: MutationLease) => Promise<TResult> | TResult
  ): Promise<TResult> {
    const acquired = await this.acquire(request);
    if (!acquired.ok) {
      throw new WorkspaceMutationLeaseError(acquired);
    }

    const ttlMs = request.ttlMs ?? this.defaultTtlMs;
    const renewTtlMs = request.renewTtlMs ?? ttlMs;
    const heartbeatIntervalMs = request.heartbeatIntervalMs ?? Math.max(1, Math.floor(ttlMs / 2));
    const heartbeat =
      heartbeatIntervalMs > 0
        ? setInterval(() => {
            this.renew(acquired.lease.token, { ttlMs: renewTtlMs });
          }, heartbeatIntervalMs)
        : undefined;
    if (heartbeat) {
      unrefTimer(heartbeat);
    }

    try {
      return await operation(acquired.lease);
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      this.release(acquired.lease.token);
    }
  }

  recordReadSnapshot(sessionId: string, path: string, snapshotTag: string): void {
    const normalizedSessionId = requireNonEmptyString(sessionId, "sessionId");
    const normalizedPath = this.normalizePath(path);
    let snapshots = this.readSnapshots.get(normalizedSessionId);
    if (!snapshots) {
      snapshots = new BoundedMap<string, string>(MAX_READ_SNAPSHOTS_PER_SESSION);
      this.readSnapshots.set(normalizedSessionId, snapshots);
    }
    snapshots.set(normalizedPath, snapshotTag);
  }

  latestReadSnapshot(sessionId: string, path: string): string | undefined {
    const normalizedSessionId = requireNonEmptyString(sessionId, "sessionId");
    return this.readSnapshots.get(normalizedSessionId)?.get(this.normalizePath(path));
  }

  getLease(token: string): MutationLease | undefined {
    this.expireDueLeases();
    const lease = this.leases.get(token);
    return lease ? cloneLease(lease) : undefined;
  }

  listLeases(): MutationLease[] {
    this.expireDueLeases();
    return [...this.leases.values()].map(cloneLease);
  }

  normalizeScope(scope: LeaseScope): NormalizedLeaseScope {
    if (scope.type === "workspace") {
      return { type: "workspace" };
    }
    if (scope.type !== "files") {
      throw new Error("Lease scope type must be workspace or files");
    }
    if (!Array.isArray(scope.paths) || scope.paths.length === 0) {
      throw new Error("File lease scope must include at least one path");
    }

    const paths = [...new Set(scope.paths.map((path) => this.normalizePath(path)))].sort();
    return { type: "files", paths };
  }

  normalizePath(path: string): string {
    const value = requireNonEmptyString(path, "path");
    const resolved = isAbsolute(value) || !this.workspaceRoot ? resolve(value) : resolve(this.workspaceRoot, value);
    const normalized = resolved.split(sep).join("/");
    return this.caseSensitivePaths ? normalized : normalized.toLocaleLowerCase("en-US");
  }

  private grantLease(scope: NormalizedLeaseScope, owner: MutationLeaseOwner | undefined, ttlMs: number): MutationLease {
    const nowMs = this.nowMs();
    const token = this.createToken();
    const lease: ActiveMutationLease = {
      token,
      owner: cloneOwner(owner),
      scope: cloneScope(scope),
      createdAt: toIso(nowMs),
      createdAtMs: nowMs,
      expiresAt: toIso(nowMs + ttlMs),
      expiresAtMs: nowMs + ttlMs,
      ttlMs
    };
    this.leases.set(token, lease);
    this.scheduleExpiryTimer();
    return cloneLease(lease);
  }

  private createToken(): string {
    for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
      const token = requireNonEmptyString(this.idFactory(), "lease token");
      if (!this.leases.has(token)) {
        return token;
      }
    }
    throw new Error("Unable to create a unique lease token");
  }

  private canGrant(scope: NormalizedLeaseScope, queuedAhead: WaitingMutationLeaseRequest[]): boolean {
    if (this.hasActiveConflict(scope)) {
      return false;
    }
    return !queuedAhead.some((waiter) => scopesConflict(waiter.scope, scope));
  }

  private hasActiveConflict(scope: NormalizedLeaseScope): boolean {
    return this.conflictingActiveLeases(scope).length > 0;
  }

  private conflictingActiveLeases(scope: NormalizedLeaseScope): MutationLease[] {
    return [...this.leases.values()].filter((lease) => scopesConflict(lease.scope, scope)).map(cloneLease);
  }

  private expireDueLeases(): void {
    const nowMs = this.nowMs();
    let expired = false;
    for (const [token, lease] of this.leases) {
      if (lease.expiresAtMs <= nowMs) {
        this.leases.delete(token);
        expired = true;
      }
    }
    if (expired) {
      this.drainWaiters();
    }
  }

  private drainWaiters(): void {
    const remaining: WaitingMutationLeaseRequest[] = [];
    for (const waiter of this.waiters) {
      if (this.hasActiveConflict(waiter.scope) || remaining.some((prior) => scopesConflict(prior.scope, waiter.scope))) {
        remaining.push(waiter);
        continue;
      }

      this.settleWaiter(waiter, { ok: true, lease: this.grantLease(waiter.scope, waiter.owner, waiter.ttlMs) });
    }
    this.waiters = remaining;
    this.scheduleExpiryTimer();
  }

  private removeWaiter(waiter: WaitingMutationLeaseRequest): void {
    this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
  }

  private settleWaiter(waiter: WaitingMutationLeaseRequest, result: AcquireMutationLeaseResult): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
      waiter.timeout = undefined;
    }
    if (waiter.signal && waiter.abortHandler) {
      waiter.signal.removeEventListener("abort", waiter.abortHandler);
      waiter.abortHandler = undefined;
    }
    waiter.resolve(result);
  }

  private scheduleExpiryTimer(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    let nextExpiryMs = Number.POSITIVE_INFINITY;
    for (const lease of this.leases.values()) {
      nextExpiryMs = Math.min(nextExpiryMs, lease.expiresAtMs);
    }
    if (!Number.isFinite(nextExpiryMs)) {
      return;
    }

    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.expireDueLeases();
      this.scheduleExpiryTimer();
    }, Math.max(0, nextExpiryMs - this.nowMs()));
    unrefTimer(this.expiryTimer);
  }

  private nowMs(): number {
    const value = this.now();
    const timestamp = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(timestamp)) {
      throw new Error("WorkspaceMutationCoordinator clock returned an invalid timestamp");
    }
    return timestamp;
  }
}

export function scopesConflict(left: NormalizedLeaseScope, right: NormalizedLeaseScope): boolean {
  if (left.type === "workspace" || right.type === "workspace") {
    return true;
  }

  const rightPaths = new Set(right.paths);
  return left.paths.some((path) => rightPaths.has(path));
}

function normalizePositiveMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function requireNonEmptyString(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function cloneLease(lease: ActiveMutationLease | MutationLease): MutationLease {
  return {
    token: lease.token,
    owner: cloneOwner(lease.owner),
    scope: cloneScope(lease.scope),
    createdAt: lease.createdAt,
    expiresAt: lease.expiresAt,
    ttlMs: lease.ttlMs
  };
}

function cloneScope(scope: NormalizedLeaseScope): NormalizedLeaseScope {
  return scope.type === "workspace" ? { type: "workspace" } : { type: "files", paths: [...scope.paths] };
}

function cloneOwner(owner: MutationLeaseOwner | undefined): MutationLeaseOwner | undefined {
  return owner ? { ...owner } : undefined;
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  const maybeUnref = timer as { unref?: () => void };
  maybeUnref.unref?.();
}
