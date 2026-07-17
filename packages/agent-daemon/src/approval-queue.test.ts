import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalQueue,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_TIMEOUT_MS,
  MIN_APPROVAL_TIMEOUT_MS,
  normalizeTimeoutMs,
} from "./approval-queue";

describe("ApprovalQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a finite default timeout and resolves approved requests before expiry", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const queue = new ApprovalQueue({
      resolvedRetentionMs: 1_000,
      now: () => now,
    });

    const waiting = queue.waitForApproval("approval_default", "run_default", {
      toolName: "write_file",
      input: { path: "a.txt" },
      summary: "write a.txt",
      metadata: {
        risk: "write",
        reason: "Write requires confirmation",
        recommendSnapshot: true,
      },
    });

    const pending = queue.getPendingApprovals();
    expect(queue.getDefaultTimeoutMs()).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      toolCallId: "approval_default",
      runId: "run_default",
      status: "pending",
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      expiresAt: 1_000 + DEFAULT_APPROVAL_TIMEOUT_MS,
      remainingMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      metadata: {
        metadata: {
          risk: "write",
          reason: "Write requires confirmation",
          recommendSnapshot: true,
        },
      },
    });

    now = 1_025;
    expect(queue.resolve("approval_default", "approved")).toBe(true);
    await expect(waiting).resolves.toMatchObject({
      decision: "approved",
      reason: "user-approved",
      resolvedAt: 1_025,
    });
    expect(queue.getPendingApprovals()).toEqual([]);
    expect(queue.getRecentApprovals()).toEqual([
      expect.objectContaining({
        toolCallId: "approval_default",
        status: "approved",
        remainingMs: 0,
        metadata: expect.objectContaining({
          metadata: expect.objectContaining({
            risk: "write",
            reason: "Write requires confirmation",
            recommendSnapshot: true,
          }),
        }),
      }),
    ]);
  });

  it("expires pending approvals with a typed result and recent snapshot", async () => {
    vi.useFakeTimers();
    let now = 2_000;
    const queue = new ApprovalQueue({
      defaultTimeoutMs: 50,
      resolvedRetentionMs: 1_000,
      now: () => now,
    });

    const waiting = queue.waitForApproval("approval_expire", "run_expire", {
      toolName: "delete_file",
      input: { path: "danger.txt" },
      summary: "delete danger.txt",
    });

    // 50ms clamps up to MIN_APPROVAL_TIMEOUT_MS
    const expectedTimeout = MIN_APPROVAL_TIMEOUT_MS;
    now = 2_025;
    await vi.advanceTimersByTimeAsync(25);
    expect(queue.getPendingApprovals()[0]).toMatchObject({
      status: "pending",
      timeoutMs: expectedTimeout,
      expiresAt: 2_000 + expectedTimeout,
      remainingMs: expectedTimeout - 25,
    });

    now = 2_000 + expectedTimeout;
    await vi.advanceTimersByTimeAsync(expectedTimeout);
    await expect(waiting).resolves.toMatchObject({
      decision: "expired",
      reason: "timeout",
      resolvedAt: 2_000 + expectedTimeout,
      expiredAt: 2_000 + expectedTimeout,
      timeoutMs: expectedTimeout,
      expiresAt: 2_000 + expectedTimeout,
    });

    expect(queue.getPendingApprovals()).toEqual([]);
    expect(queue.getRecentApprovals()).toEqual([
      expect.objectContaining({
        toolCallId: "approval_expire",
        runId: "run_expire",
        status: "expired",
        resolvedAt: 2_000 + expectedTimeout,
        expiredAt: 2_000 + expectedTimeout,
        reason: "timeout",
        expiredReason: "timeout",
      }),
    ]);
  });

  it("treats explicit zero timeout as infinite until user resolution", async () => {
    vi.useFakeTimers();
    let now = 3_000;
    const queue = new ApprovalQueue({
      defaultTimeoutMs: 20,
      resolvedRetentionMs: 1_000,
      now: () => now,
    });

    const waiting = queue.waitForApproval(
      "approval_infinite",
      "run_infinite",
      {
        toolName: "write_file",
        input: { path: "b.txt" },
        summary: "write b.txt",
      },
      { timeoutMs: 0 }
    );

    expect(queue.getPendingApprovals()[0]).toMatchObject({
      status: "pending",
      timeoutMs: null,
      expiresAt: null,
      remainingMs: null,
    });

    now = 4_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queue.getStatus("approval_infinite")).toBe("pending");

    expect(queue.resolve("approval_infinite", "denied")).toBe(true);
    await expect(waiting).resolves.toMatchObject({
      decision: "denied",
      reason: "user-denied",
      timeoutMs: null,
      expiresAt: null,
      resolvedAt: 4_000,
    });
  });

  it("clamps finite timeouts to MIN/MAX bounds", () => {
    expect(normalizeTimeoutMs(50, DEFAULT_APPROVAL_TIMEOUT_MS)).toBe(MIN_APPROVAL_TIMEOUT_MS);
    expect(normalizeTimeoutMs(MAX_APPROVAL_TIMEOUT_MS + 10_000, null)).toBe(
      MAX_APPROVAL_TIMEOUT_MS
    );
    expect(normalizeTimeoutMs(0, 5_000)).toBe(null);
    expect(normalizeTimeoutMs(Number.POSITIVE_INFINITY, 5_000)).toBe(null);
    expect(normalizeTimeoutMs(-1, DEFAULT_APPROVAL_TIMEOUT_MS)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
  });

  it("extends pending approval deadline and re-arms the timer", async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const queue = new ApprovalQueue({
      defaultTimeoutMs: MIN_APPROVAL_TIMEOUT_MS,
      resolvedRetentionMs: 5_000,
      now: () => now,
    });

    const waiting = queue.waitForApproval("approval_extend", "run_extend", {
      toolName: "edit",
      input: { path: "c.ts" },
      summary: "edit c.ts",
    });

    now = 10_500;
    const extended = queue.extendTimeout("approval_extend", 30_000);
    expect(extended).toMatchObject({
      toolCallId: "approval_extend",
      status: "pending",
      timeoutMs: Math.max(0, MIN_APPROVAL_TIMEOUT_MS - 500) + 30_000 >= MIN_APPROVAL_TIMEOUT_MS
        ? expect.any(Number)
        : expect.any(Number),
    });
    expect(extended!.remainingMs).toBeGreaterThan(25_000);
    expect(extended!.expiresAt).toBe(now + extended!.timeoutMs!);

    // Original window would have expired; extension keeps it pending.
    now = 10_000 + MIN_APPROVAL_TIMEOUT_MS + 100;
    await vi.advanceTimersByTimeAsync(MIN_APPROVAL_TIMEOUT_MS + 100);
    expect(queue.getStatus("approval_extend")).toBe("pending");

    now = extended!.expiresAt!;
    await vi.advanceTimersByTimeAsync(extended!.timeoutMs!);
    await expect(waiting).resolves.toMatchObject({
      decision: "expired",
      reason: "timeout",
    });
  });

  it("clearRun auto-denies only matching run and drops scopes for denials", async () => {
    vi.useFakeTimers();
    let now = 20_000;
    const queue = new ApprovalQueue({
      defaultTimeoutMs: 0,
      now: () => now,
    });

    const a = queue.waitForApproval("a1", "run_a", {
      toolName: "edit",
      input: {},
      summary: "a",
    });
    const b = queue.waitForApproval("b1", "run_b", {
      toolName: "edit",
      input: {},
      summary: "b",
    });

    queue.clearRun("run_a", "run-cancelled");
    await expect(a).resolves.toMatchObject({
      decision: "denied",
      reason: "run-cancelled",
    });
    expect(queue.getStatus("b1")).toBe("pending");
    expect(queue.resolve("b1", "approved", "always")).toBe(true);
    expect(queue.consumeScope("b1")).toBe("always");
    await expect(b).resolves.toMatchObject({ decision: "approved" });
  });

  it("configure updates default timeout and retention", () => {
    const queue = new ApprovalQueue({ defaultTimeoutMs: 5_000 });
    expect(queue.getDefaultTimeoutMs()).toBe(Math.max(MIN_APPROVAL_TIMEOUT_MS, 5_000));
    queue.configure({ defaultTimeoutMs: 0, resolvedRetentionMs: 2_000 });
    expect(queue.getDefaultTimeoutMs()).toBe(null);
    expect(queue.getResolvedRetentionMs()).toBe(2_000);
  });

  it("returns false for resolve of unknown or already settled id", async () => {
    const queue = new ApprovalQueue({ defaultTimeoutMs: 0 });
    expect(queue.resolve("missing", "approved")).toBe(false);
    const waiting = queue.waitForApproval("once", "run", {
      toolName: "t",
      input: {},
      summary: "s",
    });
    expect(queue.resolve("once", "denied")).toBe(true);
    await waiting;
    expect(queue.resolve("once", "approved")).toBe(false);
  });
});
