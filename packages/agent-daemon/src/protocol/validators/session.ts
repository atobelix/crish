import {
  SESSION_ACTION_KINDS,
  SESSION_ACTION_PROTOCOL_VERSION,
  SESSION_ACTION_STATUSES,
  SESSION_OPEN_TARGETS,
  type SessionAction,
  type SessionActionKind,
  type SessionActionReceipt,
} from "@crish/shared-types";
import type {
  ApplySessionActionMessage,
  ListSessionsMessage,
  SessionActionReceiptMessage,
  SessionsListedMessage,
} from "../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "./base.js";
import {
  APPLY_SESSION_ACTION_FIELDS,
  LIST_SESSIONS_FIELDS,
  RUN_STATUSES,
  SESSION_ACTION_BASE_FIELDS,
  SESSION_ACTION_CONSISTENCY_FIELDS,
  SESSION_ACTION_RECEIPT_FIELDS,
  SESSION_RECORD_FIELDS,
  SESSION_STATUSES,
  SESSIONS_LISTED_FIELDS,
  SESSION_TREE_ENTRY_FIELDS,
  invalid,
  isJsonObject,
  isRecord,
  ok,
  optionalArray,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  optionalStringArray,
  readNullableString,
  rejectUnknownFields,
  requiredArray,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredRecord,
  requiredString,
  requiredEventLogMetadata,
} from "./base.js";

export function validateListSessionsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListSessionsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_SESSIONS_FIELDS, issues);
  const includeArchived = optionalBoolean(input, "includeArchived", "$.includeArchived", issues);
  const includeDeleted = optionalBoolean(input, "includeDeleted", "$.includeDeleted", issues);

  if (issues.length > 0) return invalid("Invalid list-sessions message", issues);

  return ok({
    type: "list-sessions",
    ...(includeArchived !== undefined ? { includeArchived } : {}),
    ...(includeDeleted !== undefined ? { includeDeleted } : {}),
  });
}

export function validateSessionsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<SessionsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SESSIONS_LISTED_FIELDS, issues);

  const sessions = requiredArray(input, "sessions", "$.sessions", issues);
  const summaries = optionalArray(input, "summaries", "$.summaries", issues);
  const eventLog = "eventLog" in input ? requiredEventLogMetadata(input, "eventLog", "$.eventLog", issues) : undefined;
  if ("diagnostics" in input) {
    validateSessionListDiagnostics(input.diagnostics, "$.diagnostics", issues);
  }
  if (sessions) {
    sessions.forEach((session, index) =>
      validateSessionRecord(session, `$.sessions[${index}]`, issues)
    );
  }
  if (summaries) {
    summaries.forEach((summary, index) =>
      validateSessionSummary(summary, `$.summaries[${index}]`, issues)
    );
  }

  if (issues.length > 0) return invalid("Invalid sessions-listed message", issues);

  return ok({
    type: "sessions-listed" as const,
    sessions: sessions as SessionsListedMessage["sessions"],
    ...(summaries !== undefined ? { summaries: summaries as SessionsListedMessage["summaries"] } : {}),
    ...(eventLog !== undefined ? { eventLog } : {}),
    ...("diagnostics" in input ? { diagnostics: input.diagnostics as SessionsListedMessage["diagnostics"] } : {}),
  } as SessionsListedMessage);
}

