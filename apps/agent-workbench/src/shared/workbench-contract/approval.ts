import type { JsonObject } from "@crish/shared-types";
import {
  isWorkbenchRecord,
  stringFromRecord,
  firstStringValue,
} from "./guards";

export type WorkbenchApprovalRiskLevel = "low" | "medium" | "high" | "unknown";
export type WorkbenchApprovalMetadataSource = "backend" | "unknown";

export interface WorkbenchApprovalMetadata {
  riskLevel: WorkbenchApprovalRiskLevel;
  source: WorkbenchApprovalMetadataSource;
  risk?: string;
  reason?: string;
  riskRule?: string;
  riskDetail?: string;
  matched?: string;
  checkpointId?: string;
  snapshotId?: string;
  recommendSnapshot?: boolean;
  requiresDoubleConfirm?: boolean;
  raw?: JsonObject;
}

export interface WorkbenchNormalizedApprovalRequest {
  id: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  summary: string;
  metadata: WorkbenchApprovalMetadata;
}

export interface WorkbenchNormalizedEvent {
  type: string;
  approvalId?: string;
  requestId?: string;
  toolCallId?: string;
  request?: WorkbenchNormalizedApprovalRequest;
  approvalDecision?: "approved" | "denied";
  [key: string]: unknown;
}

export function normalizeWorkbenchEvent(input: unknown): WorkbenchNormalizedEvent {
  const record = isWorkbenchRecord(input) ? input : {};
  const type = typeof record.type === "string" ? record.type : "";
  const nestedEvent = isWorkbenchRecord(record.event) ? normalizeWorkbenchEvent(record.event) : undefined;
  const normalized: WorkbenchNormalizedEvent = {
    ...record,
    type,
    ...(nestedEvent ? { event: nestedEvent } : {})
  };

  if (type === "approval-requested") {
    const request = normalizeWorkbenchApprovalRequest(record);
    if (request) {
      const approvalId = approvalIdFromEvent({ ...record, request }) ?? request.toolCallId ?? request.id;
      normalized.approvalId = approvalId;
      normalized.requestId = approvalId;
      normalized.toolCallId = approvalId;
      normalized.request = {
        ...request,
        id: approvalId,
        toolCallId: approvalId,
      };
    }
  }

  if (type === "approval-resolved") {
    const approvalId = approvalIdFromEvent(record);
    if (approvalId) {
      normalized.approvalId = approvalId;
      normalized.requestId = approvalId;
      normalized.toolCallId = approvalId;
    }
    const decision = normalizeApprovalDecision(record.decision ?? record.approvalDecision);
    if (decision) normalized.approvalDecision = decision;
  }

  return normalized;
}

export function approvalIdFromEvent(input: unknown): string | undefined {
  const record = isWorkbenchRecord(input) ? input : {};
  const nestedEvent = isWorkbenchRecord(record.event) ? record.event : undefined;
  const directRequest = isWorkbenchRecord(record.request) ? record.request : undefined;
  const nestedRequest = isWorkbenchRecord(nestedEvent?.request) ? nestedEvent.request : undefined;
  const records = [record, nestedEvent].filter(isWorkbenchRecord);
  const requests = [directRequest, nestedRequest].filter(isWorkbenchRecord);

  const toolCallId = firstStringValue(
    ...records.map((item) => stringFromRecord(item, "toolCallId")),
    ...requests.map((item) => stringFromRecord(item, "toolCallId"))
  );
  if (toolCallId) return toolCallId;

  const approvalId = firstStringValue(...records.map((item) => stringFromRecord(item, "approvalId")));
  if (approvalId) return approvalId;

  const requestId = firstStringValue(
    ...records.map((item) => stringFromRecord(item, "requestId")),
    ...requests.map((item) => stringFromRecord(item, "requestId"))
  );
  if (requestId) return requestId;

  const requestObjectId = firstStringValue(...requests.map((item) => stringFromRecord(item, "id")));
  if (requestObjectId) return requestObjectId;

  const directRequestLikeId =
    !directRequest && !nestedEvent && !stringFromRecord(record, "type")
      ? stringFromRecord(record, "id")
      : undefined;
  if (directRequestLikeId) return directRequestLikeId;

  return undefined;
}

