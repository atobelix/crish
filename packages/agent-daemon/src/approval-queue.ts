export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_APPROVAL_RESOLUTION_RETENTION_MS = 5 * 60 * 1000;

export type ApprovalDecision = "approved" | "denied" | "expired";
export type ApprovalUserDecision = Exclude<ApprovalDecision, "expired">;
export type ApprovalStatus = "pending" | ApprovalDecision;
export type ApprovalScope = "project" | "always";

export interface ApprovalMetadata {
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalResult {
  decision: ApprovalDecision;
  reason: string;
  createdAt: number;
  resolvedAt: number;
  timeoutMs: number | null;
  expiresAt: number | null;
  expiredAt?: number;
}

export interface ApprovalQueueSnapshot {
  toolCallId: string;
  runId: string;
  status: ApprovalStatus;
  createdAt: number;
  timeoutMs: number | null;
  expiresAt: number | null;
  remainingMs: number | null;
  metadata?: ApprovalMetadata;
  resolvedAt?: number;
  expiredAt?: number;
  reason?: string;
  expiredReason?: string;
}

interface ApprovalQueueOptions {
  defaultTimeoutMs?: number;
  resolvedRetentionMs?: number;
  now?: () => number;
}

interface WaitForApprovalOptions {
  timeoutMs?: number;
}

interface PendingApproval {
  toolCallId: string;
  runId: string;
  createdAt: number;
  timeoutMs: number | null;
  expiresAt: number | null;
  metadata?: ApprovalMetadata;
  promise: Promise<ApprovalResult>;
  resolve: (result: ApprovalResult) => void;
  timer?: NodeJS.Timeout;
}

export class ApprovalQueue {
  private pending = new Map<string, PendingApproval>();
  private resolved = new Map<string, ApprovalQueueSnapshot>();
  private scopes = new Map<string, ApprovalScope>();
  private defaultTimeoutMs: number | null;
  private resolvedRetentionMs: number;
  private readonly now: () => number;

  constructor(options: ApprovalQueueOptions = {}) {
    this.defaultTimeoutMs = normalizeTimeoutMs(
      options.defaultTimeoutMs,
      DEFAULT_APPROVAL_TIMEOUT_MS
    );
    this.resolvedRetentionMs = normalizeRetentionMs(options.resolvedRetentionMs);
    this.now = options.now ?? Date.now;
  }

  configure(options: ApprovalQueueOptions): void {
    if ("defaultTimeoutMs" in options) {
      this.defaultTimeoutMs = normalizeTimeoutMs(
        options.defaultTimeoutMs,
        DEFAULT_APPROVAL_TIMEOUT_MS
      );
    }
    if ("resolvedRetentionMs" in options) {
      this.resolvedRetentionMs = normalizeRetentionMs(options.resolvedRetentionMs);
    }
  }

  getDefaultTimeoutMs(): number | null {
    return this.defaultTimeoutMs;
  }

  async waitForApproval(
    toolCallId: string,
    runId: string,
    metadata?: ApprovalMetadata,
    options: WaitForApprovalOptions = {}
  ): Promise<ApprovalResult> {
    const existing = this.pending.get(toolCallId);
    if (existing) {
      console.warn(`[ApprovalQueue] Duplicate waitForApproval for toolCallId: ${toolCallId}`);
      return existing.promise;
    }

    const createdAt = this.now();
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, this.defaultTimeoutMs);
    const expiresAt = timeoutMs === null ? null : createdAt + timeoutMs;

    let resolvePromise!: (result: ApprovalResult) => void;
    const promise = new Promise<ApprovalResult>((resolve) => {
      resolvePromise = resolve;
    });

    const pending: PendingApproval = {
      toolCallId,
      runId,
      createdAt,
      timeoutMs,
      expiresAt,
      metadata,
      promise,
      resolve: resolvePromise,
    };

    if (timeoutMs !== null) {
      pending.timer = setTimeout(() => {
        this.expire(toolCallId);
      }, timeoutMs);
      pending.timer.unref?.();
    }

    this.pending.set(toolCallId, pending);
    return promise;
  }

  resolve(toolCallId: string, decision: ApprovalUserDecision, scope?: ApprovalScope): boolean {
    const pending = this.pending.get(toolCallId);
    if (!pending) {
      console.warn(`[ApprovalQueue] No pending approval found for toolCallId: ${toolCallId}`);
      return false;
    }

    if (scope) {
      this.scopes.set(toolCallId, scope);
    }

    this.settle(pending, {
      decision,
      reason: decision === "approved" ? "user-approved" : "user-denied",
      resolvedAt: this.now(),
    });
    console.log(`[ApprovalQueue] Resolved ${toolCallId} -> ${decision} (scope: ${scope || "project"})`);
    return true;
  }

  consumeScope(toolCallId: string): ApprovalScope | undefined {
    const scope = this.scopes.get(toolCallId);
    this.scopes.delete(toolCallId);
    return scope;
  }