export function validateSessionRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SESSION_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "cwd", `${path}.cwd`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  requiredEnum(value, "status", `${path}.status`, SESSION_STATUSES, issues);
  if ("currentLeafId" in value) {
    optionalString(value, "currentLeafId", `${path}.currentLeafId`, issues, {
      nonEmpty: true,
    });
  }
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateSessionSummary(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(
    value,
    [
      "sessionId",
      "lastUpdated",
      "eventCount",
      "runCount",
      "activeRunCount",
      "activeRunIds",
      "latestRunId",
      "latestRunStatus",
      "latestRunUpdatedAt",
      "pendingInputCount",
      "pendingApprovalCount",
      "lastEventId",
      "lastSequence",
      "lastMessagePreview",
      "title",
      "pinned",
      "archived",
      "deleted",
      "metadataUpdatedAt",
    ],
    issues,
    path
  );
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString(value, "lastUpdated", `${path}.lastUpdated`, issues, { nonEmpty: true });
  requiredInteger(value, "eventCount", `${path}.eventCount`, issues, { min: 0 });
  requiredInteger(value, "runCount", `${path}.runCount`, issues, { min: 0 });
  if ("activeRunCount" in value) {
    optionalInteger(value, "activeRunCount", `${path}.activeRunCount`, issues, { min: 0 });
  }
  if ("activeRunIds" in value) {
    optionalStringArray(value, "activeRunIds", `${path}.activeRunIds`, issues);
  }
  if ("latestRunId" in value) {
    optionalString(value, "latestRunId", `${path}.latestRunId`, issues, { nonEmpty: true });
  }
  if ("latestRunStatus" in value) {
    optionalEnum(value, "latestRunStatus", `${path}.latestRunStatus`, RUN_STATUSES, issues);
  }
  if ("latestRunUpdatedAt" in value) {
    optionalString(value, "latestRunUpdatedAt", `${path}.latestRunUpdatedAt`, issues, { nonEmpty: true });
  }
  if ("pendingApprovalCount" in value) {
    optionalInteger(value, "pendingApprovalCount", `${path}.pendingApprovalCount`, issues, { min: 0 });
  }
  if ("pendingInputCount" in value) {
    optionalInteger(value, "pendingInputCount", `${path}.pendingInputCount`, issues, { min: 0 });
  }
  if ("lastEventId" in value) {
    optionalString(value, "lastEventId", `${path}.lastEventId`, issues, { nonEmpty: true });
  }
  if ("lastSequence" in value) {
    optionalInteger(value, "lastSequence", `${path}.lastSequence`, issues, { min: 1 });
  }
  if ("lastMessagePreview" in value) {
    optionalString(value, "lastMessagePreview", `${path}.lastMessagePreview`, issues, { nonEmpty: true });
  }
  if ("title" in value) {
    optionalString(value, "title", `${path}.title`, issues);
  }
  if ("pinned" in value) {
    optionalBoolean(value, "pinned", `${path}.pinned`, issues);
  }
  if ("archived" in value) {
    optionalBoolean(value, "archived", `${path}.archived`, issues);
  }
  if ("deleted" in value) {
    optionalBoolean(value, "deleted", `${path}.deleted`, issues);
  }
  if ("metadataUpdatedAt" in value) {
    optionalString(value, "metadataUpdatedAt", `${path}.metadataUpdatedAt`, issues, { nonEmpty: true });
  }
}

export function validateSessionListDiagnostics(
  input: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(input)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(
    input,
    ["queryMs", "sessionCount", "summaryCount", "metadataCount", "filteredOutCount", "summarySource"],
    issues,
    path
  );
  requiredInteger(input, "queryMs", `${path}.queryMs`, issues, { min: 0 });
  requiredInteger(input, "sessionCount", `${path}.sessionCount`, issues, { min: 0 });
  requiredInteger(input, "summaryCount", `${path}.summaryCount`, issues, { min: 0 });
  requiredInteger(input, "metadataCount", `${path}.metadataCount`, issues, { min: 0 });
  requiredInteger(input, "filteredOutCount", `${path}.filteredOutCount`, issues, { min: 0 });
  requiredEnum(input, "summarySource", `${path}.summarySource`, ["event-store", "unavailable"] as const, issues);
}

export function validateApplySessionActionMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApplySessionActionMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPLY_SESSION_ACTION_FIELDS, issues);

  const actionRecord = requiredRecord(input, "action", "$.action", issues);
  const action = actionRecord ? readSessionAction(actionRecord, "$.action", issues) : undefined;

  if (issues.length > 0) return invalid("Invalid apply-session-action message", issues);

  return ok({
    type: "apply-session-action",
    action: action as SessionAction,
  });
}

