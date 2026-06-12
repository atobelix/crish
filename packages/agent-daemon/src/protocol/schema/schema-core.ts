/**
 * Protocol schema core — shared types, enum value arrays, and low-level validation helpers.
 *
 * Extracted from schema.ts to serve as the foundation for domain-specific schema modules.
 */
import type { JsonObject } from "@crish/shared-types";
import { validatePlanDocument } from "@crish/agent-runtime";
import { isRecord as isRecordShared, isJsonObject, isJsonValue } from "@crish/shared-utils";
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
  DaemonEventCursorDiagnostic,
  DaemonEventReplayCursor,
  DaemonInboundMessage,
  DaemonOutboundMessage,
  CreateWorkflowMessage,
  SessionEventsMessage,
  PatchPlanDocumentMessage,
} from "../../types.js";
import { isDailyTime, isValidTimeZone } from "../../workflow-store.js";
import {
  DAEMON_INBOUND_MESSAGE_TYPES,
  DAEMON_OUTBOUND_MESSAGE_TYPES,
} from "../registry.js";

// ─── Core types ───────────────────────────────────────────────

export type ProtocolValidationErrorCode =
  | "INVALID_MESSAGE"
  | "UNKNOWN_MESSAGE_TYPE";

export interface ProtocolValidationIssue {
  path: string;
  message: string;
}

export interface ProtocolValidationError {
  code: ProtocolValidationErrorCode;
  message: string;
  issues: ProtocolValidationIssue[];
}

export type ProtocolValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProtocolValidationError };

export const INBOUND_MESSAGE_TYPES = DAEMON_INBOUND_MESSAGE_TYPES;
export const OUTBOUND_MESSAGE_TYPES = DAEMON_OUTBOUND_MESSAGE_TYPES;

export type UnknownRecord = Record<string, unknown>;
export const CORRELATION_FIELDS = ["requestId", "correlationId"] as const;

// ─── Enum value arrays ────────────────────────────────────────

export const SESSION_STATUSES = ["open", "closed", "archived"] as const;
export const PENDING_INPUT_MODES = ["after-current-run", "steer"] as const;
export const PENDING_INPUT_STATUSES = ["pending", "cancelled", "dispatched"] as const;
export const PENDING_INPUT_SOURCES = ["workbench", "daemon", "automation"] as const;
export const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting-approval",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
] as const;
export const WORKFLOW_RUN_STATUSES = ["running", "awaiting-approval", "completed", "failed", "cancelled"] as const;
export const BACKGROUND_TASK_STATES = ["running", "succeeded", "failed", "cancelled", "timed-out"] as const;
export const WORKFLOW_SCHEDULE_TYPES = ["manual", "daily", "intervalMinutes"] as const;
export const PROVIDER_CREDENTIAL_MODES = ["direct", "account-center", "auto"] as const;
export const PROVIDER_ENDPOINTS = ["auto", "responses", "chat-completions"] as const;
export const SYSTEM_PROMPT_WIRE_MODES = ["native-system-role", "user-prefix"] as const;
export const PROVIDER_READINESS_STATUSES = [
  "ready",
  "missing",
  "login-required",
  "insufficient-quota",
  "gateway-unavailable",
  "credential-unavailable",
  "invalid-response",
  "unknown",
] as const;
export const PROVIDER_API_KEY_SOURCES = ["default", "env", "runtime-update", "user-config", "workspace-config", "unset", "unknown"] as const;
export const ACCOUNT_LOGIN_STATUSES = ["ready", "required", "unknown"] as const;
export const ACCOUNT_QUOTA_STATUSES = ["ready", "insufficient", "unknown"] as const;
export const ACCOUNT_GATEWAY_STATUSES = ["ready", "unavailable", "unknown"] as const;
export const ACCOUNT_RUNTIME_CREDENTIAL_STATUSES = ["ready", "unavailable", "unknown"] as const;
export const DAEMON_LIFECYCLE_STATES = ["starting", "ready", "stopping", "stopped", "degraded"] as const;
export const LIFECYCLE_DIAGNOSTIC_SOURCES = ["daemon", "websocket", "client", "event-store", "provider", "mcp"] as const;
export const LIFECYCLE_DIAGNOSTIC_SEVERITIES = ["warning", "error"] as const;
export const EVENT_STORE_STATUSES = ["ok", "failed"] as const;
export const MCP_READINESS_STATUSES = ["ready", "degraded", "starting", "stopped", "unknown"] as const;
export const CAPABILITY_STATES = ["implemented", "experimental", "unsupported", "degraded", "backend-not-wired"] as const;
export const CAPABILITY_OWNERS = ["agent-daemon", "agent-runtime", "agent-orchestrator", "workbench", "tauri"] as const;
export const CAPABILITY_DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;
export const SCOPED_CONTEXT_KINDS = ["rule", "skill"] as const;
export const SCOPED_CONTEXT_SCOPES = ["global", "project", "workspace"] as const;
export const SCOPED_CONTEXT_ACTIVATIONS = ["enabled", "recommended", "disabled"] as const;
export const SCOPED_CONTEXT_STORE_STATUSES = ["ok", "degraded"] as const;
export const SCOPED_CONTEXT_SOURCE_TYPES = [
  "global-rule",
  "project-rule",
  "workspace-rule",
  "skill-file",
  "user",
  "system",
] as const;
export const SCOPED_CONTEXT_ITEM_STATUSES = ["active", "recommended", "disabled", "inapplicable"] as const;
export const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_SEVERITIES = ["info", "warning"] as const;
export const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_CODES = [
  "disabled",
  "scope-mismatch",
  "applies-to-mismatch",
  "empty-content",
] as const;
export const PROMPT_CONTEXT_BLOCK_KINDS = [
  "project-profile",
  "runtime-profile",
  "skills-hook",
  "memory-hook",
  "plan-hook",
  "custom-stable",
  "custom-volatile",
] as const;
export const RUN_KINDS = ["task", "goal"] as const;
export const APPROVAL_PROTOCOL_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export const GOAL_RUN_STATUSES = ["queued", "running", "completed", "blocked", "cancelled", "failed"] as const;
export const GOAL_STOPPED_REASONS = ["complete", "blocked", "max-rounds", "stalled", "cancelled", "error"] as const;
export const GOAL_CONTINUATION_ACTIONS = ["continue", "complete", "block"] as const;