export function normalizeWorkbenchApprovalMetadata(
  input: unknown,
  fallbackReason?: string,
  fallbackSource?: WorkbenchApprovalMetadataSource
): WorkbenchApprovalMetadata {
  const metadata = isWorkbenchRecord(input) ? input : undefined;
  const declaredSource = stringFromRecord(metadata, "source");
  const diagnosticSource = declaredSource === "local" || declaredSource === "diagnostic";
  const hasBackendRiskFacts = !diagnosticSource && (hasBackendApprovalRiskMetadata(metadata) || !!fallbackReason);
  const source = hasBackendRiskFacts ? approvalMetadataSourceFromInput(metadata) ?? fallbackSource ?? "backend" : "unknown";
  const rawRisk = stringFromRecord(metadata, "risk");
  const backendRisk =
    stringFromRecord(metadata, "riskLevel") ??
    rawRisk ??
    stringFromRecord(metadata, "severity");
  const reason = stringFromRecord(metadata, "reason") ?? fallbackReason;
  const detail = stringFromRecord(metadata, "detail") ?? stringFromRecord(metadata, "riskDetail") ?? reason;
  const checkpoint = isWorkbenchRecord(metadata?.checkpoint) ? metadata?.checkpoint : undefined;
  const snapshot = isWorkbenchRecord(metadata?.snapshot) ? metadata?.snapshot : undefined;
  const checkpointId = firstStringValue(
    stringFromRecord(metadata, "checkpointId"),
    stringFromRecord(checkpoint, "id"),
    stringFromRecord(checkpoint, "checkpointId")
  );
  const snapshotId = firstStringValue(
    stringFromRecord(metadata, "snapshotId"),
    stringFromRecord(snapshot, "id"),
    stringFromRecord(snapshot, "snapshotId"),
    stringFromRecord(metadata, "snapshotPath"),
    stringFromRecord(snapshot, "path")
  );
  const requiresDoubleConfirm =
    typeof metadata?.requiresDoubleConfirm === "boolean"
      ? metadata.requiresDoubleConfirm
      : stringFromRecord(metadata, "confirmation") === "double"
        ? true
        : stringFromRecord(metadata, "confirmation") === "single"
          ? false
          : undefined;
  const rule =
    stringFromRecord(metadata, "riskRule") ??
    stringFromRecord(metadata, "rule") ??
    riskRuleFromBackendRisk(backendRisk);
  const raw = isWorkbenchRecord(metadata?.raw) ? metadata.raw : metadata;

  return {
    riskLevel: hasBackendRiskFacts ? approvalRiskLevelFromBackend(backendRisk) : "unknown",
    source,
    ...(hasBackendRiskFacts && rawRisk ? { risk: rawRisk } : {}),
    ...(hasBackendRiskFacts && reason ? { reason } : {}),
    ...(hasBackendRiskFacts && rule ? { riskRule: rule } : {}),
    ...(hasBackendRiskFacts && detail ? { riskDetail: detail } : {}),
    ...(hasBackendRiskFacts && stringFromRecord(metadata, "matched") ? { matched: stringFromRecord(metadata, "matched") as string } : {}),
    ...(hasBackendRiskFacts && checkpointId ? { checkpointId } : {}),
    ...(hasBackendRiskFacts && snapshotId ? { snapshotId } : {}),
    ...(hasBackendRiskFacts && typeof metadata?.recommendSnapshot === "boolean" ? { recommendSnapshot: metadata.recommendSnapshot } : {}),
    ...(hasBackendRiskFacts && requiresDoubleConfirm !== undefined ? { requiresDoubleConfirm } : {}),
    ...(raw ? { raw: raw as JsonObject } : {})
  };
}

