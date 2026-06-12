import type { PermissionDecision, PermissionRequest } from "@crish/shared-types";
import { ApprovalQueue } from "./approval-queue.js";

export class DaemonApprovalHandler {
  constructor(
    private readonly approvalQueue: ApprovalQueue,
    private readonly runId?: string,
  ) {}

  async requestApproval(request: PermissionRequest): Promise<PermissionDecision> {
    const result = await this.approvalQueue.waitForApproval(request.toolCallId, this.runId ?? "unknown", {
      toolName: request.toolName,
      input: request.parameters as unknown as Record<string, unknown>,
      summary: request.summary,
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    });

    if (result.decision === "approved") {
      return { behavior: "allow", reason: result.reason ?? "Approved" };
    }
    return { behavior: "deny", reason: result.reason ?? "Denied" };
  }
}
