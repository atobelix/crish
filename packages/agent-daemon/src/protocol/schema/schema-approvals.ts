/**
 * Protocol schema — approval domain validators.
 *
 * Extracted from schema.ts.
 */
import type { JsonObject } from "@crish/shared-types";
import type {
  ApproveToolMessage,
  ApprovalHistoryListedMessage,
  ApprovalRequestedMessage,
  ApprovalResolvedMessage,
  DenyToolMessage,
  ListApprovalHistoryMessage,
} from "../../types.js";
import {
  type ProtocolValidationIssue,
  type ProtocolValidationResult,
  type UnknownRecord,
  invalid,
  isRecord,
  ok,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalApprovalProtocolStatus,
  optionalString,
  rejectUnknownFields,
  requiredApprovalProtocolStatus,
  requiredArray,
  requiredBoolean,
  requiredEnum,
  requiredEventLogMetadata,
  requiredInteger,
  requiredNullableInteger,
  requiredRecord,
  requiredString,
} from "./schema-core.js";
import {
  APPROVAL_HISTORY_DIAGNOSTICS_FIELDS,
  APPROVAL_HISTORY_ENTRY_FIELDS,
  APPROVAL_HISTORY_FILTERS_FIELDS,
  APPROVAL_HISTORY_LISTED_FIELDS,
  APPROVAL_REQUESTED_FIELDS,
  APPROVAL_RESOLVED_FIELDS,
  APPROVE_TOOL_FIELDS,
  DENY_TOOL_FIELDS,
  LIST_APPROVAL_HISTORY_FIELDS,
} from "./schema-fields.js";

export function validateApproveToolMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApproveToolMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPROVE_TOOL_FIELDS, issues);

  const toolCallId = requiredString(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );
  const scope = optionalEnum(
    input,
    "scope",
    "$.scope",
    ["project", "always"],
    issues
  );

  if (issues.length > 0) return invalid("Invalid approve-tool message", issues);

  return ok({
    type: "approve-tool",
    toolCallId: toolCallId as string,
    ...(scope !== undefined ? { scope } : {}),
  });
}

export function validateDenyToolMessage(
  input: UnknownRecord
): ProtocolValidationResult<DenyToolMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DENY_TOOL_FIELDS, issues);

  const toolCallId = requiredString(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );

  if (issues.length > 0) return invalid("Invalid deny-tool message", issues);

  return ok({ type: "deny-tool", toolCallId: toolCallId as string });
}

export function validateApprovalRequestedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApprovalRequestedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPROVAL_REQUESTED_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const toolCallId = requiredString(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );
  const toolName = requiredString(input, "toolName", "$.toolName", issues, {
    nonEmpty: true,
  });
  const inputObject = requiredRecord(input, "input", "$.input", issues);
  const summary = requiredString(input, "summary", "$.summary", issues);
  const timeoutMs = requiredNullableInteger(
    input,
    "timeoutMs",
    "$.timeoutMs",
    issues,
    { min: 0 }
  );
  const expiresAt = requiredNullableInteger(
    input,
    "expiresAt",
    "$.expiresAt",
    issues,
    { min: 0 }
  );
  const remainingMs = requiredNullableInteger(
    input,
    "remainingMs",
    "$.remainingMs",
    issues,
    { min: 0 }
  );
  const risk = optionalString(input, "risk", "$.risk", issues);
  const riskReason = optionalString(input, "riskReason", "$.riskReason", issues);
  const requiresDoubleConfirm = optionalBoolean(
    input,
    "requiresDoubleConfirm",
    "$.requiresDoubleConfirm",
    issues
  );
  const recommendSnapshot = optionalBoolean(
    input,
    "recommendSnapshot",
    "$.recommendSnapshot",
    issues
  );
  if ("metadata" in input && !isRecord(input.metadata)) {
    issues.push({ path: "$.metadata", message: "Expected object" });
  }

  if (issues.length > 0) {
    return invalid("Invalid approval-requested message", issues);
  }

  return ok({
    type: "approval-requested",
    runId: runId as string,
    toolCallId: toolCallId as string,
    toolName: toolName as string,
    input: inputObject as Record<string, unknown>,
    summary: summary as string,
    timeoutMs: timeoutMs as number | null,
    expiresAt: expiresAt as number | null,
    remainingMs: remainingMs as number | null,
    ...(risk !== undefined ? { risk } : {}),
    ...(riskReason !== undefined ? { riskReason } : {}),
    ...(requiresDoubleConfirm !== undefined ? { requiresDoubleConfirm } : {}),
    ...(recommendSnapshot !== undefined ? { recommendSnapshot } : {}),
    ...(isRecord(input.metadata) ? { metadata: input.metadata as JsonObject } : {}),
  });
}

