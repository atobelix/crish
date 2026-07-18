// Protocol validators: session-events message family
import type {
  CancelPendingInputMessage,
  DispatchPendingInputMessage,
  GetRunSnapshotMessage,
  ListPendingInputsMessage,
  ListRunsMessage,
  ListSessionsMessage,
  PendingInputCancelledMessage,
  PendingInputDispatchedMessage,
  PendingInputQueuedMessage,
  PendingInputsListedMessage,
  ReadRunEventsMessage,
  ReadSessionEventsMessage,
  RunEventsMessage,
  RunSnapshotMessage,
  RunsListedMessage,
  SessionEventsMessage,
  SessionsListedMessage,
  EnqueuePendingInputMessage,
} from "../../types.js";
import type {
  JsonObject,
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "./common.js";
import {
  CANCEL_PENDING_INPUT_FIELDS,
  DISPATCH_PENDING_INPUT_FIELDS,
  ENQUEUE_PENDING_INPUT_FIELDS,
  GET_RUN_SNAPSHOT_FIELDS,
  GOAL_CONTINUATION_ACTIONS,
  GOAL_DECISION_FIELDS,
  GOAL_RUN_STATUSES,
  GOAL_STATE_FIELDS,
  GOAL_STOPPED_REASONS,
  LIST_PENDING_INPUTS_FIELDS,
  LIST_RUNS_FIELDS,
  LIST_SESSIONS_FIELDS,
  ORCHESTRATOR_EVENT_FIELDS,
  ORCHESTRATOR_EVENT_TYPES,
  PENDING_INPUTS_LISTED_FIELDS,
  PENDING_INPUT_CANCELLED_FIELDS,
  PENDING_INPUT_DISPATCHED_FIELDS,
  PENDING_INPUT_MODES,
  PENDING_INPUT_QUEUED_FIELDS,
  PENDING_INPUT_RECORD_FIELDS,
  PENDING_INPUT_SOURCES,
  PENDING_INPUT_STATUSES,
  READ_RUN_EVENTS_FIELDS,
  READ_SESSION_EVENTS_FIELDS,
  RUNS_LISTED_FIELDS,
  RUN_EVENTS_FIELDS,
  RUN_KINDS,
  RUN_RECORD_FIELDS,
  RUN_SNAPSHOT_FIELDS,
  RUN_STATUSES,
  SESSIONS_LISTED_FIELDS,
  SESSION_EVENTS_FIELDS,
  SESSION_RECORD_FIELDS,
  SESSION_STATUSES,
  TASK_APPROVAL_FIELDS,
  TASK_BACKGROUND_TASK_FIELDS,
  TASK_CACHE_FIELDS,
  TASK_CURRENT_RUN_FIELDS,
  TASK_MESSAGE_FIELDS,
  TASK_PROGRESS_FIELDS,
  TASK_SNAPSHOT_FIELDS,
  TASK_TOOL_CALL_FIELDS,
  TASK_USAGE_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalArray,
  optionalBoolean,
  optionalEnum,
  optionalEventCursorDiagnostic,
  optionalEventReplayCursor,
  optionalInteger,
  optionalNullableNumber,
  optionalNullableString,
  optionalNumber,
  optionalString,
  optionalStringArray,
  rejectUnknownFields,
  requiredArray,
  requiredBoolean,
  requiredEnum,
  requiredEventLogMetadata,
  requiredInteger,
  requiredNumber,
  requiredRecord,
  requiredString,
} from "./common.js";

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

export function validateListRunsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListRunsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_RUNS_FIELDS, issues);

  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-runs message", issues);

  return ok({
    type: "list-runs",
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateReadSessionEventsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ReadSessionEventsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, READ_SESSION_EVENTS_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true,
  });
  const maxEvents = optionalInteger(
    input,
    "maxEvents",
    "$.maxEvents",
    issues,
    { min: 1 }
  );
  const cursor = optionalEventReplayCursor(input, "cursor", "$.cursor", issues);

  if (issues.length > 0) {
    return invalid("Invalid read-session-events message", issues);
  }

  return ok({
    type: "read-session-events",
    sessionId: sessionId as string,
    ...(afterSequence !== undefined ? { afterSequence } : {}),
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    ...(maxEvents !== undefined ? { maxEvents } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
}

export function validateReadRunEventsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ReadRunEventsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, READ_RUN_EVENTS_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true,
  });
  const includeSnapshot = optionalBoolean(
    input,
    "includeSnapshot",
    "$.includeSnapshot",
    issues
  );
  const maxEvents = optionalInteger(
    input,
    "maxEvents",
    "$.maxEvents",
    issues,
    { min: 1 }
  );
  const cursor = optionalEventReplayCursor(input, "cursor", "$.cursor", issues);

  if (issues.length > 0) {
    return invalid("Invalid read-run-events message", issues);
  }

  return ok({
    type: "read-run-events",
    runId: runId as string,
    ...(afterSequence !== undefined ? { afterSequence } : {}),
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    ...(includeSnapshot !== undefined ? { includeSnapshot } : {}),
    ...(maxEvents !== undefined ? { maxEvents } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
}

export function validateGetRunSnapshotMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetRunSnapshotMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_RUN_SNAPSHOT_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) {
    return invalid("Invalid get-run-snapshot message", issues);
  }

  return ok({ type: "get-run-snapshot", runId: runId as string });
}

