import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalQueue, DEFAULT_APPROVAL_TIMEOUT_MS } from "./approval-queue";

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

    now = 2_025;
    await vi.advanceTimersByTimeAsync(25);
    expect(queue.getPendingApprovals()[0]).toMatchObject({
      status: "pending",
      timeoutMs: 50,
      expiresAt: 2_050,
      remainingMs: 25,
    });

    now = 2_050;
    await vi.advanceTimersByTimeAsync(25);
    await expect(waiting).resolves.toMatchObject({
      decision: "expired",
      reason: "timeout",
      resolvedAt: 2_050,
      expiredAt: 2_050,
      timeoutMs: 50,
      expiresAt: 2_050,
    });

    expect(queue.getPendingApprovals()).toEqual([]);
    expect(queue.getRecentApprovals()).toEqual([
      expect.objectContaining({
        toolCallId: "approval_expire",
        runId: "run_expire",
        status: "expired",
        resolvedAt: 2_050,
        expiredAt: 2_050,
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
});
