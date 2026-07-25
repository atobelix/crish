export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
export const DEFAULT_APPROVAL_RESOLUTION_RETENTION_MS = 5 * 60 * 1000;
/** Floor for finite approval timeouts (avoids sub-100ms timer races). */
export const MIN_APPROVAL_TIMEOUT_MS = 100;
/** Cap for finite approval timeouts (1h) so misconfig cannot hang forever. */
export const MAX_APPROVAL_TIMEOUT_MS = 60 * 60 * 1000;

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
  metadata: ApprovalMetadata | undefined;
  resolvedAt: number | undefined;
  expiredAt: number | undefined;
  reason: string | undefined;
  expiredReason: string | undefined;
}

export interface ApprovalQueueOptions {
  defaultTimeoutMs?: number;
  resolvedRetentionMs?: number;
  now?: () => number;
}

export interface WaitForApprovalOptions {
  timeoutMs?: number;
}

interface PendingApproval {
  toolCallId: string;
  runId: string;
  createdAt: number;
  timeoutMs: number | null;
  expiresAt: number | null;
  metadata: ApprovalMetadata | undefined;
  promise: Promise<ApprovalResult>;
  resolve: (result: ApprovalResult) => void;
  timer: NodeJS.Timeout | undefined;
}

import { BoundedMap } from "@crish/shared-utils";
import { getDaemonLogger } from "./daemon-logger.js";

export class ApprovalQueue {
  private pending = new Map<string, PendingApproval>();
  private resolved = new BoundedMap<string, ApprovalQueueSnapshot>(1000, undefined);
  private scopes = new BoundedMap<string, ApprovalScope>(1000, undefined);
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

  getResolvedRetentionMs(): number {
    return this.resolvedRetentionMs;
  }

  async waitForApproval(
    toolCallId: string,
    runId: string,
    metadata?: ApprovalMetadata,
    options: WaitForApprovalOptions = {}
  ): Promise<ApprovalResult> {
    const existing = this.pending.get(toolCallId);
    if (existing) {
      getDaemonLogger().warn('Duplicate waitForApproval', { module: 'ApprovalQueue', toolCallId, runId });
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
      timer: undefined,
    };

    this.armTimer(pending);
    this.pending.set(toolCallId, pending);
    return promise;
  }

  /**
   * Extend a pending approval deadline (UI "still reviewing").
   * No-op for infinite timeouts or unknown ids. Returns the new snapshot or undefined.
   */
  extendTimeout(toolCallId: string, extraMs: number): ApprovalQueueSnapshot | undefined {
    const pending = this.pending.get(toolCallId);
    if (!pending || pending.timeoutMs === null || pending.expiresAt === null) {
      return undefined;
    }
    if (!Number.isFinite(extraMs) || extraMs <= 0) {
      return this.pendingSnapshot(pending);
    }

    const add = Math.min(
      MAX_APPROVAL_TIMEOUT_MS,
      Math.max(MIN_APPROVAL_TIMEOUT_MS, Math.floor(extraMs))
    );
    const now = this.now();
    const remaining = Math.max(0, pending.expiresAt - now);
    const nextTimeout = clampTimeoutMs(remaining + add);
    if (nextTimeout === null) {
      return this.pendingSnapshot(pending);
    }

    pending.timeoutMs = nextTimeout;
    pending.expiresAt = now + nextTimeout;
    this.armTimer(pending);
    getDaemonLogger().info('Approval timeout extended', { module: 'ApprovalQueue', toolCallId, addMs: add, remainingMs: nextTimeout, runId: pending.runId });
    return this.pendingSnapshot(pending);
  }

  resolve(toolCallId: string, decision: ApprovalUserDecision, scope?: ApprovalScope): boolean {
    const pending = this.pending.get(toolCallId);
    if (!pending) {
      getDaemonLogger().warn('No pending approval found', { module: 'ApprovalQueue', toolCallId });
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
    getDaemonLogger().info('Approval resolved', { module: 'ApprovalQueue', toolCallId, decision, scope: scope || 'project' });
    return true;
  }

  /**
   * Peek stored scope without consuming (for late-resolve diagnostics).
   */
  getScope(toolCallId: string): ApprovalScope | undefined {
    return this.scopes.get(toolCallId);
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
      getDaemonLogger().info('Approval auto-denied', { module: 'ApprovalQueue', toolCallId, reason, runId: pending.runId });
    }
    this.pending.clear();
    this.scopes.clear();
  }

  clearRun(runId: string, reason = "run-cancelled"): void {
    for (const [, pending] of this.pending) {
      if (pending.runId !== runId) continue;
      this.settle(pending, {
        decision: "denied",
        reason,
        resolvedAt: this.now(),
      });
      getDaemonLogger().info('Approval auto-denied for run', { module: 'ApprovalQueue', toolCallId: pending.toolCallId, runId, reason });
    }
  }

  get size(): number {
    return this.pending.size;
  }

  private armTimer(pending: PendingApproval): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    if (pending.timeoutMs === null || pending.expiresAt === null) {
      return;
    }
    const delay = Math.max(0, pending.expiresAt - this.now());
    pending.timer = setTimeout(() => {
      this.expire(pending.toolCallId);
    }, delay);
    pending.timer.unref?.();
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
    getDaemonLogger().warn('Approval expired', { module: 'ApprovalQueue', toolCallId, runId: pending.runId, timeoutMs: pending.timeoutMs ?? 0 });
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
      resolvedAt: undefined,
      expiredAt: undefined,
      reason: undefined,
      expiredReason: undefined,
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
      expiredAt: result.expiredAt ?? undefined,
      reason: result.reason,
      expiredReason: result.decision === "expired" ? result.reason : undefined,
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

/**
 * Normalize timeout: undefined/null → fallback; 0/Infinity → infinite (null);
 * non-finite/negative → fallback; otherwise clamp to [MIN, MAX].
 */
export function normalizeTimeoutMs(
  value: number | undefined | null,
  fallback: number | null
): number | null {
  if (value === undefined || value === null) return clampTimeoutMs(fallback);
  if (value === 0 || value === Number.POSITIVE_INFINITY) return null;
  if (!Number.isFinite(value) || value < 0) return clampTimeoutMs(fallback);
  return clampTimeoutMs(Math.floor(value));
}

function clampTimeoutMs(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_APPROVAL_TIMEOUT_MS;
  if (value === 0) return null;
  return Math.min(MAX_APPROVAL_TIMEOUT_MS, Math.max(MIN_APPROVAL_TIMEOUT_MS, Math.floor(value)));
}

function normalizeRetentionMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_APPROVAL_RESOLUTION_RETENTION_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_APPROVAL_RESOLUTION_RETENTION_MS;
  return Math.floor(value);
}