export function validateEnqueuePendingInputMessage(
  input: UnknownRecord
): ProtocolValidationResult<EnqueuePendingInputMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, ENQUEUE_PENDING_INPUT_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const text = requiredString(input, "text", "$.text", issues, { nonEmpty: true });
  const runId = optionalString(input, "runId", "$.runId", issues, { nonEmpty: true });
  const mode = optionalEnum(input, "mode", "$.mode", PENDING_INPUT_MODES, issues);
  const inputId = optionalString(input, "inputId", "$.inputId", issues, { nonEmpty: true });
  const source = optionalEnum(input, "source", "$.source", PENDING_INPUT_SOURCES, issues);
  if ("metadata" in input && !isRecord(input.metadata)) {
    issues.push({ path: "$.metadata", message: "Expected object" });
  }

  if (issues.length > 0) return invalid("Invalid enqueue-pending-input message", issues);

  return ok({
    type: "enqueue-pending-input",
    sessionId: sessionId as string,
    text: text as string,
    ...(runId !== undefined ? { runId } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(inputId !== undefined ? { inputId } : {}),
    ...(source !== undefined ? { source } : {}),
    ...("metadata" in input ? { metadata: input.metadata as JsonObject } : {}),
  });
}

export function validateCancelPendingInputMessage(
  input: UnknownRecord
): ProtocolValidationResult<CancelPendingInputMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CANCEL_PENDING_INPUT_FIELDS, issues);

  const inputId = requiredString(input, "inputId", "$.inputId", issues, { nonEmpty: true });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const reason = optionalString(input, "reason", "$.reason", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid cancel-pending-input message", issues);

  return ok({
    type: "cancel-pending-input",
    inputId: inputId as string,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(reason !== undefined ? { reason } : {}),
  });
}

export function validateDispatchPendingInputMessage(
  input: UnknownRecord
): ProtocolValidationResult<DispatchPendingInputMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DISPATCH_PENDING_INPUT_FIELDS, issues);

  const inputId = requiredString(input, "inputId", "$.inputId", issues, { nonEmpty: true });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const targetRunId = optionalString(input, "targetRunId", "$.targetRunId", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid dispatch-pending-input message", issues);

  return ok({
    type: "dispatch-pending-input",
    inputId: inputId as string,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(targetRunId !== undefined ? { targetRunId } : {}),
  });
}

export function validateListPendingInputsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListPendingInputsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_PENDING_INPUTS_FIELDS, issues);

  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid list-pending-inputs message", issues);

  return ok({
    type: "list-pending-inputs",
    ...(sessionId !== undefined ? { sessionId } : {}),
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
    type: "sessions-listed",
    sessions: sessions as SessionsListedMessage["sessions"],
    ...(summaries !== undefined ? { summaries: summaries as SessionsListedMessage["summaries"] } : {}),
    ...(eventLog !== undefined ? { eventLog } : {}),
    ...("diagnostics" in input ? { diagnostics: input.diagnostics as SessionsListedMessage["diagnostics"] } : {}),
  });
}