// ─── Message base validation ──────────────────────────────────

export function validateMessageBase<const T extends readonly string[]>(
  value: unknown,
  allowedTypes: T
): ProtocolValidationResult<UnknownRecord & { type: T[number] }> {
  if (!isRecord(value)) {
    return invalid("Message must be a JSON object", [
      { path: "$", message: "Expected object" },
    ]);
  }

  const type = value.type;
  if (typeof type !== "string" || type.length === 0) {
    return invalid("Message type is required", [
      { path: "$.type", message: "Expected non-empty string" },
    ]);
  }

  if (!includesString(allowedTypes, type)) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_MESSAGE_TYPE",
        message: `Unknown message type: ${type}`,
        issues: [{ path: "$.type", message: `Unsupported message type: ${type}` }],
      },
    };
  }

  return ok(value as UnknownRecord & { type: T[number] });
}

export function withMessageCorrelation<T extends DaemonInboundMessage | DaemonOutboundMessage>(
  input: UnknownRecord,
  result: ProtocolValidationResult<T>
): ProtocolValidationResult<T> {
  if (!result.ok) return result;

  const issues: ProtocolValidationIssue[] = [];
  const requestId = optionalString(input, "requestId", "$.requestId", issues, {
    nonEmpty: true,
  });
  const correlationId = optionalString(input, "correlationId", "$.correlationId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid message correlation", issues);
  if (requestId === undefined && correlationId === undefined) return result;

  return ok({
    ...result.value,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
  });
}

// ─── Agent / orchestrator event validation ────────────────────

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

// ─── Low-level field validation helpers ───────────────────────

export function rejectUnknownFields(
  input: UnknownRecord,
  allowedFields: readonly string[],
  issues: ProtocolValidationIssue[],
  path = "$"
): void {
  for (const key of Object.keys(input)) {
    if (!includesString(allowedFields, key)) {
      issues.push({
        path: path === "$" ? `$.${key}` : `${path}.${key}`,
        message: "Unexpected field",
      });
    }
  }
}

export function requiredString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean } = {}
): string | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }

  return readString(input[key], path, issues, options);
}

export function optionalString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean } = {}
): string | undefined {
  if (!(key in input)) return undefined;
  return readString(input[key], path, issues, options);
}

export function validateOptionalNullableString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean } = {}
): void {
  if (!(key in input) || input[key] === null) return;
  readString(input[key], path, issues, options);
}

