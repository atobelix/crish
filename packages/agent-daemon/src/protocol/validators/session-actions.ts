// Protocol validators: session-actions message family
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
  ApplyConversationRewindMessage,
  ConversationRewindAppliedMessage,
  ConversationRewindPreviewMessage,
  ConversationRewindBoundaryMessage,
  PreviewConversationRewindMessage,
  PreviewConversationRewindByBoundaryMessage,
  ResolveConversationRewindBoundaryMessage,
  SessionActionReceiptMessage,
} from "../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "./common.js";
import {
  APPLY_SESSION_ACTION_FIELDS,
  CONVERSATION_REWIND_APPLIED_FIELDS,
  CONVERSATION_REWIND_BOUNDARY_FIELDS,
  CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS,
  CONVERSATION_REWIND_PREVIEW_FIELDS,
  CONVERSATION_REWIND_REQUEST_FIELDS,
  CONVERSATION_REWIND_STEP_RESULT_FIELDS,
  PREVIEW_CONVERSATION_REWIND_BY_BOUNDARY_FIELDS,
  REWIND_ACTIVE_SUBAGENT_FIELDS,
  REWIND_APPROVAL_CLEARANCE_FIELDS,
  REWIND_BOUNDARY_DIAGNOSTIC_FIELDS,
  REWIND_BOUNDARY_RECORD_FIELDS,
  REWIND_CHECKPOINT_FIELDS,
  REWIND_CHECKPOINT_RECORD_FIELDS,
  REWIND_CHECKPOINT_TOOL_CALL_FIELDS,
  REWIND_ENTRY_PROJECTION_FIELDS,
  REWIND_PLAN_FIELDS,
  REWIND_RUN_CANCELLATION_FIELDS,
  REWIND_STEP_FIELDS,
  REWIND_TARGET_CHECKPOINT_FACTS_FIELDS,
  REWIND_TARGET_FACTS_FIELDS,
  REWIND_WORKSPACE_RESTORE_FIELDS,
  SESSION_ACTION_BASE_FIELDS,
  SESSION_ACTION_CONSISTENCY_FIELDS,
  SESSION_ACTION_RECEIPT_FIELDS,
  SESSION_TREE_ENTRY_FIELDS,
  invalid,
  isJsonObject,
  isRecord,
  ok,
  optionalBoolean,
  optionalEnum,
  optionalString,
  readNullableString,
  rejectUnknownFields,
  requiredArray,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredRecord,
  requiredString,
  requiredStringArray,
} from "./common.js";

export function validatePreviewConversationRewindMessage(
  input: UnknownRecord
): ProtocolValidationResult<PreviewConversationRewindMessage> {
  return validateConversationRewindRequest(input, "preview-conversation-rewind");
}

export function validateResolveConversationRewindBoundaryMessage(
  input: UnknownRecord
): ProtocolValidationResult<ResolveConversationRewindBoundaryMessage> {
  const result = validateConversationRewindBoundaryRequest(input, "resolve-conversation-rewind-boundary");
  return result as ProtocolValidationResult<ResolveConversationRewindBoundaryMessage>;
}

export function validatePreviewConversationRewindByBoundaryMessage(
  input: UnknownRecord
): ProtocolValidationResult<PreviewConversationRewindByBoundaryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PREVIEW_CONVERSATION_REWIND_BY_BOUNDARY_FIELDS, issues);

  const base = readConversationRewindBoundaryRequest(input, issues);
  const restorePolicy = optionalEnum(
    input,
    "restorePolicy",
    "$.restorePolicy",
    ["if-present", "required", "skip"],
    issues
  );
  if ("activeSubagents" in input) {
    const activeSubagents = requiredArray(input, "activeSubagents", "$.activeSubagents", issues);
    activeSubagents?.forEach((subagent, index) =>
      validateConversationRewindActiveSubagent(subagent, `$.activeSubagents[${index}]`, issues)
    );
  }

  if (issues.length > 0) return invalid("Invalid preview-conversation-rewind-by-boundary message", issues);

  return ok({
    type: "preview-conversation-rewind-by-boundary",
    ...base,
    ...(restorePolicy !== undefined ? { restorePolicy } : {}),
    ...("activeSubagents" in input
      ? { activeSubagents: input.activeSubagents as PreviewConversationRewindByBoundaryMessage["activeSubagents"] }
      : {}),
  });
}