export function validateApprovalResolvedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApprovalResolvedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPROVAL_RESOLVED_FIELDS, issues);

  const toolCallId = requiredString(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );
  const decision = requiredEnum(
    input,
    "decision",
    "$.decision",
    ["approved", "denied", "expired"],
    issues
  );
  const reason = optionalString(input, "reason", "$.reason", issues);
  const expiredAt = optionalInteger(input, "expiredAt", "$.expiredAt", issues, {
    min: 0,
  });

  if (issues.length > 0) {
    return invalid("Invalid approval-resolved message", issues);
  }

  return ok({
    type: "approval-resolved",
    toolCallId: toolCallId as string,
    decision: decision as ApprovalResolvedMessage["decision"],
    ...(reason !== undefined ? { reason } : {}),
    ...(expiredAt !== undefined ? { expiredAt } : {}),
  });
}

export function validateListApprovalHistoryMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListApprovalHistoryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_APPROVAL_HISTORY_FIELDS, issues);

  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const toolName = optionalString(input, "toolName", "$.toolName", issues, {
    nonEmpty: true,
  });
  const status = optionalApprovalProtocolStatus(input, "status", "$.status", issues);
  const decision = optionalApprovalProtocolStatus(input, "decision", "$.decision", issues);
  const risk = optionalString(input, "risk", "$.risk", issues, { nonEmpty: true });
  const limit = optionalInteger(input, "limit", "$.limit", issues, { min: 1 });

  if (issues.length > 0) return invalid("Invalid list-approval-history message", issues);

  return ok({
    type: "list-approval-history",
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(decision !== undefined ? { decision } : {}),
    ...(risk !== undefined ? { risk } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
}

export function validateApprovalHistoryListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApprovalHistoryListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPROVAL_HISTORY_LISTED_FIELDS, issues);

  const approvals = requiredArray(input, "approvals", "$.approvals", issues);
  const eventLog = requiredEventLogMetadata(input, "eventLog", "$.eventLog", issues);
  const filters = requiredRecord(input, "filters", "$.filters", issues);
  const total = requiredInteger(input, "total", "$.total", issues, { min: 0 });
  const returned = requiredInteger(input, "returned", "$.returned", issues, { min: 0 });
  const truncated = requiredBoolean(input, "truncated", "$.truncated", issues);
  const diagnostics = requiredRecord(input, "diagnostics", "$.diagnostics", issues);

  approvals?.forEach((approval, index) =>
    validateApprovalHistoryEntry(approval, `$.approvals[${index}]`, issues)
  );
  if (filters) validateApprovalHistoryFilters(filters, "$.filters", issues);
  if (diagnostics) validateApprovalHistoryDiagnostics(diagnostics, "$.diagnostics", issues);

  if (issues.length > 0) return invalid("Invalid approval-history-listed message", issues);

  return ok({
    type: "approval-history-listed",
    approvals: approvals as ApprovalHistoryListedMessage["approvals"],
    eventLog: eventLog as ApprovalHistoryListedMessage["eventLog"],
    filters: filters as ApprovalHistoryListedMessage["filters"],
    total: total as number,
    returned: returned as number,
    truncated: truncated as boolean,
    diagnostics: diagnostics as unknown as ApprovalHistoryListedMessage["diagnostics"],
  });
}