export function validateRunsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<RunsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RUNS_LISTED_FIELDS, issues);

  const runs = requiredArray(input, "runs", "$.runs", issues);
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  if (runs) {
    runs.forEach((run, index) =>
      validateRunRecord(run, `$.runs[${index}]`, issues)
    );
  }

  if (issues.length > 0) return invalid("Invalid runs-listed message", issues);

  return ok({
    type: "runs-listed",
    runs: runs as RunsListedMessage["runs"],
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateSessionEventsMessage(
  input: UnknownRecord
): ProtocolValidationResult<SessionEventsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SESSION_EVENTS_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  const events = requiredArray(input, "events", "$.events", issues);
  const eventLog = requiredEventLogMetadata(input, "eventLog", "$.eventLog", issues);
  const cursorDiagnostic = optionalEventCursorDiagnostic(input, "cursorDiagnostic", "$.cursorDiagnostic", issues);
  if ("diagnostics" in input) {
    validateEventReadDiagnostics(input.diagnostics, "$.diagnostics", issues);
  }
  const nextAfterSequence = requiredInteger(
    input,
    "nextAfterSequence",
    "$.nextAfterSequence",
    issues,
    { min: 0 }
  );
  const hasMore = optionalBoolean(input, "hasMore", "$.hasMore", issues);
  const nextCursor = optionalEventReplayCursor(input, "nextCursor", "$.nextCursor", issues);
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true,
  });

  if (events) {
    events.forEach((event, index) =>
      validateOrchestratorEvent(event, `$.events[${index}]`, issues)
    );
  }

  if (issues.length > 0) return invalid("Invalid session-events message", issues);

  return ok({
    type: "session-events",
    sessionId: sessionId as string,
    events: events as SessionEventsMessage["events"],
    eventLog: eventLog as SessionEventsMessage["eventLog"],
    ...(cursorDiagnostic !== undefined ? { cursorDiagnostic } : {}),
    ...("diagnostics" in input ? { diagnostics: input.diagnostics as SessionEventsMessage["diagnostics"] } : {}),
    nextAfterSequence: nextAfterSequence as number,
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(afterSequence !== undefined ? { afterSequence } : {}),
    ...(lastEventId !== undefined ? { lastEventId } : {}),
  });
}

export function validateRunEventsMessage(
  input: UnknownRecord
): ProtocolValidationResult<RunEventsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RUN_EVENTS_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const events = requiredArray(input, "events", "$.events", issues);
  const eventLog = requiredEventLogMetadata(input, "eventLog", "$.eventLog", issues);
  const cursorDiagnostic = optionalEventCursorDiagnostic(input, "cursorDiagnostic", "$.cursorDiagnostic", issues);
  if ("diagnostics" in input) {
    validateEventReadDiagnostics(input.diagnostics, "$.diagnostics", issues);
  }
  const nextAfterSequence = requiredInteger(
    input,
    "nextAfterSequence",
    "$.nextAfterSequence",
    issues,
    { min: 0 }
  );
  const hasMore = optionalBoolean(input, "hasMore", "$.hasMore", issues);
  const nextCursor = optionalEventReplayCursor(input, "nextCursor", "$.nextCursor", issues);
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true,
  });

  if (events) {
    events.forEach((event, index) =>
      validateOrchestratorEvent(event, `$.events[${index}]`, issues)
    );
  }
  if ("snapshot" in input) {
    validateTaskSnapshot(input.snapshot, "$.snapshot", issues);
  }

  if (issues.length > 0) return invalid("Invalid run-events message", issues);

  return ok({
    type: "run-events",
    runId: runId as string,
    events: events as RunEventsMessage["events"],
    eventLog: eventLog as RunEventsMessage["eventLog"],
    ...(cursorDiagnostic !== undefined ? { cursorDiagnostic } : {}),
    ...("diagnostics" in input ? { diagnostics: input.diagnostics as RunEventsMessage["diagnostics"] } : {}),
    nextAfterSequence: nextAfterSequence as number,
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(afterSequence !== undefined ? { afterSequence } : {}),
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    ...("snapshot" in input ? { snapshot: input.snapshot as RunEventsMessage["snapshot"] } : {}),
  });
}