export function validateApplyConversationRewindMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApplyConversationRewindMessage> {
  return validateConversationRewindRequest(input, "apply-conversation-rewind");
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

export function validateConversationRewindBoundaryRequest<TType extends "resolve-conversation-rewind-boundary">(
  input: UnknownRecord,
  type: TType
): ProtocolValidationResult<ResolveConversationRewindBoundaryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS, issues);
  const base = readConversationRewindBoundaryRequest(input, issues);

  if (issues.length > 0) return invalid(`Invalid ${type} message`, issues);

  return ok({
    type,
    ...base,
  });
}

export function readConversationRewindBoundaryRequest(
  input: UnknownRecord,
  issues: ProtocolValidationIssue[]
): Omit<ResolveConversationRewindBoundaryMessage, "type"> {
  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  const userMessageId = optionalString(input, "userMessageId", "$.userMessageId", issues, {
    nonEmpty: true,
  });
  const latestUserMessage = optionalBoolean(input, "latestUserMessage", "$.latestUserMessage", issues);
  const mode = optionalEnum(
    input,
    "mode",
    "$.mode",
    ["keep-user-message", "remove-user-message"],
    issues
  );

  if (latestUserMessage !== true && userMessageId === undefined) {
    issues.push({ path: "$.userMessageId", message: "Required unless latestUserMessage is true" });
  }
  if (latestUserMessage === true && userMessageId !== undefined) {
    issues.push({ path: "$.userMessageId", message: "Must be omitted when latestUserMessage is true" });
  }

  return {
    sessionId: sessionId as string,
    ...(userMessageId !== undefined ? { userMessageId } : {}),
    ...(latestUserMessage !== undefined ? { latestUserMessage } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

export function validateConversationRewindRequest<TType extends "preview-conversation-rewind" | "apply-conversation-rewind">(
  input: UnknownRecord,
  type: TType
): ProtocolValidationResult<TType extends "preview-conversation-rewind" ? PreviewConversationRewindMessage : ApplyConversationRewindMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONVERSATION_REWIND_REQUEST_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  const targetLeafId =
    "targetLeafId" in input
      ? readNullableString(input.targetLeafId, "$.targetLeafId", issues)
      : undefined;
  const entries = "entries" in input ? requiredArray(input, "entries", "$.entries", issues) : undefined;
  const userMessageId = optionalString(input, "userMessageId", "$.userMessageId", issues, {
    nonEmpty: true,
  });
  const latestUserMessage = optionalBoolean(input, "latestUserMessage", "$.latestUserMessage", issues);
  const mode = optionalEnum(
    input,
    "mode",
    "$.mode",
    ["keep-user-message", "remove-user-message"],
    issues
  );
  const restorePolicy = optionalEnum(
    input,
    "restorePolicy",
    "$.restorePolicy",
    ["if-present", "required", "skip"],
    issues
  );
  if (entries) {
    entries.forEach((entry, index) =>
      validateSessionTreeEntry(entry, `$.entries[${index}]`, issues)
    );
  }
  const hasExplicitTarget = "targetLeafId" in input || "entries" in input;
  const hasBoundarySelector = userMessageId !== undefined || latestUserMessage !== undefined || mode !== undefined;
  if (type === "preview-conversation-rewind" || hasExplicitTarget) {
    if (!("targetLeafId" in input)) {
      issues.push({ path: "$.targetLeafId", message: "Required field is missing" });
    }
    if (!("entries" in input)) {
      issues.push({ path: "$.entries", message: "Required field is missing" });
    }
  }
  if (type === "apply-conversation-rewind" && !hasExplicitTarget && !hasBoundarySelector) {
    issues.push({ path: "$.userMessageId", message: "Required unless targetLeafId and entries are provided" });
  }
  if (hasExplicitTarget && hasBoundarySelector) {
    issues.push({ path: "$.userMessageId", message: "Must be omitted when targetLeafId or entries are provided" });
  }
  if (latestUserMessage === true && userMessageId !== undefined) {
    issues.push({ path: "$.userMessageId", message: "Must be omitted when latestUserMessage is true" });
  }
  if (latestUserMessage !== true && hasBoundarySelector && userMessageId === undefined) {
    issues.push({ path: "$.userMessageId", message: "Required unless latestUserMessage is true" });
  }
  if ("checkpoint" in input) {
    validateConversationRewindCheckpoint(input.checkpoint, "$.checkpoint", issues);
  }
  if ("activeSubagents" in input) {
    const activeSubagents = requiredArray(input, "activeSubagents", "$.activeSubagents", issues);
    activeSubagents?.forEach((subagent, index) =>
      validateConversationRewindActiveSubagent(subagent, `$.activeSubagents[${index}]`, issues)
    );
  }

  if (issues.length > 0) return invalid(`Invalid ${type} message`, issues);

  return ok({
    type,
    sessionId: sessionId as string,
    ...("targetLeafId" in input ? { targetLeafId: targetLeafId as string | null } : {}),
    ...("entries" in input ? { entries: entries as PreviewConversationRewindMessage["entries"] } : {}),
    ...(userMessageId !== undefined ? { userMessageId } : {}),
    ...(latestUserMessage !== undefined ? { latestUserMessage } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...("checkpoint" in input ? { checkpoint: input.checkpoint as PreviewConversationRewindMessage["checkpoint"] } : {}),
    ...(restorePolicy !== undefined ? { restorePolicy } : {}),
    ...("activeSubagents" in input
      ? { activeSubagents: input.activeSubagents as PreviewConversationRewindMessage["activeSubagents"] }
      : {}),
  } as TType extends "preview-conversation-rewind" ? PreviewConversationRewindMessage : ApplyConversationRewindMessage);
}

export function validateConversationRewindPreviewMessage(
  input: UnknownRecord
): ProtocolValidationResult<ConversationRewindPreviewMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONVERSATION_REWIND_PREVIEW_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  validateConversationRewindPlan(input.plan, "$.plan", issues);

  if (issues.length > 0) return invalid("Invalid conversation-rewind-preview message", issues);

  return ok({
    type: "conversation-rewind-preview",
    sessionId: sessionId as string,
    plan: input.plan as ConversationRewindPreviewMessage["plan"],
  });
}

export function validateConversationRewindBoundaryMessage(
  input: UnknownRecord
): ProtocolValidationResult<ConversationRewindBoundaryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONVERSATION_REWIND_BOUNDARY_FIELDS, issues);

  const status = requiredEnum(input, "status", "$.status", ["ok", "blocked"], issues);
  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  if ("userMessageId" in input) {
    optionalString(input, "userMessageId", "$.userMessageId", issues, { nonEmpty: true });
  }
  const latestUserMessage = requiredBoolean(input, "latestUserMessage", "$.latestUserMessage", issues);
  const mode = requiredEnum(
    input,
    "mode",
    "$.mode",
    ["keep-user-message", "remove-user-message"],
    issues
  );
  if ("boundary" in input) validateConversationRewindBoundaryRecord(input.boundary, "$.boundary", issues);
  if ("checkpoint" in input) validateConversationRewindCheckpointRecord(input.checkpoint, "$.checkpoint", issues);
  if ("target" in input) validateConversationRewindTargetFacts(input.target, "$.target", issues);
  const missingFacts = requiredArray(input, "missingFacts", "$.missingFacts", issues);
  missingFacts?.forEach((fact, index) => validateConversationRewindMissingFact(fact, `$.missingFacts[${index}]`, issues));
  const diagnostics = requiredArray(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach((diagnostic, index) =>
    validateConversationRewindBoundaryDiagnostic(diagnostic, `$.diagnostics[${index}]`, issues)
  );
  if ("plan" in input) validateConversationRewindPlan(input.plan, "$.plan", issues);
  if ("runtimeTargetLeafId" in input) {
    optionalString(input, "runtimeTargetLeafId", "$.runtimeTargetLeafId", issues, { nonEmpty: true });
  }

  if (issues.length > 0) return invalid("Invalid conversation-rewind-boundary message", issues);

  return ok({
    type: "conversation-rewind-boundary",
    status: status as ConversationRewindBoundaryMessage["status"],
    sessionId: sessionId as string,
    ...("userMessageId" in input ? { userMessageId: input.userMessageId as string } : {}),
    latestUserMessage: latestUserMessage as boolean,
    mode: mode as ConversationRewindBoundaryMessage["mode"],
    ...("boundary" in input ? { boundary: input.boundary as ConversationRewindBoundaryMessage["boundary"] } : {}),
    ...("checkpoint" in input ? { checkpoint: input.checkpoint as ConversationRewindBoundaryMessage["checkpoint"] } : {}),
    ...("target" in input ? { target: input.target as ConversationRewindBoundaryMessage["target"] } : {}),
    missingFacts: missingFacts as ConversationRewindBoundaryMessage["missingFacts"],
    diagnostics: diagnostics as ConversationRewindBoundaryMessage["diagnostics"],
    ...("plan" in input ? { plan: input.plan as ConversationRewindBoundaryMessage["plan"] } : {}),
    ...("runtimeTargetLeafId" in input ? { runtimeTargetLeafId: input.runtimeTargetLeafId as string } : {}),
  });
}

export function validateConversationRewindAppliedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ConversationRewindAppliedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONVERSATION_REWIND_APPLIED_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  validateConversationRewindPlan(input.plan, "$.plan", issues);
  const stepResults = requiredArray(input, "stepResults", "$.stepResults", issues);
  stepResults?.forEach((result, index) =>
    validateConversationRewindStepResult(result, `$.stepResults[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid conversation-rewind-applied message", issues);

  return ok({
    type: "conversation-rewind-applied",
    sessionId: sessionId as string,
    plan: input.plan as ConversationRewindAppliedMessage["plan"],
    stepResults: stepResults as ConversationRewindAppliedMessage["stepResults"],
  });
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

export function validateConversationRewindCheckpoint(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_CHECKPOINT_FIELDS, issues, path);
  const source = requiredEnum(value, "source", `${path}.source`, ["runtime-manifest", "git-checkpoint"], issues);
  if (source === "runtime-manifest") {
    requiredString(value, "checkpointId", `${path}.checkpointId`, issues, {
      nonEmpty: true,
    });
    if ("manifestPath" in value) {
      optionalString(value, "manifestPath", `${path}.manifestPath`, issues, {
        nonEmpty: true,
      });
    }
    return;
  }

  if (source === "git-checkpoint") {
    requiredString(value, "checkpoint", `${path}.checkpoint`, issues, {
      nonEmpty: true,
    });
    if ("cleanUntracked" in value) {
      optionalBoolean(value, "cleanUntracked", `${path}.cleanUntracked`, issues);
    }
  }
}

export function validateConversationRewindActiveSubagent(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_ACTIVE_SUBAGENT_FIELDS, issues, path);
  requiredString(value, "parentRunId", `${path}.parentRunId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "subagentRunId", `${path}.subagentRunId`, issues, {
    nonEmpty: true,
  });
  if ("subagentId" in value) {
    optionalString(value, "subagentId", `${path}.subagentId`, issues, {
      nonEmpty: true,
    });
  }
}

export function validateConversationRewindBoundaryRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_BOUNDARY_RECORD_FIELDS, issues, path);
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "userMessageId", `${path}.userMessageId`, issues, { nonEmpty: true });
  optionalString(value, "sessionTreeLeafIdBefore", `${path}.sessionTreeLeafIdBefore`, issues, { nonEmpty: true });
  optionalString(value, "sessionTreeLeafIdAfter", `${path}.sessionTreeLeafIdAfter`, issues, { nonEmpty: true });
  optionalString(value, "runtimeLeafIdBefore", `${path}.runtimeLeafIdBefore`, issues, { nonEmpty: true });
  optionalString(value, "runtimeLeafIdAfter", `${path}.runtimeLeafIdAfter`, issues, { nonEmpty: true });
  requiredInteger(value, "eventSequence", `${path}.eventSequence`, issues, { min: 0 });
  requiredString(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  optionalString(value, "checkpointId", `${path}.checkpointId`, issues, { nonEmpty: true });
  optionalString(value, "checkpointRef", `${path}.checkpointRef`, issues, { nonEmpty: true });
  if ("checkpointSource" in value) {
    optionalEnum(value, "checkpointSource", `${path}.checkpointSource`, ["runtime", "tool", "external", "unknown"], issues);
  }
  requiredStringArray(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("metadata" in value && !isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}

export function validateConversationRewindCheckpointRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_CHECKPOINT_RECORD_FIELDS, issues, path);
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "userMessageId", `${path}.userMessageId`, issues, { nonEmpty: true });
  if ("toolCall" in value) validateConversationRewindCheckpointToolCall(value.toolCall, `${path}.toolCall`, issues);
  requiredString(value, "checkpointId", `${path}.checkpointId`, issues, { nonEmpty: true });
  requiredString(value, "checkpointRef", `${path}.checkpointRef`, issues, { nonEmpty: true });
  requiredString(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  requiredStringArray(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredEnum(value, "source", `${path}.source`, ["runtime", "tool", "external", "unknown"], issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("metadata" in value && !isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}

export function validateConversationRewindCheckpointToolCall(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields(value, REWIND_CHECKPOINT_TOOL_CALL_FIELDS, issues, path);
  optionalString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  optionalString(value, "toolName", `${path}.toolName`, issues, { nonEmpty: true });
  optionalString(value, "actor", `${path}.actor`, issues, { nonEmpty: true });
  optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  optionalString(value, "targetSummary", `${path}.targetSummary`, issues, { nonEmpty: true });
}

export function validateConversationRewindTargetFacts(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_TARGET_FACTS_FIELDS, issues, path);
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "userMessageId", `${path}.userMessageId`, issues, { nonEmpty: true });
  requiredEnum(value, "mode", `${path}.mode`, ["keep-user-message", "remove-user-message"], issues);
  requiredInteger(value, "eventSequence", `${path}.eventSequence`, issues, { min: 0 });
  requiredString(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  requiredStringArray(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  optionalString(value, "sessionTreeTargetLeafId", `${path}.sessionTreeTargetLeafId`, issues, { nonEmpty: true });
  optionalString(value, "runtimeTargetLeafId", `${path}.runtimeTargetLeafId`, issues, { nonEmpty: true });
  if ("checkpoint" in value) validateConversationRewindTargetCheckpointFacts(value.checkpoint, `${path}.checkpoint`, issues);
  const missingFacts = requiredArray(value, "missingFacts", `${path}.missingFacts`, issues);
  missingFacts?.forEach((fact, index) => validateConversationRewindMissingFact(fact, `${path}.missingFacts[${index}]`, issues));
  if ("metadata" in value && !isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}

export function validateConversationRewindTargetCheckpointFacts(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields(value, REWIND_TARGET_CHECKPOINT_FACTS_FIELDS, issues, path);
  requiredString(value, "checkpointId", `${path}.checkpointId`, issues, { nonEmpty: true });
  requiredString(value, "checkpointRef", `${path}.checkpointRef`, issues, { nonEmpty: true });
  requiredEnum(value, "checkpointSource", `${path}.checkpointSource`, ["runtime", "tool", "external", "unknown"], issues);
  requiredString(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  requiredStringArray(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
}

export function validateConversationRewindBoundaryDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields(value, REWIND_BOUNDARY_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  validateConversationRewindMissingFact(value.fact, `${path}.fact`, issues);
  requiredString(value, "message", `${path}.message`, issues);
  requiredBoolean(value, "blocked", `${path}.blocked`, issues);
  if ("metadata" in value && !isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}

export function validateConversationRewindMissingFact(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (
    value !== "session-tree-target-leaf" &&
    value !== "runtime-target-leaf" &&
    value !== "workspace-checkpoint" &&
    value !== "boundary-record" &&
    value !== "checkpoint-manifest-record" &&
    value !== "session-record" &&
    value !== "session-tree-entries"
  ) {
    issues.push({ path, message: "Expected rewind missing fact" });
  }
}

export function validateConversationRewindPlan(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_PLAN_FIELDS, issues, path);
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  readNullableString(value.fromLeafId, `${path}.fromLeafId`, issues);
  readNullableString(value.targetLeafId, `${path}.targetLeafId`, issues);
  const targetPath = requiredArray(value, "targetPath", `${path}.targetPath`, issues);
  targetPath?.forEach((entry, index) =>
    validateSessionTreeEntry(entry, `${path}.targetPath[${index}]`, issues)
  );
  validateConversationRewindEntryProjection(value.entryProjection, `${path}.entryProjection`, issues);
  const runCancellations = requiredArray(value, "runCancellations", `${path}.runCancellations`, issues);
  runCancellations?.forEach((run, index) =>
    validateConversationRewindRunCancellation(run, `${path}.runCancellations[${index}]`, issues)
  );
  const approvalClearances = requiredArray(value, "approvalClearances", `${path}.approvalClearances`, issues);
  approvalClearances?.forEach((approval, index) =>
    validateConversationRewindApprovalClearance(approval, `${path}.approvalClearances[${index}]`, issues)
  );
  validateConversationRewindWorkspaceRestore(value.workspaceRestore, `${path}.workspaceRestore`, issues);
  const steps = requiredArray(value, "steps", `${path}.steps`, issues);
  steps?.forEach((step, index) => validateConversationRewindStep(step, `${path}.steps[${index}]`, issues));
}

export function validateConversationRewindEntryProjection(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_ENTRY_PROJECTION_FIELDS, issues, path);
  const currentPath = requiredArray(value, "currentPath", `${path}.currentPath`, issues);
  currentPath?.forEach((entry, index) =>
    validateSessionTreeEntry(entry, `${path}.currentPath[${index}]`, issues)
  );
  const targetPath = requiredArray(value, "targetPath", `${path}.targetPath`, issues);
  targetPath?.forEach((entry, index) =>
    validateSessionTreeEntry(entry, `${path}.targetPath[${index}]`, issues)
  );
  if ("commonAncestorId" in value) {
    optionalString(value, "commonAncestorId", `${path}.commonAncestorId`, issues, {
      nonEmpty: true,
    });
  }
  requiredStringArray(value, "retainedEntryIds", `${path}.retainedEntryIds`, issues);
  requiredStringArray(value, "hiddenEntryIds", `${path}.hiddenEntryIds`, issues);
  requiredStringArray(
    value,
    "hiddenCurrentPathEntryIds",
    `${path}.hiddenCurrentPathEntryIds`,
    issues
  );
  requiredStringArray(value, "hiddenBranchEntryIds", `${path}.hiddenBranchEntryIds`, issues);
}

export function validateConversationRewindRunCancellation(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_RUN_CANCELLATION_FIELDS, issues, path);
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredEnum(value, "reason", `${path}.reason`, ["conversation-rewind"], issues);
  requiredEnum(value, "role", `${path}.role`, ["session-run", "subagent-run"], issues);
}

export function validateConversationRewindApprovalClearance(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_APPROVAL_CLEARANCE_FIELDS, issues, path);
  requiredString(value, "toolCallId", `${path}.toolCallId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredEnum(value, "reason", `${path}.reason`, ["conversation-rewind"], issues);
}

export function validateConversationRewindWorkspaceRestore(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_WORKSPACE_RESTORE_FIELDS, issues, path);
  requiredBoolean(value, "required", `${path}.required`, issues);
  const source = requiredEnum(value, "source", `${path}.source`, ["runtime-manifest", "git-checkpoint", "none"], issues);
  if (source === "runtime-manifest") {
    requiredString(value, "checkpointId", `${path}.checkpointId`, issues, {
      nonEmpty: true,
    });
    if ("manifestPath" in value) {
      optionalString(value, "manifestPath", `${path}.manifestPath`, issues, {
        nonEmpty: true,
      });
    }
  }
  if (source === "git-checkpoint") {
    requiredString(value, "checkpoint", `${path}.checkpoint`, issues, {
      nonEmpty: true,
    });
  }
  requiredBoolean(value, "cleanUntracked", `${path}.cleanUntracked`, issues);
}

export function validateConversationRewindStep(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_STEP_FIELDS, issues, path);
  const type = requiredEnum(
    value,
    "type",
    `${path}.type`,
    ["cancel-runs", "clear-approvals", "restore-workspace", "move-session-leaf"],
    issues
  );
  if (type === "cancel-runs") {
    const runs = requiredArray(value, "runs", `${path}.runs`, issues);
    runs?.forEach((run, index) =>
      validateConversationRewindRunCancellation(run, `${path}.runs[${index}]`, issues)
    );
  }
  if (type === "clear-approvals") {
    const approvals = requiredArray(value, "approvals", `${path}.approvals`, issues);
    approvals?.forEach((approval, index) =>
      validateConversationRewindApprovalClearance(approval, `${path}.approvals[${index}]`, issues)
    );
  }
  if (type === "restore-workspace") {
    validateConversationRewindWorkspaceRestore(value.restore, `${path}.restore`, issues);
  }
  if (type === "move-session-leaf") {
    requiredString(value, "sessionId", `${path}.sessionId`, issues, {
      nonEmpty: true,
    });
    readNullableString(value.fromLeafId, `${path}.fromLeafId`, issues);
    readNullableString(value.toLeafId, `${path}.toLeafId`, issues);
  }
}

export function validateConversationRewindStepResult(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CONVERSATION_REWIND_STEP_RESULT_FIELDS, issues, path);
  requiredEnum(
    value,
    "type",
    `${path}.type`,
    ["cancel-runs", "clear-approvals", "restore-workspace", "move-session-leaf"],
    issues
  );
  requiredEnum(value, "status", `${path}.status`, ["applied", "deferred", "unsupported", "skipped", "failed"], issues);
  if ("code" in value) {
    optionalString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  }
  if ("message" in value) {
    optionalString(value, "message", `${path}.message`, issues);
  }
  if ("affectedIds" in value) {
    const affectedIds = requiredArray(value, "affectedIds", `${path}.affectedIds`, issues);
    affectedIds?.forEach((id, index) => {
      if (typeof id !== "string" || id.length === 0) {
        issues.push({ path: `${path}.affectedIds[${index}]`, message: "Expected non-empty string" });
      }
    });
  }
  if ("metadata" in value && !isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}