export function readString(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean }
): string | undefined {
  if (typeof value !== "string") {
    issues.push({ path, message: "Expected string" });
    return undefined;
  }

  if (options.nonEmpty && value.length === 0) {
    issues.push({ path, message: "Expected non-empty string" });
    return undefined;
  }

  return value;
}

export function requiredInteger(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number } = {}
): number | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }

  return readInteger(input[key], path, issues, options);
}

export function optionalInteger(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number } = {}
): number | undefined {
  if (!(key in input)) return undefined;
  return readInteger(input[key], path, issues, options);
}

export function requiredNumber(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }
  return readNumber(input[key], path, issues, options);
}

export function optionalNumber(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (!(key in input)) return undefined;
  return readNumber(input[key], path, issues, options);
}

export function optionalNullableNumber(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): number | null | undefined {
  if (!(key in input)) return undefined;
  if (input[key] === null) return null;
  return optionalNumber(input, key, path, issues);
}

export function requiredNullableInteger(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number } = {}
): number | null | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }
  if (input[key] === null) return null;
  return readInteger(input[key], path, issues, options);
}

export function readNumber(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "Expected number" });
    return undefined;
  }
  if (options.min !== undefined && value < options.min) {
    issues.push({ path, message: `Expected number >= ${options.min}` });
    return undefined;
  }
  if (options.max !== undefined && value > options.max) {
    issues.push({ path, message: `Expected number <= ${options.max}` });
    return undefined;
  }
  return value;
}

export function readInteger(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number }
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push({ path, message: "Expected integer" });
    return undefined;
  }

  if (options.min !== undefined && value < options.min) {
    issues.push({ path, message: `Expected integer >= ${options.min}` });
    return undefined;
  }

  return value;
}

export function optionalBoolean(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): boolean | undefined {
  if (!(key in input)) return undefined;
  if (typeof input[key] !== "boolean") {
    issues.push({ path, message: "Expected boolean" });
    return undefined;
  }
  return input[key];
}

export function requiredBoolean(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): boolean | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }
  if (typeof input[key] !== "boolean") {
    issues.push({ path, message: "Expected boolean" });
    return undefined;
  }
  return input[key];
}

export function optionalNullableString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string | null | undefined {
  if (!(key in input)) return undefined;
  return readNullableString(input[key], path, issues);
}

export function requiredNullableString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string | null | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }
  return readNullableString(input[key], path, issues);
}

export function readNullableString(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") {
    issues.push({ path, message: "Expected string or null" });
    return undefined;
  }
  if (value.length === 0) {
    issues.push({ path, message: "Expected non-empty string or null" });
    return undefined;
  }
  return value;
}

export function requiredWorkflowSchedule(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): CreateWorkflowMessage["schedule"] | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }
  return readWorkflowSchedule(input[key], path, issues);
}

export function optionalWorkflowSchedule(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): CreateWorkflowMessage["schedule"] | undefined {
  if (!(key in input)) return undefined;
  return readWorkflowSchedule(input[key], path, issues);
}

export function readWorkflowSchedule(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): CreateWorkflowMessage["schedule"] | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return undefined;
  }

  const type = requiredEnum(value, "type", `${path}.type`, WORKFLOW_SCHEDULE_TYPES, issues);
  if (type === undefined) return undefined;

  if (type === "manual") {
    rejectUnknownFields(value, ["type"], issues, path);
    return { type };
  }

  if (type === "daily") {
    rejectUnknownFields(value, ["type", "time", "timezone"], issues, path);
    const time = requiredString(value, "time", `${path}.time`, issues, {
      nonEmpty: true,
    });
    const timezone = requiredString(value, "timezone", `${path}.timezone`, issues, {
      nonEmpty: true,
    });
    if (typeof time === "string" && !isDailyTime(time)) {
      issues.push({ path: `${path}.time`, message: "Expected HH:mm" });
    }
    if (typeof timezone === "string" && !isValidTimeZone(timezone)) {
      issues.push({ path: `${path}.timezone`, message: "Expected valid IANA timezone" });
    }
    return {
      type,
      time: time as string,
      timezone: timezone as string,
    };
  }

  rejectUnknownFields(value, ["type", "intervalMinutes"], issues, path);
  const intervalMinutes = requiredInteger(
    value,
    "intervalMinutes",
    `${path}.intervalMinutes`,
    issues,
    { min: 1 }
  );
  return {
    type,
    intervalMinutes: intervalMinutes as number,
  };
}

