import { getDaemonLogger } from "../daemon-logger.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

export interface PendingApproval {
  runId: string;
  toolCallId: string;
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  createdAt: number;
}

export interface ApprovalDecision {
  approved: boolean;
  reason: string | undefined;
}

export class ApprovalBridge {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  createPending(
    runId: string,
    toolCallId: string,
  ): Promise<ApprovalDecision> {
    const key = `${runId}:${toolCallId}`;

    return new Promise<ApprovalDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(key);
        getDaemonLogger().warn("Approval timed out, auto-denying", {
          module: "approval-bridge",
          runId,
          toolCallId,
        });
        resolve({ approved: false, reason: "Timed out" });
      }, this.defaultTimeoutMs);
      timer.unref?.();

      this.pendingApprovals.set(key, {
        runId,
        toolCallId,
        resolve,
        reject,
        timer,
        createdAt: Date.now(),
      });
    });
  }

  resolve(runId: string, toolCallId: string, approved: boolean, reason?: string): boolean {
    const key = `${runId}:${toolCallId}`;
    const pending = this.pendingApprovals.get(key);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingApprovals.delete(key);
    pending.resolve({ approved, reason });
    return true;
  }

  rejectAll(runId: string, reason: string): void {
    for (const [key, pending] of this.pendingApprovals.entries()) {
      if (pending.runId === runId) {
        clearTimeout(pending.timer);
        this.pendingApprovals.delete(key);
        pending.resolve({ approved: false, reason });
      }
    }
  }

  rejectAllForDisconnect(reason: string): void {
    for (const [key, pending] of this.pendingApprovals.entries()) {
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(key);
      pending.resolve({ approved: false, reason });
    }
  }

  get pendingCount(): number {
    return this.pendingApprovals.size;
  }

  hasPending(runId: string, toolCallId: string): boolean {
    return this.pendingApprovals.has(`${runId}:${toolCallId}`);
  }
}