export function readSessionAction(
  input: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): SessionAction | undefined {
  const kind = requiredEnum(input, "kind", `${path}.kind`, SESSION_ACTION_KINDS, issues);
  rejectUnknownFields(input, sessionActionFields(kind), issues, path);

  const protocolVersion = requiredInteger(input, "protocolVersion", `${path}.protocolVersion`, issues, {
    min: 1,
  });
  if (protocolVersion !== undefined && protocolVersion !== SESSION_ACTION_PROTOCOL_VERSION) {
    issues.push({
      path: `${path}.protocolVersion`,
      message: `Expected session action protocol version ${SESSION_ACTION_PROTOCOL_VERSION}`,
    });
  }
  const actionId = requiredString(input, "actionId", `${path}.actionId`, issues, { nonEmpty: true });
  const sessionId = requiredString(input, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  const requestedAt = requiredString(input, "requestedAt", `${path}.requestedAt`, issues, { nonEmpty: true });
  const requestedBy = requiredEnum(
    input,
    "requestedBy",
    `${path}.requestedBy`,
    ["workbench", "daemon", "automation"] as const,
    issues
  );
  const idempotencyKey = optionalString(input, "idempotencyKey", `${path}.idempotencyKey`, issues, {
    nonEmpty: true,
  });
  if ("consistency" in input) {
    validateSessionActionConsistency(input.consistency, `${path}.consistency`, issues);
  }

  if (kind === undefined) return undefined;

  const base = {
    protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    actionId: actionId as string,
    kind,
    sessionId: sessionId as string,
    requestedAt: requestedAt as string,
    requestedBy: requestedBy as SessionAction["requestedBy"],
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...("consistency" in input ? { consistency: input.consistency as SessionAction["consistency"] } : {}),
  };

  switch (kind) {
    case "pin":
    case "unpin":
    case "archive":
    case "unarchive":
    case "delete":
      return base as SessionAction;
    case "rename": {
      const title = requiredString(input, "title", `${path}.title`, issues, { nonEmpty: true });
      return { ...base, title: title as string } as SessionAction;
    }
    case "fork": {
      const fromEventId = optionalString(input, "fromEventId", `${path}.fromEventId`, issues, { nonEmpty: true });
      const fromMessageId = optionalString(input, "fromMessageId", `${path}.fromMessageId`, issues, { nonEmpty: true });
      const targetSessionId = optionalString(input, "targetSessionId", `${path}.targetSessionId`, issues, { nonEmpty: true });
      return {
        ...base,
        ...(fromEventId !== undefined ? { fromEventId } : {}),
        ...(fromMessageId !== undefined ? { fromMessageId } : {}),
        ...(targetSessionId !== undefined ? { targetSessionId } : {}),
      } as SessionAction;
    }
    case "rewind": {
      const targetEventId = requiredString(input, "targetEventId", `${path}.targetEventId`, issues, { nonEmpty: true });
      const restoreWorkspace = requiredBoolean(input, "restoreWorkspace", `${path}.restoreWorkspace`, issues);
      return {
        ...base,
        targetEventId: targetEventId as string,
        restoreWorkspace: restoreWorkspace as boolean,
      } as SessionAction;
    }
    case "open": {
      const target = requiredEnum(input, "target", `${path}.target`, SESSION_OPEN_TARGETS, issues);
      const paneId = optionalString(input, "paneId", `${path}.paneId`, issues, { nonEmpty: true });
      return {
        ...base,
        target: target as Extract<SessionAction, { kind: "open" }>["target"],
        ...(paneId !== undefined ? { paneId } : {}),
      } as SessionAction;
    }
  }
}

export function sessionActionFields(kind: SessionActionKind | undefined): readonly string[] {
  switch (kind) {
    case "rename":
      return [...SESSION_ACTION_BASE_FIELDS, "title"];
    case "fork":
      return [...SESSION_ACTION_BASE_FIELDS, "fromEventId", "fromMessageId", "targetSessionId"];
    case "rewind":
      return [...SESSION_ACTION_BASE_FIELDS, "targetEventId", "restoreWorkspace"];
    case "open":
      return [...SESSION_ACTION_BASE_FIELDS, "target", "paneId"];
    default:
      return [
        ...SESSION_ACTION_BASE_FIELDS,
        "title",
        "fromEventId",
        "fromMessageId",
        "targetSessionId",
        "targetEventId",
        "restoreWorkspace",
        "target",
        "paneId",
      ];
  }
}

export function validateSessionActionConsistency(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SESSION_ACTION_CONSISTENCY_FIELDS, issues, path);
  if ("expectedSessionVersion" in value) {
    optionalString(value, "expectedSessionVersion", `${path}.expectedSessionVersion`, issues, { nonEmpty: true });
  }
  if ("eventLogCursor" in value) {
    optionalString(value, "eventLogCursor", `${path}.eventLogCursor`, issues, { nonEmpty: true });
  }
  if ("workspaceVersionId" in value) {
    optionalString(value, "workspaceVersionId", `${path}.workspaceVersionId`, issues, { nonEmpty: true });
  }
  if ("parentActionId" in value) {
    optionalString(value, "parentActionId", `${path}.parentActionId`, issues, { nonEmpty: true });
  }
}