  getStatus(toolCallId: string): ApprovalStatus | null {
    const pending = this.pending.get(toolCallId);
    if (pending) return "pending";
    return this.resolved.get(toolCallId)?.status ?? null;
  }

  getPendingApprovals(): ApprovalQueueSnapshot[] {
    this.pruneResolved();
    return Array.from(this.pending.values()).map((pending) => this.pendingSnapshot(pending));
  }

  getApproval(toolCallId: string): ApprovalQueueSnapshot | undefined {
    const pending = this.pending.get(toolCallId);
    if (pending) return this.pendingSnapshot(pending);
    this.pruneResolved();
    return this.resolved.get(toolCallId);
  }

  getRecentApprovals(): ApprovalQueueSnapshot[] {
    this.pruneResolved();
    return Array.from(this.resolved.values());
  }

  clearAll(reason = "daemon-shutdown"): void {
    for (const [toolCallId, pending] of this.pending) {
      this.settle(pending, {
        decision: "denied",
        reason,
        resolvedAt: this.now(),
      });
      console.log(`[ApprovalQueue] Auto-denied ${toolCallId} (${reason})`);
    }
    this.pending.clear();
  }

  clearRun(runId: string, reason = "run-cancelled"): void {
    for (const [toolCallId, pending] of this.pending) {
      if (pending.runId !== runId) continue;
      this.settle(pending, {
        decision: "denied",
        reason,
        resolvedAt: this.now(),
      });
      console.log(`[ApprovalQueue] Auto-denied ${toolCallId} for run ${runId} (${reason})`);
    }
  }

  get size(): number {
    return this.pending.size;
  }

  private expire(toolCallId: string): void {
    const pending = this.pending.get(toolCallId);
    if (!pending) return;
    const expiredAt = this.now();
    this.settle(pending, {
      decision: "expired",
      reason: "timeout",
      resolvedAt: expiredAt,
      expiredAt,
    });
    console.warn(`[ApprovalQueue] Expired ${toolCallId} after ${pending.timeoutMs ?? 0}ms`);
  }

  private settle(
    pending: PendingApproval,
    result: Pick<ApprovalResult, "decision" | "reason" | "resolvedAt" | "expiredAt">
  ): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    this.pending.delete(pending.toolCallId);
    if (result.decision !== "approved") {
      this.scopes.delete(pending.toolCallId);
    }

    const fullResult: ApprovalResult = {
      decision: result.decision,
      reason: result.reason,
      createdAt: pending.createdAt,
      resolvedAt: result.resolvedAt,
      timeoutMs: pending.timeoutMs,
      expiresAt: pending.expiresAt,
      ...(result.expiredAt !== undefined ? { expiredAt: result.expiredAt } : {}),
    };

    pending.resolve(fullResult);
    this.rememberResolution(pending, fullResult);
  }

  private pendingSnapshot(pending: PendingApproval): ApprovalQueueSnapshot {
    return {
      toolCallId: pending.toolCallId,
      runId: pending.runId,
      status: "pending",
      createdAt: pending.createdAt,
      timeoutMs: pending.timeoutMs,
      expiresAt: pending.expiresAt,
      remainingMs:
        pending.expiresAt === null
          ? null
          : Math.max(0, pending.expiresAt - this.now()),
      metadata: pending.metadata,
    };
  }

  private rememberResolution(pending: PendingApproval, result: ApprovalResult): void {
    this.pruneResolved();
    this.resolved.set(pending.toolCallId, {
      toolCallId: pending.toolCallId,
      runId: pending.runId,
      status: result.decision,
      createdAt: pending.createdAt,
      timeoutMs: pending.timeoutMs,
      expiresAt: pending.expiresAt,
      remainingMs: 0,
      metadata: pending.metadata,
      resolvedAt: result.resolvedAt,
      ...(result.expiredAt !== undefined ? { expiredAt: result.expiredAt } : {}),
      reason: result.reason,
      ...(result.decision === "expired" ? { expiredReason: result.reason } : {}),
    });
  }

  private pruneResolved(): void {
    if (this.resolvedRetentionMs <= 0) {
      this.resolved.clear();
      return;
    }

    const cutoff = this.now() - this.resolvedRetentionMs;
    for (const [toolCallId, snapshot] of this.resolved) {
      if ((snapshot.resolvedAt ?? snapshot.createdAt) <= cutoff) {
        this.resolved.delete(toolCallId);
      }
    }
  }
}

function normalizeTimeoutMs(value: number | undefined | null, fallback: number | null): number | null {
  if (value === undefined || value === null) return fallback;
  if (value === 0 || value === Number.POSITIVE_INFINITY) return null;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function normalizeRetentionMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_APPROVAL_RESOLUTION_RETENTION_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_APPROVAL_RESOLUTION_RETENTION_MS;
  return Math.floor(value);
}
