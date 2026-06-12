/**
 * Protocol schema — session / run query validators.
 *
 * Extracted from schema.ts.
 */
import type {
  ListSessionsMessage,
  ReadSessionEventsMessage,
  RunEventsMessage,
  RunSnapshotMessage,
  RunsListedMessage,
  SessionEventsMessage,
  SessionsListedMessage,
} from "../../types.js";
import {
  type ProtocolValidationIssue,
  type ProtocolValidationResult,
  type UnknownRecord,
  PENDING_INPUT_MODES,
  PENDING_INPUT_SOURCES,
  PENDING_INPUT_STATUSES,
  RUN_STATUSES,
  SESSION_STATUSES,
  invalid,
  isRecord,
  ok,
  optionalArray,
  optionalBoolean,
  optionalEnum,
  optionalEventCursorDiagnostic,
  optionalEventReplayCursor,
  optionalInteger,
  optionalString,
  optionalStringArray,
  rejectUnknownFields,
  requiredArray,
  requiredEnum,
  requiredEventLogMetadata,
  requiredInteger,
  requiredString,
  validateEventReadDiagnostics,
  validateSessionListDiagnostics,
} from "./schema-core.js";
import {
  LIST_SESSIONS_FIELDS,
  PENDING_INPUT_RECORD_FIELDS,
  READ_SESSION_EVENTS_FIELDS,
  RUN_EVENTS_FIELDS,
  RUN_SNAPSHOT_FIELDS,
  RUNS_LISTED_FIELDS,
  SESSION_EVENTS_FIELDS,
  SESSION_RECORD_FIELDS,
  SESSIONS_LISTED_FIELDS,
} from "./schema-fields.js";
import {
  validateOrchestratorEvent,
  validateRunRecord,
  validateTaskSnapshot,
} from "./schema-runs.js";

// ─── Command validators ───────────────────────────────────────

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

// ─── Response validators ──────────────────────────────────────

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

// ─── Record sub-validators ────────────────────────────────────

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