export function validateRunSnapshotMessage(
  input: UnknownRecord
): ProtocolValidationResult<RunSnapshotMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RUN_SNAPSHOT_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  validateTaskSnapshot(input.snapshot, "$.snapshot", issues);

  if (issues.length > 0) return invalid("Invalid run-snapshot message", issues);

  return ok({
    type: "run-snapshot",
    runId: runId as string,
    snapshot: input.snapshot as RunSnapshotMessage["snapshot"],
  });
}

export function validatePendingInputQueuedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PendingInputQueuedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PENDING_INPUT_QUEUED_FIELDS, issues);
  validatePendingInputRecord(input.input, "$.input", issues);
  validateOrchestratorEvent(input.event, "$.event", issues);

  if (issues.length > 0) return invalid("Invalid pending-input-queued message", issues);

  return ok({
    type: "pending-input-queued",
    input: input.input as PendingInputQueuedMessage["input"],
    event: input.event as PendingInputQueuedMessage["event"],
  });
}

export function validatePendingInputCancelledMessage(
  input: UnknownRecord
): ProtocolValidationResult<PendingInputCancelledMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PENDING_INPUT_CANCELLED_FIELDS, issues);
  validatePendingInputRecord(input.input, "$.input", issues);
  validateOrchestratorEvent(input.event, "$.event", issues);

  if (issues.length > 0) return invalid("Invalid pending-input-cancelled message", issues);

  return ok({
    type: "pending-input-cancelled",
    input: input.input as PendingInputCancelledMessage["input"],
    event: input.event as PendingInputCancelledMessage["event"],
  });
}

export function validatePendingInputDispatchedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PendingInputDispatchedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PENDING_INPUT_DISPATCHED_FIELDS, issues);
  validatePendingInputRecord(input.input, "$.input", issues);
  validateOrchestratorEvent(input.event, "$.event", issues);

  if (issues.length > 0) return invalid("Invalid pending-input-dispatched message", issues);

  return ok({
    type: "pending-input-dispatched",
    input: input.input as PendingInputDispatchedMessage["input"],
    event: input.event as PendingInputDispatchedMessage["event"],
  });
}

