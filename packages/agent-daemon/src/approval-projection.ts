import type { JsonObject } from "@crish/shared-types";
import type { ApprovalQueueSnapshot } from "./approval-queue.js";
import type { ApprovalStatusSnapshot } from "./types.js";

export function approvalStatusSnapshot(snapshot: ApprovalQueueSnapshot): ApprovalStatusSnapshot {
  const riskFields = approvalRiskFields(snapshot.metadata?.metadata as JsonObject | undefined);
  return {
    toolCallId: snapshot.toolCallId,
    runId: snapshot.runId,
    toolName: snapshot.metadata?.toolName ?? "unknown",
    summary: snapshot.metadata?.summary ?? "",
    createdAt: snapshot.createdAt,
    status: snapshot.status,
    timeoutMs: snapshot.timeoutMs,
    expiresAt: snapshot.expiresAt,
    remainingMs: snapshot.remainingMs,
    ...(snapshot.resolvedAt !== undefined ? { resolvedAt: snapshot.resolvedAt } : {}),
    ...(snapshot.expiredAt !== undefined ? { expiredAt: snapshot.expiredAt } : {}),
    ...(snapshot.reason !== undefined ? { reason: snapshot.reason } : {}),
    ...(snapshot.expiredReason !== undefined ? { expiredReason: snapshot.expiredReason } : {}),
    ...riskFields,
  };
}

export function approvalRiskFields(metadata: JsonObject | undefined): Pick<
  ApprovalStatusSnapshot,
  "risk" | "riskReason" | "requiresDoubleConfirm" | "recommendSnapshot" | "metadata"
> {
  if (!metadata) return {};
  return {
    ...(typeof metadata.risk === "string" ? { risk: metadata.risk } : {}),
    ...(typeof metadata.reason === "string" ? { riskReason: metadata.reason } : {}),
    ...(typeof metadata.requiresDoubleConfirm === "boolean"
      ? { requiresDoubleConfirm: metadata.requiresDoubleConfirm }
      : {}),
    ...(typeof metadata.recommendSnapshot === "boolean" ? { recommendSnapshot: metadata.recommendSnapshot } : {}),
    metadata,
  };
}