export function optionalJsonObject(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): JsonObject | undefined {
  if (!(key in input)) return undefined;
  if (!isJsonObject(input[key])) {
    issues.push({ path, message: "Expected JSON object" });
    return undefined;
  }
  return input[key] as JsonObject;
}

export function requiredEventLogMetadata(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): SessionEventsMessage["eventLog"] | undefined {
  const value = requiredRecord(input, key, path, issues);
  if (!value) return undefined;
  return readEventLogMetadata(value, path, issues);
}

export function readEventLogMetadata(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): SessionEventsMessage["eventLog"] | undefined {
  rejectUnknownFields(value, ["eventLogId", "generation", "schemaVersion", "protocolVersion"], issues, path);
  const eventLogId = requiredString(value, "eventLogId", `${path}.eventLogId`, issues, { nonEmpty: true });
  const generation = requiredInteger(value, "generation", `${path}.generation`, issues, { min: 1 });
  const schemaVersion = requiredInteger(value, "schemaVersion", `${path}.schemaVersion`, issues, { min: 1 });
  const protocolVersion = requiredInteger(value, "protocolVersion", `${path}.protocolVersion`, issues, { min: 1 });
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    issues.push({ path: `${path}.schemaVersion`, message: "Expected 1" });
  }
  if (protocolVersion !== undefined && protocolVersion !== 1) {
    issues.push({ path: `${path}.protocolVersion`, message: "Expected 1" });
  }
  if (eventLogId === undefined || generation === undefined || schemaVersion === undefined || protocolVersion === undefined) {
    return undefined;
  }
  return { eventLogId, generation, schemaVersion: schemaVersion as 1, protocolVersion: protocolVersion as 1 };
}

export function optionalEventReplayCursor(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): DaemonEventReplayCursor | undefined {
  if (!(key in input)) return undefined;
  if (!isRecord(input[key])) {
    issues.push({ path, message: "Expected object" });
    return undefined;
  }
  return readEventReplayCursor(input[key], path, issues);
}

export function readEventReplayCursor(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): DaemonEventReplayCursor | undefined {
  rejectUnknownFields(value, ["eventLogId", "generation", "schemaVersion", "protocolVersion", "afterSequence", "lastEventId"], issues, path);
  const eventLogId = requiredString(value, "eventLogId", `${path}.eventLogId`, issues, { nonEmpty: true });
  const generation = requiredInteger(value, "generation", `${path}.generation`, issues, { min: 1 });
  const schemaVersion = requiredInteger(value, "schemaVersion", `${path}.schemaVersion`, issues, { min: 1 });
  const protocolVersion = requiredInteger(value, "protocolVersion", `${path}.protocolVersion`, issues, { min: 1 });
  const afterSequence = requiredInteger(value, "afterSequence", `${path}.afterSequence`, issues, { min: 0 });
  const lastEventId = optionalString(value, "lastEventId", `${path}.lastEventId`, issues, { nonEmpty: true });
  if (
    eventLogId === undefined ||
    generation === undefined ||
    schemaVersion === undefined ||
    protocolVersion === undefined ||
    afterSequence === undefined
  ) {
    return undefined;
  }
  return {
    eventLogId,
    generation,
    schemaVersion,
    protocolVersion,
    afterSequence,
    ...(lastEventId !== undefined ? { lastEventId } : {}),
  };
}

export function optionalEventCursorDiagnostic(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): DaemonEventCursorDiagnostic | undefined {
  if (!(key in input)) return undefined;
  if (!isRecord(input[key])) {
    issues.push({ path, message: "Expected object" });
    return undefined;
  }
  const value = input[key];
  rejectUnknownFields(value, ["code", "message", "severity", "previous", "current", "replayedFromSequence"], issues, path);
  const code = requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  if (code !== undefined && code !== "EVENT_LOG_CURSOR_MISMATCH") {
    issues.push({ path: `${path}.code`, message: "Expected EVENT_LOG_CURSOR_MISMATCH" });
  }
  const message = requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
  const severity = requiredString(value, "severity", `${path}.severity`, issues, { nonEmpty: true });
  if (severity !== undefined && severity !== "warning") {
    issues.push({ path: `${path}.severity`, message: "Expected warning" });
  }
  const previous = optionalEventReplayCursor(value, "previous", `${path}.previous`, issues);
  const current = requiredEventLogMetadata(value, "current", `${path}.current`, issues);
  const replayedFromSequence = requiredInteger(value, "replayedFromSequence", `${path}.replayedFromSequence`, issues, { min: 0 });
  if (
    code !== "EVENT_LOG_CURSOR_MISMATCH" ||
    message === undefined ||
    severity !== "warning" ||
    current === undefined ||
    replayedFromSequence === undefined
  ) {
    return undefined;
  }
  return {
    code,
    message,
    severity,
    ...(previous !== undefined ? { previous } : {}),
    current,
    replayedFromSequence,
  };
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

export function requiredRecord(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): UnknownRecord | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }

  if (!isRecord(input[key])) {
    issues.push({ path, message: "Expected object" });
    return undefined;
  }

  return input[key] as UnknownRecord;
}

