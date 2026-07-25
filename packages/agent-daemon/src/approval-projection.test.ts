import { describe, expect, it } from "vitest";
import { approvalRiskFields, approvalStatusSnapshot } from "./approval-projection";
import type { ApprovalQueueSnapshot } from "./approval-queue";

describe("approvalRiskFields", () => {
  it("passes through explicit backend flags", () => {
    expect(
      approvalRiskFields({
        risk: "destructive",
        reason: "rm",
        requiresDoubleConfirm: true,
        recommendSnapshot: false,
      }),
    ).toMatchObject({
      risk: "destructive",
      riskReason: "rm",
      requiresDoubleConfirm: true,
      recommendSnapshot: false,
    });
  });

  it("derives double-confirm + snapshot from trustZone T3", () => {
    expect(
      approvalRiskFields({
        trustZone: "T3",
        risk: "destructive",
      }),
    ).toMatchObject({
      risk: "destructive",
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      metadata: expect.objectContaining({ trustZone: "T3" }),
    });
  });

  it("derives critical flags from hardline / T4", () => {
    expect(
      approvalRiskFields({
        trustZone: "T4",
        hardline: true,
        risk: "hardline",
        reason: "shutdown",
        intentKey: "T4|hardline|shell|shutdown",
      }),
    ).toMatchObject({
      risk: "hardline",
      riskReason: "shutdown",
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      metadata: expect.objectContaining({
        trustZone: "T4",
        hardline: true,
        intentKey: "T4|hardline|shell|shutdown",
      }),
    });
  });

  it("returns empty object without metadata", () => {
    expect(approvalRiskFields(undefined)).toEqual({});
  });

  it("ignores blank risk/reason strings and falls back to aliases", () => {
    expect(
      approvalRiskFields({
        risk: "   ",
        riskLevel: " network ",
        reason: "",
        riskReason: " package install ",
      }),
    ).toMatchObject({
      risk: "network",
      riskReason: "package install",
    });
  });

  it("surfaces risk=hardline when only hardline flag is set (BE-04)", () => {
    expect(
      approvalRiskFields({
        hardline: true,
        intentKey: "T4|hardline|shell|shutdown",
      }),
    ).toMatchObject({
      risk: "hardline",
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      metadata: expect.objectContaining({
        hardline: true,
        risk: "hardline",
      }),
    });
  });

  it("surfaces risk=hardline for trustZone T4 when risk is unset", () => {
    expect(
      approvalRiskFields({
        trustZone: "T4",
      }),
    ).toMatchObject({
      risk: "hardline",
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      metadata: expect.objectContaining({
        trustZone: "T4",
        hardline: true,
        risk: "hardline",
      }),
    });
  });

  it("keeps explicit risk when hardline/T4 is also true", () => {
    expect(
      approvalRiskFields({
        trustZone: "T4",
        risk: "destructive",
      }),
    ).toMatchObject({
      risk: "destructive",
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      metadata: expect.objectContaining({
        hardline: true,
        risk: "destructive",
      }),
    });
  });

  it("lets explicit false win over trustZone derivation", () => {
    expect(
      approvalRiskFields({
        trustZone: "T3",
        risk: "destructive",
        requiresDoubleConfirm: false,
        recommendSnapshot: false,
      }),
    ).toEqual({
      risk: "destructive",
      requiresDoubleConfirm: false,
      recommendSnapshot: false,
      metadata: {
        trustZone: "T3",
        risk: "destructive",
        requiresDoubleConfirm: false,
        recommendSnapshot: false,
      },
    });
  });

  it("derives recommendSnapshot for T1 without double-confirm", () => {
    expect(
      approvalRiskFields({
        trustZone: "T1",
        risk: "write",
      }),
    ).toMatchObject({
      risk: "write",
      recommendSnapshot: true,
    });
    expect(approvalRiskFields({ trustZone: "T1", risk: "write" }).requiresDoubleConfirm).toBeUndefined();
  });

  it("does not auto-derive double-confirm for T2", () => {
    const projected = approvalRiskFields({
      trustZone: "T2",
      risk: "network",
    });
    expect(projected).toMatchObject({
      risk: "network",
      metadata: expect.objectContaining({ trustZone: "T2" }),
    });
    expect(projected.requiresDoubleConfirm).toBeUndefined();
    expect(projected.recommendSnapshot).toBeUndefined();
  });

  it("strips blank risk from projected metadata bag when no hardline", () => {
    const projected = approvalRiskFields({
      risk: "  ",
      reason: "n/a",
    });
    expect(projected.risk).toBeUndefined();
    expect(projected.riskReason).toBe("n/a");
    expect(projected.metadata).toEqual({ reason: "n/a" });
  });

  it("trims trustZone and intentKey before projecting", () => {
    expect(
      approvalRiskFields({
        trustZone: " T3 ",
        intentKey: "  zone|risk|tool  ",
        risk: "destructive",
      }),
    ).toMatchObject({
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      metadata: expect.objectContaining({
        trustZone: "T3",
        intentKey: "zone|risk|tool",
      }),
    });
  });
});

