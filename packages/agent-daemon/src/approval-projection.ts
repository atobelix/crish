import type { JsonObject } from "@crish/shared-types";
import { isRecord } from "@crish/shared-utils";
import type { ApprovalQueueSnapshot } from "./approval-queue.js";
import type { ApprovalStatusSnapshot } from "./types.js";

/**
 * Pure risk-surface projected for WS status, task snapshots, and bridges (BE-04).
 * Clients should consume these fields rather than re-deriving risk from tool names.
 */
export type ApprovalRiskProjection = Pick<
  ApprovalStatusSnapshot,
  "risk" | "riskReason" | "requiresDoubleConfirm" | "recommendSnapshot" | "metadata"
>;

/**
 * Project an approval-queue snapshot into the daemon status protocol shape.
 * Normalizes tool labels, clamps remaining time for settled approvals, and
 * attaches pure risk fields via {@link approvalRiskFields}.
 */
export function approvalStatusSnapshot(snapshot: ApprovalQueueSnapshot): ApprovalStatusSnapshot {
  const riskFields = approvalRiskFields(nestedApprovalMetadata(snapshot));
  const toolName = readNonEmptyString(snapshot.metadata?.toolName) ?? "unknown";
  const summary =
    typeof snapshot.metadata?.summary === "string" ? snapshot.metadata.summary : "";
  const reason = readNonEmptyString(snapshot.reason);
  const expiredReason = readNonEmptyString(snapshot.expiredReason);

  return {
    toolCallId: snapshot.toolCallId,
    runId: snapshot.runId,
    toolName,
    summary,
    createdAt: snapshot.createdAt,
    status: snapshot.status,
    timeoutMs: snapshot.timeoutMs,
    expiresAt: snapshot.expiresAt,
    remainingMs: projectRemainingMs(snapshot),
    resolvedAt: snapshot.resolvedAt,
    expiredAt: snapshot.expiredAt,
    reason: reason,
    expiredReason: expiredReason,
    ...riskFields,
  };
}

/**
 * Project backend risk facts for WS/status/task snapshot.
 * Prefer explicit flags; otherwise derive from trustZone / hardline so
 * clients never guess risk from tool names (BE-04).
 */
export function approvalRiskFields(metadata: JsonObject | undefined): ApprovalRiskProjection {
  if (!metadata) return { risk: undefined, riskReason: undefined, requiresDoubleConfirm: undefined, recommendSnapshot: undefined, metadata: undefined };

  // Prefer `risk`; fall back to `riskLevel` only when risk is blank/missing.
  const riskRaw =
    readNonEmptyString(metadata.risk) ?? readNonEmptyString(metadata.riskLevel);
  const riskReason =
    readNonEmptyString(metadata.reason) ?? readNonEmptyString(metadata.riskReason);

  const trustZone = readNonEmptyString(metadata.trustZone);
  const intentKey = readNonEmptyString(metadata.intentKey);
  const hardline =
    metadata.hardline === true || trustZone === "T4" || riskRaw === "hardline";

  // When hardline/T4 and risk unset, surface risk="hardline" so clients
  // do not re-derive from tool names (BE-04).
  const risk = riskRaw ?? (hardline ? "hardline" : undefined);

  let requiresDoubleConfirm: boolean | undefined =
    typeof metadata.requiresDoubleConfirm === "boolean"
      ? metadata.requiresDoubleConfirm
      : undefined;
  if (requiresDoubleConfirm === undefined && (hardline || trustZone === "T3" || trustZone === "T4")) {
    requiresDoubleConfirm = true;
  }

  let recommendSnapshot: boolean | undefined =
    typeof metadata.recommendSnapshot === "boolean"
      ? metadata.recommendSnapshot
      : undefined;
  if (
    recommendSnapshot === undefined &&
    (trustZone === "T1" || trustZone === "T3" || trustZone === "T4" || hardline)
  ) {
    recommendSnapshot = true;
  }

  // Preserve trustZone / intentKey / hardline / normalized risk on the nested
  // metadata bag so status clients can render zone badges without re-deriving.
  const projectedMeta: JsonObject = { ...metadata };
  if (trustZone !== undefined) projectedMeta.trustZone = trustZone;
  if (intentKey !== undefined) projectedMeta.intentKey = intentKey;
  if (hardline) projectedMeta.hardline = true;
  if (risk !== undefined) projectedMeta.risk = risk;
  else if ("risk" in projectedMeta && !readNonEmptyString(projectedMeta.risk)) {
    delete projectedMeta.risk;
  }

  return {
    risk: risk,
    riskReason: riskReason,
    requiresDoubleConfirm: requiresDoubleConfirm,
    recommendSnapshot: recommendSnapshot,
    metadata: projectedMeta,
  };
}

function nestedApprovalMetadata(snapshot: ApprovalQueueSnapshot): JsonObject | undefined {
  const nested = snapshot.metadata?.metadata;
  return isRecord(nested) ? (nested as JsonObject) : undefined;
}

/** Trimmed non-empty string; rejects blank / whitespace-only values. */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Pending approvals clamp negative remaining to 0; settled approvals always
 * project 0 remaining (null only when the queue had no timeout).
 */
function projectRemainingMs(snapshot: ApprovalQueueSnapshot): number | null {
  if (snapshot.remainingMs === null) return null;
  if (typeof snapshot.remainingMs !== "number" || !Number.isFinite(snapshot.remainingMs)) {
    return snapshot.status === "pending" ? null : 0;
  }
  if (snapshot.status !== "pending") return 0;
  return Math.max(0, snapshot.remainingMs);
}