export function validateApprovalHistoryFilters(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, APPROVAL_HISTORY_FILTERS_FIELDS, issues, path);
  if ("sessionId" in value) optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("runId" in value) optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  if ("toolName" in value) optionalString(value, "toolName", `${path}.toolName`, issues, { nonEmpty: true });
  if ("status" in value) optionalApprovalProtocolStatus(value, "status", `${path}.status`, issues);
  if ("risk" in value) optionalString(value, "risk", `${path}.risk`, issues, { nonEmpty: true });
}

export function validateApprovalHistoryEntry(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, APPROVAL_HISTORY_ENTRY_FIELDS, issues, path);
  requiredString(value, "toolCallId", `${path}.toolCallId`, issues, { nonEmpty: true });
  requiredString(value, "runId", `${path}.runId`, issues);
  if ("sessionId" in value) optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString(value, "toolName", `${path}.toolName`, issues, { nonEmpty: true });
  requiredString(value, "summary", `${path}.summary`, issues);
  requiredRecord(value, "input", `${path}.input`, issues);
  requiredInteger(value, "createdAt", `${path}.createdAt`, issues, { min: 0 });
  requiredApprovalProtocolStatus(value, "status", `${path}.status`, issues);
  requiredNullableInteger(value, "timeoutMs", `${path}.timeoutMs`, issues, { min: 0 });
  requiredNullableInteger(value, "expiresAt", `${path}.expiresAt`, issues, { min: 0 });
  requiredNullableInteger(value, "remainingMs", `${path}.remainingMs`, issues, { min: 0 });
  if ("resolvedAt" in value) optionalInteger(value, "resolvedAt", `${path}.resolvedAt`, issues, { min: 0 });
  if ("expiredAt" in value) optionalInteger(value, "expiredAt", `${path}.expiredAt`, issues, { min: 0 });
  if ("reason" in value) optionalString(value, "reason", `${path}.reason`, issues);
  if ("expiredReason" in value) optionalString(value, "expiredReason", `${path}.expiredReason`, issues);
  if ("risk" in value) optionalString(value, "risk", `${path}.risk`, issues);
  if ("riskReason" in value) optionalString(value, "riskReason", `${path}.riskReason`, issues);
  if ("requiresDoubleConfirm" in value) {
    optionalBoolean(value, "requiresDoubleConfirm", `${path}.requiresDoubleConfirm`, issues);
  }
  if ("recommendSnapshot" in value) {
    optionalBoolean(value, "recommendSnapshot", `${path}.recommendSnapshot`, issues);
  }
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
  if ("requestSequence" in value) {
    optionalInteger(value, "requestSequence", `${path}.requestSequence`, issues, { min: 0 });
  }
  if ("resolvedSequence" in value) {
    optionalInteger(value, "resolvedSequence", `${path}.resolvedSequence`, issues, { min: 0 });
  }
  requiredEnum(value, "source", `${path}.source`, ["event-log", "live-queue"], issues);
  if ("live" in value) optionalBoolean(value, "live", `${path}.live`, issues);
  requiredInteger(value, "updatedAt", `${path}.updatedAt`, issues, { min: 0 });
}

export function validateApprovalHistoryDiagnostics(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, APPROVAL_HISTORY_DIAGNOSTICS_FIELDS, issues, path);
  requiredInteger(value, "queryMs", `${path}.queryMs`, issues, { min: 0 });
  requiredInteger(value, "eventCount", `${path}.eventCount`, issues, { min: 0 });
  requiredInteger(value, "projectedCount", `${path}.projectedCount`, issues, { min: 0 });
  requiredInteger(value, "liveOverlayCount", `${path}.liveOverlayCount`, issues, { min: 0 });
  requiredInteger(value, "filteredOutCount", `${path}.filteredOutCount`, issues, { min: 0 });
  requiredInteger(value, "limit", `${path}.limit`, issues, { min: 1 });
  requiredBoolean(value, "truncated", `${path}.truncated`, issues);
}