function normalizeWorkbenchApprovalRequest(record: Record<string, unknown>): WorkbenchNormalizedApprovalRequest | undefined {
  const source = isWorkbenchRecord(record.request) ? record.request : record;
  const tool = isWorkbenchRecord(source.tool) ? source.tool : undefined;
  const id =
    stringFromRecord(source, "id") ??
    stringFromRecord(source, "requestId") ??
    stringFromRecord(record, "requestId") ??
    stringFromRecord(source, "toolCallId") ??
    stringFromRecord(record, "toolCallId");
  if (!id) return undefined;

  const summary = stringFromRecord(source, "summary") ?? stringFromRecord(record, "summary") ?? "";
  const metadataInput = source.metadata ?? record.metadata;
  const reason = stringFromRecord(source, "reason") ?? stringFromRecord(record, "reason");

  return {
    id,
    toolCallId: stringFromRecord(source, "toolCallId") ?? stringFromRecord(record, "toolCallId") ?? id,
    toolName: stringFromRecord(source, "toolName") ?? stringFromRecord(record, "toolName") ?? stringFromRecord(tool, "name") ?? "unknown",
    input: source.input ?? record.input ?? summary,
    summary,
    metadata: normalizeWorkbenchApprovalMetadata(metadataInput, reason, metadataInput === undefined && !reason ? "unknown" : "backend")
  };
}

function normalizeApprovalDecision(value: unknown): "approved" | "denied" | undefined {
  if (value === "approved" || value === "allow") return "approved";
  if (value === "denied" || value === "deny") return "denied";
  if (!isWorkbenchRecord(value)) return undefined;
  if (value.behavior === "allow") return "approved";
  if (value.behavior === "deny") return "denied";
  return undefined;
}

function approvalMetadataSourceFromInput(
  metadata: Record<string, unknown> | undefined
): WorkbenchApprovalMetadataSource | undefined {
  const source = stringFromRecord(metadata, "source");
  return source === "backend" || source === "unknown" ? source : undefined;
}

function hasBackendApprovalRiskMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return (
    stringFromRecord(metadata, "riskLevel") !== undefined ||
    stringFromRecord(metadata, "risk") !== undefined ||
    stringFromRecord(metadata, "severity") !== undefined ||
    stringFromRecord(metadata, "riskRule") !== undefined ||
    stringFromRecord(metadata, "rule") !== undefined ||
    stringFromRecord(metadata, "reason") !== undefined ||
    stringFromRecord(metadata, "detail") !== undefined ||
    stringFromRecord(metadata, "riskDetail") !== undefined ||
    stringFromRecord(metadata, "matched") !== undefined ||
    typeof metadata.recommendSnapshot === "boolean" ||
    typeof metadata.requiresDoubleConfirm === "boolean" ||
    stringFromRecord(metadata, "confirmation") !== undefined ||
    stringFromRecord(metadata, "checkpointId") !== undefined ||
    stringFromRecord(metadata, "snapshotId") !== undefined ||
    isWorkbenchRecord(metadata.checkpoint) ||
    isWorkbenchRecord(metadata.snapshot)
  );
}

function approvalRiskLevelFromBackend(value: string | undefined): WorkbenchApprovalRiskLevel {
  const risk = value?.trim().toLowerCase();
  if (risk === "low" || risk === "medium" || risk === "high" || risk === "unknown") return risk;
  if (risk === "read" || risk === "safe-read") return "low";
  if (risk === "write" || risk === "network" || risk === "process" || risk === "external-side-effect" || risk === "moderate") {
    return "medium";
  }
  if (risk === "destructive" || risk === "secret" || risk === "hardline" || risk === "critical") return "high";
  return "unknown";
}

function riskRuleFromBackendRisk(value: string | undefined): string | undefined {
  const risk = value?.trim();
  if (!risk) return undefined;
  const normalized = risk.toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "unknown") return undefined;
  return risk;
}
