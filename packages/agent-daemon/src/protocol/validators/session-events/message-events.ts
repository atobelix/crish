// Protocol validators: session-events message family
import type {
  CancelPendingInputMessage,
  DispatchPendingInputMessage,
  GetRunSnapshotMessage,
  ListPendingInputsMessage,
  ListRunsMessage,
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
  EnqueuePendingInputMessage,
} from "../../../types.js";
import type {
  JsonObject,
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "../base.js";
import {
  CANCEL_PENDING_INPUT_FIELDS,
  DISPATCH_PENDING_INPUT_FIELDS,
  ENQUEUE_PENDING_INPUT_FIELDS,
  GET_RUN_SNAPSHOT_FIELDS,
  LIST_PENDING_INPUTS_FIELDS,
  LIST_RUNS_FIELDS,
  PENDING_INPUTS_LISTED_FIELDS,
  PENDING_INPUT_CANCELLED_FIELDS,
  PENDING_INPUT_DISPATCHED_FIELDS,
  PENDING_INPUT_MODES,
  PENDING_INPUT_QUEUED_FIELDS,
  PENDING_INPUT_SOURCES,
  READ_RUN_EVENTS_FIELDS,
  READ_SESSION_EVENTS_FIELDS,
  RUNS_LISTED_FIELDS,
  RUN_EVENTS_FIELDS,
  RUN_SNAPSHOT_FIELDS,
  SESSION_EVENTS_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalBoolean,
  optionalEnum,
  optionalEventCursorDiagnostic,
  optionalEventReplayCursor,
  optionalInteger,
  optionalString,
  rejectUnknownFields,
  requiredArray,
  requiredEventLogMetadata,
  requiredInteger,
  requiredString,
} from "../base.js";
import {
  validateEventReadDiagnostics,
  validateOrchestratorEvent,
  validatePendingInputRecord,
  validateRunRecord,
  validateTaskSnapshot,
} from "./state-events.js";

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
    type: "session-events" as const,
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
  } as SessionEventsMessage);
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
    type: "run-events" as const,
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
  } as RunEventsMessage);
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
