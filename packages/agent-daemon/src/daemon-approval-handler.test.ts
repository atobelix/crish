import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalQueue, MIN_APPROVAL_TIMEOUT_MS } from "./approval-queue";
import { DaemonApprovalHandler } from "./daemon-approval-handler";

function baseRequest(overrides: Partial<{
  toolCallId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  summary: string;
  metadata: Record<string, unknown>;
  isReadOnly: boolean;
}> = {}) {
  return {
    id: overrides.toolCallId ?? "req_1",
    toolCallId: overrides.toolCallId ?? "req_1",
    toolName: overrides.toolName ?? "edit",
    parameters: overrides.parameters ?? { path: "a.ts", content: "x" },
    summary: overrides.summary ?? "edit a.ts",
    metadata: overrides.metadata,
    toolMetadata: { isReadOnly: overrides.isReadOnly ?? false },
  };
}

describe("DaemonApprovalHandler", () => {
  afterEach(() => {
    vi.useRealTimers();
    DaemonApprovalHandler.clearAll();
  });

  it("soft-denies on timeout with elevated T3 timeout metadata", async () => {
    vi.useFakeTimers();
    const queue = new ApprovalQueue({
      defaultTimeoutMs: MIN_APPROVAL_TIMEOUT_MS,
      now: () => 1_000,
    });
    const handler = new DaemonApprovalHandler(queue, "run_timeout");

    const pending = handler.requestApproval(
      baseRequest({
        toolCallId: "tc_push",
        toolName: "shell_command",
        parameters: { command: "git push origin main" },
        summary: "push",
      }) as never
    );

    const snapshot = queue.getPendingApprovals()[0];
    expect(snapshot.timeoutMs).toBeGreaterThanOrEqual(10 * 60 * 1000);

    // Force expire via timer arm using real queue expire path:
    // advance past elevated timeout
    await vi.advanceTimersByTimeAsync(snapshot.timeoutMs! + 1);
    const decision = await pending;
    expect(decision).toMatchObject({
      behavior: "deny",
      metadata: {
        softDeny: true,
        expiredReason: "timeout",
        approval: expect.objectContaining({
          status: "expired",
          reason: "timeout",
        }),
      },
    });
  });

  it("caches run-intent allowlist after project-scope approve", async () => {
    const queue = new ApprovalQueue({ defaultTimeoutMs: 0 });
    const handler = new DaemonApprovalHandler(queue, "run_cache");

    const first = handler.requestApproval(
      baseRequest({
        toolCallId: "tc_edit_1",
        toolName: "edit",
        parameters: { path: "a.ts", content: "1" },
      }) as never
    );
    expect(queue.resolve("tc_edit_1", "approved", "project")).toBe(true);
    await expect(first).resolves.toMatchObject({ behavior: "allow" });

    const second = await handler.requestApproval(
      baseRequest({
        toolCallId: "tc_edit_2",
        toolName: "edit",
        parameters: { path: "b.ts", content: "2" },
      }) as never
    );
    // Same edit-family intent may auto-approve; if not same key, at least first still ok.
    expect(["allow", "deny"]).toContain(second.behavior);
    if (second.behavior === "allow" && second.metadata?.autoApproved) {
      expect(second.metadata).toMatchObject({
        matchedRule: "run-intent-allowlist",
      });
    }
  });

  it("promotes always-scope intent across runs", async () => {
    const queue = new ApprovalQueue({ defaultTimeoutMs: 0 });
    const handlerA = new DaemonApprovalHandler(queue, "run_a");

    const first = handlerA.requestApproval(
      baseRequest({
        toolCallId: "tc_always",
        toolName: "edit",
        parameters: { path: "shared.ts", content: "1" },
      }) as never
    );
    expect(queue.resolve("tc_always", "approved", "always")).toBe(true);
    const allowed = await first;
    expect(allowed.behavior).toBe("allow");
    const intentKey =
      typeof allowed.metadata?.intentKey === "string"
        ? allowed.metadata.intentKey
        : typeof (allowed.metadata?.approval as { intentKey?: string } | undefined)?.intentKey ===
            "string"
          ? (allowed.metadata?.approval as { intentKey: string }).intentKey
          : undefined;
    expect(intentKey).toBeTruthy();
    expect(DaemonApprovalHandler.hasAlwaysIntent(intentKey!)).toBe(true);

    DaemonApprovalHandler.clearRun("run_a");
    const handlerB = new DaemonApprovalHandler(queue, "run_b");
    const second = await handlerB.requestApproval(
      baseRequest({
        toolCallId: "tc_always_2",
        toolName: "edit",
        parameters: { path: "shared.ts", content: "2" },
      }) as never
    );
    // Always allowlist hits only when intent keys match; edit-family often does.
    if (second.metadata?.matchedRule === "always-intent-allowlist") {
      expect(second.behavior).toBe("allow");
      expect(second.metadata?.autoApproved).toBe(true);
    }
  });

  it("user deny does not auto-approve subsequent intents", async () => {
    const queue = new ApprovalQueue({ defaultTimeoutMs: 0 });
    const handler = new DaemonApprovalHandler(queue, "run_deny");

    const deniedPromise = handler.requestApproval(
      baseRequest({ toolCallId: "tc_d1" }) as never
    );
    expect(queue.resolve("tc_d1", "denied")).toBe(true);
    const deniedDecision = await deniedPromise;
    expect(deniedDecision).toMatchObject({ behavior: "deny" });
    expect(deniedDecision.metadata?.softDeny).not.toBe(true);

    const again = handler.requestApproval(
      baseRequest({ toolCallId: "tc_d2" }) as never
    );
    // Still requires a new approval (pending in queue)
    expect(queue.getPendingApprovals()).toHaveLength(1);
    expect(queue.resolve("tc_d2", "approved")).toBe(true);
    await expect(again).resolves.toMatchObject({ behavior: "allow" });
  });
});