describe("approvalStatusSnapshot", () => {
  it("projects status snapshot timeout and risk fields", () => {
    const snapshot: ApprovalQueueSnapshot = {
      toolCallId: "tc1",
      runId: "run1",
      status: "pending",
      createdAt: 100,
      timeoutMs: 60_000,
      expiresAt: 60_100,
      remainingMs: 50_000,
      resolvedAt: undefined,
      expiredAt: undefined,
      reason: undefined,
      expiredReason: undefined,
      metadata: {
        toolName: "edit",
        input: { path: "a.ts" },
        summary: "edit a.ts",
        metadata: {
          trustZone: "T1",
          risk: "write",
          intentKey: "T1|write|edit|edit-family",
        },
      },
    };
    expect(approvalStatusSnapshot(snapshot)).toMatchObject({
      toolCallId: "tc1",
      runId: "run1",
      toolName: "edit",
      summary: "edit a.ts",
      status: "pending",
      timeoutMs: 60_000,
      remainingMs: 50_000,
      risk: "write",
      recommendSnapshot: true,
      metadata: expect.objectContaining({
        trustZone: "T1",
        intentKey: "T1|write|edit|edit-family",
      }),
    });
  });

  it("defaults blank toolName to unknown and clamps negative remaining for pending", () => {
    const snapshot: ApprovalQueueSnapshot = {
      toolCallId: "tc2",
      runId: "run2",
      status: "pending",
      createdAt: 1,
      timeoutMs: 1000,
      expiresAt: 1001,
      remainingMs: -5,
      resolvedAt: undefined,
      expiredAt: undefined,
      reason: undefined,
      expiredReason: undefined,
      metadata: {
        toolName: "  ",
        input: {},
        summary: "still here",
      },
    };
    expect(approvalStatusSnapshot(snapshot)).toMatchObject({
      toolName: "unknown",
      summary: "still here",
      remainingMs: 0,
    });
  });

  it("projects settled approval with zero remaining and trims reason fields", () => {
    const snapshot: ApprovalQueueSnapshot = {
      toolCallId: "tc3",
      runId: "run3",
      status: "expired",
      createdAt: 10,
      timeoutMs: 1000,
      expiresAt: 1010,
      remainingMs: 999,
      resolvedAt: 1010,
      expiredAt: 1010,
      reason: "  timeout  ",
      expiredReason: "  timeout  ",
      metadata: {
        toolName: "shell_command",
        input: { command: "npm i" },
        summary: "npm i",
        metadata: {
          hardline: true,
        },
      },
    };
    expect(approvalStatusSnapshot(snapshot)).toMatchObject({
      status: "expired",
      remainingMs: 0,
      resolvedAt: 1010,
      expiredAt: 1010,
      reason: "timeout",
      expiredReason: "timeout",
      risk: "hardline",
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
    });
  });

  it("omits blank reason fields and ignores non-object nested metadata", () => {
    const snapshot: ApprovalQueueSnapshot = {
      toolCallId: "tc4",
      runId: "run4",
      status: "denied",
      createdAt: 1,
      timeoutMs: null,
      expiresAt: null,
      remainingMs: null,
      resolvedAt: 2,
      reason: "   ",
      metadata: {
        toolName: "read",
        input: {},
        summary: "",
        // @ts-expect-error intentional malformed nested metadata
        metadata: "not-an-object",
      },
    };
    const projected = approvalStatusSnapshot(snapshot);
    expect(projected.reason).toBeUndefined();
    expect(projected.expiredReason).toBeUndefined();
    expect(projected.remainingMs).toBeNull();
    expect(projected.risk).toBeUndefined();
    expect(projected.metadata).toBeUndefined();
    expect(projected.summary).toBe("");
  });

  it("preserves infinite-timeout null remaining for pending approvals", () => {
    const snapshot: ApprovalQueueSnapshot = {
      toolCallId: "tc5",
      runId: "run5",
      status: "pending",
      createdAt: 1,
      timeoutMs: null,
      expiresAt: null,
      remainingMs: null,
      resolvedAt: undefined,
      expiredAt: undefined,
      reason: undefined,
      expiredReason: undefined,
      metadata: {
        toolName: "edit",
        input: { path: "b.ts" },
        summary: "edit b.ts",
        metadata: {
          trustZone: "T2",
          risk: "write",
        },
      },
    };
    expect(approvalStatusSnapshot(snapshot)).toMatchObject({
      remainingMs: null,
      timeoutMs: null,
      risk: "write",
    });
    expect(approvalStatusSnapshot(snapshot).requiresDoubleConfirm).toBeUndefined();
  });
});