export function validatePendingInputsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PendingInputsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PENDING_INPUTS_LISTED_FIELDS, issues);
  const inputs = requiredArray(input, "inputs", "$.inputs", issues);
  inputs?.forEach((record, index) => validatePendingInputRecord(record, `$.inputs[${index}]`, issues));
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid pending-inputs-listed message", issues);

  return ok({
    type: "pending-inputs-listed",
    inputs: inputs as PendingInputsListedMessage["inputs"],
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
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

export function validatePendingInputRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PENDING_INPUT_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString(value, "text", `${path}.text`, issues, { nonEmpty: true });
  requiredEnum(value, "mode", `${path}.mode`, PENDING_INPUT_MODES, issues);
  requiredEnum(value, "status", `${path}.status`, PENDING_INPUT_STATUSES, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("runId" in value) {
    optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  }
  if ("source" in value) {
    optionalEnum(value, "source", `${path}.source`, PENDING_INPUT_SOURCES, issues);
  }
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateRunRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, RUN_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "cwd", `${path}.cwd`, issues);
  requiredEnum(value, "status", `${path}.status`, RUN_STATUSES, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("startedAt" in value) {
    optionalString(value, "startedAt", `${path}.startedAt`, issues, {
      nonEmpty: true,
    });
  }
  if ("finishedAt" in value) {
    optionalString(value, "finishedAt", `${path}.finishedAt`, issues, {
      nonEmpty: true,
    });
  }
  if ("outcome" in value) {
    optionalString(value, "outcome", `${path}.outcome`, issues, {
      nonEmpty: true,
    });
  }
  if ("reason" in value) {
    optionalString(value, "reason", `${path}.reason`, issues, {
      nonEmpty: true,
    });
  }
  if ("outcomeDetail" in value && !isRecord(value.outcomeDetail)) {
    issues.push({ path: `${path}.outcomeDetail`, message: "Expected object" });
  }
  if ("error" in value) {
    optionalString(value, "error", `${path}.error`, issues);
  }
  if ("kind" in value) {
    optionalEnum(value, "kind", `${path}.kind`, RUN_KINDS, issues);
  }
  if ("goal" in value) {
    validateGoalRunState(value.goal, `${path}.goal`, issues);
  }
  if ("lastEventId" in value) {
    optionalString(value, "lastEventId", `${path}.lastEventId`, issues, {
      nonEmpty: true,
    });
  }
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateGoalRunState(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, GOAL_STATE_FIELDS, issues, path);
  requiredEnum(value, "status", `${path}.status`, GOAL_RUN_STATUSES, issues);
  if ("visibleGoal" in value) {
    optionalString(value, "visibleGoal", `${path}.visibleGoal`, issues);
  }
  requiredInteger(value, "maxRounds", `${path}.maxRounds`, issues, { min: 1 });
  requiredInteger(value, "maxStalledRounds", `${path}.maxStalledRounds`, issues, { min: 1 });
  requiredInteger(value, "currentRound", `${path}.currentRound`, issues, { min: 0 });
  requiredInteger(value, "completedRounds", `${path}.completedRounds`, issues, { min: 0 });
  requiredInteger(value, "stalledRounds", `${path}.stalledRounds`, issues, { min: 0 });
  if ("stoppedReason" in value) {
    optionalEnum(value, "stoppedReason", `${path}.stoppedReason`, GOAL_STOPPED_REASONS, issues);
  }
  if ("lastProgressSignature" in value) {
    optionalString(value, "lastProgressSignature", `${path}.lastProgressSignature`, issues);
  }
  if ("lastDecision" in value) {
    validateGoalContinuationDecision(value.lastDecision, `${path}.lastDecision`, issues);
  }
}

export function validateGoalContinuationDecision(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, GOAL_DECISION_FIELDS, issues, path);
  requiredEnum(value, "action", `${path}.action`, GOAL_CONTINUATION_ACTIONS, issues);
  requiredString(value, "reason", `${path}.reason`, issues);
  if ("prompt" in value) {
    optionalString(value, "prompt", `${path}.prompt`, issues);
  }
  if ("progressSignature" in value) {
    optionalString(value, "progressSignature", `${path}.progressSignature`, issues);
  }
  if ("detail" in value && !isRecord(value.detail)) {
    issues.push({ path: `${path}.detail`, message: "Expected object" });
  }
}

export function validateOrchestratorEvent(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, ORCHESTRATOR_EVENT_FIELDS, issues, path);
  const protocolVersion = requiredInteger(
    value,
    "protocolVersion",
    `${path}.protocolVersion`,
    issues,
    { min: 1 }
  );
  if (protocolVersion !== undefined && protocolVersion !== 1) {
    issues.push({
      path: `${path}.protocolVersion`,
      message: "Expected orchestrator protocol version 1",
    });
  }
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredInteger(value, "sequence", `${path}.sequence`, issues, { min: 1 });
  requiredEnum(value, "type", `${path}.type`, ORCHESTRATOR_EVENT_TYPES, issues);
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  if ("runId" in value) {
    optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  }
  requiredString(value, "timestamp", `${path}.timestamp`, issues, {
    nonEmpty: true,
  });
  requiredRecord(value, "payload", `${path}.payload`, issues);
}

export function validateAgentEvent(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  requiredString(value, "type", `${path}.type`, issues, { nonEmpty: true });

  if ("sessionId" in value) {
    optionalString(value, "sessionId", `${path}.sessionId`, issues, {
      nonEmpty: true,
    });
  }

  if ("timestamp" in value) {
    optionalString(value, "timestamp", `${path}.timestamp`, issues, {
      nonEmpty: true,
    });
  }
}

