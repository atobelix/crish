import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../approval-queue";
import { handleApproveTool, handleDenyTool } from "./approval-handlers";

describe("approval handlers late resolve", () => {
  it("broadcasts approved with reason and rejects late approve with error", async () => {
    const queue = new ApprovalQueue({ defaultTimeoutMs: 0 });
    const waiting = queue.waitForApproval("tc1", "run1", {
      toolName: "edit",
      input: {},
      summary: "edit",
    });
    const broadcast = vi.fn();
    const sendError = vi.fn();
    const transport = {
      send: vi.fn(),
      broadcast,
      sendError,
    };
    const ws = {} as never;

    handleApproveTool({ type: "approve-tool", toolCallId: "tc1", scope: "project" }, queue, transport, ws);
    await expect(waiting).resolves.toMatchObject({ decision: "approved" });
    expect(broadcast).toHaveBeenCalledWith({
      type: "approval-resolved",
      toolCallId: "tc1",
      decision: "approved",
      reason: "user-approved",
    });

    handleApproveTool({ type: "approve-tool", toolCallId: "tc1" }, queue, transport, ws);
    expect(sendError).toHaveBeenCalledWith(
      ws,
      "APPROVAL_NOT_PENDING",
      expect.stringContaining("No pending approval"),
    );
  });

  it("reports APPROVAL_EXPIRED on late deny after timeout", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const queue = new ApprovalQueue({
      defaultTimeoutMs: 1_000,
      now: () => now,
    });
    const waiting = queue.waitForApproval("tc_exp", "run_exp", {
      toolName: "edit",
      input: {},
      summary: "edit",
    });
    now = 2_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;

    const sendError = vi.fn();
    handleDenyTool(
      { type: "deny-tool", toolCallId: "tc_exp" },
      queue,
      { send: vi.fn(), broadcast: vi.fn(), sendError },
      {} as never
    );
    expect(sendError).toHaveBeenCalledWith(
      {} as never,
      "APPROVAL_EXPIRED",
      expect.stringContaining("already expired"),
    );
    vi.useRealTimers();
  });
});