export function validateSessionActionReceiptMessage(
  input: UnknownRecord
): ProtocolValidationResult<SessionActionReceiptMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SESSION_ACTION_RECEIPT_FIELDS, issues);

  const protocolVersion = requiredInteger(input, "protocolVersion", "$.protocolVersion", issues, { min: 1 });
  if (protocolVersion !== undefined && protocolVersion !== SESSION_ACTION_PROTOCOL_VERSION) {
    issues.push({
      path: "$.protocolVersion",
      message: `Expected session action protocol version ${SESSION_ACTION_PROTOCOL_VERSION}`,
    });
  }
  const actionId = requiredString(input, "actionId", "$.actionId", issues, { nonEmpty: true });
  const kind = requiredEnum(input, "kind", "$.kind", SESSION_ACTION_KINDS, issues);
  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const status = requiredEnum(input, "status", "$.status", SESSION_ACTION_STATUSES, issues);
  const committedAt = optionalString(input, "committedAt", "$.committedAt", issues, { nonEmpty: true });
  const resultingSessionId = optionalString(input, "resultingSessionId", "$.resultingSessionId", issues, {
    nonEmpty: true,
  });
  const resultingEventId = optionalString(input, "resultingEventId", "$.resultingEventId", issues, {
    nonEmpty: true,
  });
  const resultingWorkspaceVersionId = optionalString(
    input,
    "resultingWorkspaceVersionId",
    "$.resultingWorkspaceVersionId",
    issues,
    { nonEmpty: true }
  );
  const errorCode = optionalString(input, "errorCode", "$.errorCode", issues, { nonEmpty: true });
  const errorMessage = optionalString(input, "errorMessage", "$.errorMessage", issues, { nonEmpty: true });

  if ((status === "rejected" || status === "failed") && (errorCode === undefined || errorMessage === undefined)) {
    issues.push({
      path: "$.errorCode",
      message: "Rejected or failed receipts require errorCode and errorMessage",
    });
  }

  if (issues.length > 0) return invalid("Invalid session-action-receipt message", issues);

  return ok({
    type: "session-action-receipt",
    protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    actionId: actionId as string,
    kind: kind as SessionActionReceipt["kind"],
    sessionId: sessionId as string,
    status: status as SessionActionReceipt["status"],
    ...(committedAt !== undefined ? { committedAt } : {}),
    ...(resultingSessionId !== undefined ? { resultingSessionId } : {}),
    ...(resultingEventId !== undefined ? { resultingEventId } : {}),
    ...(resultingWorkspaceVersionId !== undefined ? { resultingWorkspaceVersionId } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  });
}

export function validateSessionTreeEntry(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SESSION_TREE_ENTRY_FIELDS, issues, path);
  const type = requiredEnum(value, "type", `${path}.type`, ["node", "branch_summary"], issues);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  if ("parentId" in value) {
    readNullableString(value.parentId, `${path}.parentId`, issues);
  }
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });

  if (type === "node") {
    if (!isJsonObject(value.payload)) {
      issues.push({ path: `${path}.payload`, message: "Expected JSON object" });
    }
    return;
  }

  requiredString(value, "summary", `${path}.summary`, issues);
  if ("abandonedLeafId" in value) {
    readNullableString(value.abandonedLeafId, `${path}.abandonedLeafId`, issues);
  }
  if (!isJsonObject(value.details)) {
    issues.push({ path: `${path}.details`, message: "Expected JSON object" });
  }
}