export function requiredArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): unknown[] | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }

  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return undefined;
  }

  return input[key];
}

export function optionalArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): unknown[] | undefined {
  if (!(key in input)) return undefined;
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return undefined;
  }
  return input[key];
}

export function requiredStringArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string[] | undefined {
  const values = requiredArray(input, key, path, issues);
  if (!values) return undefined;
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      issues.push({ path: `${path}[${index}]`, message: "Expected non-empty string" });
    }
  });
  return values as string[];
}

export function optionalStringArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string[] | undefined {
  if (!(key in input)) return undefined;
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return undefined;
  }
  const values = input[key] as unknown[];
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      issues.push({ path: `${path}[${index}]`, message: "Expected non-empty string" });
    }
  });
  return values as string[];
}

export function requiredEnum<const T extends readonly string[]>(
  input: UnknownRecord,
  key: string,
  path: string,
  values: T,
  issues: ProtocolValidationIssue[]
): T[number] | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }

  return readEnum(input[key], path, values, issues);
}

export function optionalEnum<const T extends readonly string[]>(
  input: UnknownRecord,
  key: string,
  path: string,
  values: T,
  issues: ProtocolValidationIssue[]
): T[number] | undefined {
  if (!(key in input)) return undefined;
  return readEnum(input[key], path, values, issues);
}

export function requiredApprovalProtocolStatus(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): (typeof APPROVAL_PROTOCOL_STATUSES)[number] | undefined {
  return requiredEnum(input, key, path, APPROVAL_PROTOCOL_STATUSES, issues);
}

export function optionalApprovalProtocolStatus(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): (typeof APPROVAL_PROTOCOL_STATUSES)[number] | undefined {
  return optionalEnum(input, key, path, APPROVAL_PROTOCOL_STATUSES, issues);
}

export function readEnum<const T extends readonly string[]>(
  value: unknown,
  path: string,
  values: T,
  issues: ProtocolValidationIssue[]
): T[number] | undefined {
  if (typeof value !== "string" || !includesString(values, value)) {
    issues.push({
      path,
      message: `Expected one of: ${values.join(", ")}`,
    });
    return undefined;
  }

  return value;
}

export function requiredPlanDocumentPatch(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): PatchPlanDocumentMessage["patch"] | undefined {
  const patch = requiredRecord(input, key, path, issues);
  if (!patch) return undefined;

  rejectUnknownFields(patch, ["expectedVersion", "operations"], issues, path);
  optionalInteger(patch, "expectedVersion", `${path}.expectedVersion`, issues, { min: 1 });
  const operations = requiredArray(patch, "operations", `${path}.operations`, issues);
  operations?.forEach((operation, index) => {
    if (!isRecord(operation)) {
      issues.push({ path: `${path}.operations[${index}]`, message: "Expected object" });
      return;
    }
    requiredString(operation, "op", `${path}.operations[${index}].op`, issues, {
      nonEmpty: true,
    });
  });

  return patch as unknown as PatchPlanDocumentMessage["patch"];
}

// ─── Utility predicates ────────────────────────────────────────

export const isRecord = isRecordShared;

export { isJsonObject, isJsonValue } from "@crish/shared-utils";

export function includesString<const T extends readonly string[]>(
  values: T,
  value: string
): value is T[number] {
  return (values as readonly string[]).includes(value);
}

// ─── Result constructors ───────────────────────────────────────

export function ok<T>(value: T): ProtocolValidationResult<T> {
  return { ok: true, value };
}

export function invalid<T = never>(
  message: string,
  issues: ProtocolValidationIssue[]
): ProtocolValidationResult<T> {
  return {
    ok: false,
    error: {
      code: "INVALID_MESSAGE",
      message,
      issues,
    },
  };
}