export function validateTaskSnapshot(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_SNAPSHOT_FIELDS, issues, path);
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  requiredEnum(value, "status", `${path}.status`, RUN_STATUSES, issues);
  requiredString(value, "title", `${path}.title`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "progressLabel", `${path}.progressLabel`, issues);

  const messages = requiredArray(value, "messages", `${path}.messages`, issues);
  messages?.forEach((message, index) =>
    validateTaskMessage(message, `${path}.messages[${index}]`, issues)
  );

  if ("latestError" in value) {
    optionalString(value, "latestError", `${path}.latestError`, issues);
  }
  if ("approval" in value && value.approval !== undefined) {
    validateTaskApproval(value.approval, `${path}.approval`, issues);
  }

  const pendingToolCalls = requiredArray(
    value,
    "pendingToolCalls",
    `${path}.pendingToolCalls`,
    issues
  );
  pendingToolCalls?.forEach((toolCall, index) =>
    validateTaskToolCall(toolCall, `${path}.pendingToolCalls[${index}]`, issues)
  );

  const backgroundTasks = requiredArray(
    value,
    "backgroundTasks",
    `${path}.backgroundTasks`,
    issues
  );
  backgroundTasks?.forEach((task, index) =>
    validateTaskBackgroundTask(task, `${path}.backgroundTasks[${index}]`, issues)
  );

  validateTaskProgress(value.progress, `${path}.progress`, issues);
  validateTaskUsage(value.usage, `${path}.usage`, issues);
  validateTaskCache(value.cache, `${path}.cache`, issues);
  validateTaskCurrentRun(value.currentRun, `${path}.currentRun`, issues);
}

export function validateTaskMessage(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_MESSAGE_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "role", `${path}.role`, ["system", "user", "assistant"], issues);
  requiredString(value, "content", `${path}.content`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  if ("toolCalls" in value) {
    const toolCalls = requiredArray(value, "toolCalls", `${path}.toolCalls`, issues);
    toolCalls?.forEach((toolCall, index) =>
      validateTaskToolCall(toolCall, `${path}.toolCalls[${index}]`, issues)
    );
  }
}

export function validateTaskToolCall(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_TOOL_CALL_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "name", `${path}.name`, issues, { nonEmpty: true });
  requiredRecord(value, "input", `${path}.input`, issues);
  requiredEnum(
    value,
    "status",
    `${path}.status`,
    ["pending", "running", "approval-required", "completed", "failed"],
    issues
  );
  if ("summary" in value) optionalString(value, "summary", `${path}.summary`, issues);
  requiredString(value, "startedAt", `${path}.startedAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("output" in value) optionalString(value, "output", `${path}.output`, issues);
  if ("approvalMetadata" in value && !isRecord(value.approvalMetadata)) {
    issues.push({ path: `${path}.approvalMetadata`, message: "Expected object" });
  }
}

export function validateTaskApproval(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_APPROVAL_FIELDS, issues, path);
  requiredString(value, "toolCallId", `${path}.toolCallId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "toolName", `${path}.toolName`, issues, {
    nonEmpty: true,
  });
  requiredRecord(value, "input", `${path}.input`, issues);
  requiredString(value, "summary", `${path}.summary`, issues);
  requiredString(value, "requestedAt", `${path}.requestedAt`, issues, {
    nonEmpty: true,
  });
  requiredEnum(value, "status", `${path}.status`, ["pending"], issues);
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
}

export function validateTaskProgress(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_PROGRESS_FIELDS, issues, path);
  requiredString(value, "label", `${path}.label`, issues);
  requiredInteger(value, "eventCount", `${path}.eventCount`, issues, { min: 0 });
  requiredInteger(value, "turnCount", `${path}.turnCount`, issues, { min: 0 });
  requiredInteger(value, "textDeltaCount", `${path}.textDeltaCount`, issues, { min: 0 });
  requiredInteger(value, "toolCallCount", `${path}.toolCallCount`, issues, { min: 0 });
  requiredInteger(value, "completedToolCallCount", `${path}.completedToolCallCount`, issues, { min: 0 });
  requiredInteger(value, "pendingToolCallCount", `${path}.pendingToolCallCount`, issues, { min: 0 });
  requiredBoolean(value, "approvalPending", `${path}.approvalPending`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateTaskUsage(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_USAGE_FIELDS, issues, path);
  requiredInteger(value, "sampleCount", `${path}.sampleCount`, issues, { min: 0 });
  requiredInteger(value, "promptTokens", `${path}.promptTokens`, issues, { min: 0 });
  requiredInteger(value, "completionTokens", `${path}.completionTokens`, issues, { min: 0 });
  requiredInteger(value, "totalTokens", `${path}.totalTokens`, issues, { min: 0 });
  requiredInteger(value, "reasoningTokens", `${path}.reasoningTokens`, issues, { min: 0 });
}

export function validateTaskCache(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_CACHE_FIELDS, issues, path);
  requiredInteger(value, "sampleCount", `${path}.sampleCount`, issues, { min: 0 });
  requiredInteger(value, "promptTokens", `${path}.promptTokens`, issues, { min: 0 });
  requiredInteger(value, "readTokens", `${path}.readTokens`, issues, { min: 0 });
  requiredInteger(value, "writeTokens", `${path}.writeTokens`, issues, { min: 0 });
  requiredInteger(value, "missTokens", `${path}.missTokens`, issues, { min: 0 });
  requiredNumber(value, "hitRatio", `${path}.hitRatio`, issues, { min: 0, max: 1 });
  requiredNumber(value, "writeRatio", `${path}.writeRatio`, issues, { min: 0 });
  if ("stablePrefixHash" in value) optionalString(value, "stablePrefixHash", `${path}.stablePrefixHash`, issues);
  if ("cacheKey" in value) optionalString(value, "cacheKey", `${path}.cacheKey`, issues);
  if ("cacheStrategy" in value) optionalString(value, "cacheStrategy", `${path}.cacheStrategy`, issues);
}

export function validateTaskBackgroundTask(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_BACKGROUND_TASK_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, ["command"], issues);
  requiredString(value, "title", `${path}.title`, issues);
  requiredEnum(
    value,
    "state",
    `${path}.state`,
    ["running", "succeeded", "failed", "cancelled", "timed-out"],
    issues
  );
  requiredString(value, "command", `${path}.command`, issues);
  if ("cwd" in value) optionalString(value, "cwd", `${path}.cwd`, issues);
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("finishedAt" in value) optionalString(value, "finishedAt", `${path}.finishedAt`, issues);
  if ("durationMs" in value) optionalNumber(value, "durationMs", `${path}.durationMs`, issues, { min: 0 });
  if ("exitCode" in value) optionalNullableNumber(value, "exitCode", `${path}.exitCode`, issues);
  if ("signal" in value) optionalNullableString(value, "signal", `${path}.signal`, issues);
  if ("outputPreview" in value) optionalString(value, "outputPreview", `${path}.outputPreview`, issues);
}

export function validateTaskCurrentRun(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_CURRENT_RUN_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "cwd", `${path}.cwd`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues);
  if ("finishedAt" in value) optionalString(value, "finishedAt", `${path}.finishedAt`, issues);
  requiredRecord(value, "metadata", `${path}.metadata`, issues);
}

export function validateEventReadDiagnostics(
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
    [
      "mode",
      "requestedAfterSequence",
      "storeReadAfterSequence",
      "projectedAfterSequence",
      "eventsFetched",
      "eventsReturned",
      "truncated",
      "maxEvents",
      "queryMs",
    ],
    issues,
    path
  );
  requiredEnum(input, "mode", `${path}.mode`, ["incremental", "full-replay", "cursor-replay"] as const, issues);
  requiredInteger(input, "requestedAfterSequence", `${path}.requestedAfterSequence`, issues, { min: 0 });
  requiredInteger(input, "storeReadAfterSequence", `${path}.storeReadAfterSequence`, issues, { min: 0 });
  requiredInteger(input, "projectedAfterSequence", `${path}.projectedAfterSequence`, issues, { min: 0 });
  requiredInteger(input, "eventsFetched", `${path}.eventsFetched`, issues, { min: 0 });
  if ("eventsReturned" in input) {
    optionalInteger(input, "eventsReturned", `${path}.eventsReturned`, issues, { min: 0 });
  }
  if ("truncated" in input) {
    optionalBoolean(input, "truncated", `${path}.truncated`, issues);
  }
  if ("maxEvents" in input) {
    optionalInteger(input, "maxEvents", `${path}.maxEvents`, issues, { min: 1 });
  }
  requiredInteger(input, "queryMs", `${path}.queryMs`, issues, { min: 0 });
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
