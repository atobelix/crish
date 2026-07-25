import type {
  CapabilitiesResponseMessage,
  GetStatusMessage,
  StatusResponseMessage,
} from "../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "./base.js";
import {
  ACTIVE_RUN_FIELDS,
  CAPABILITIES_RESPONSE_FIELDS,
  CAPABILITY_DIAGNOSTIC_FIELDS,
  CAPABILITY_DIAGNOSTIC_SEVERITIES,
  CAPABILITY_OWNERS,
  CAPABILITY_RECORD_FIELDS,
  CAPABILITY_SNAPSHOT_FIELDS,
  CAPABILITY_STATES,
  CLIENT_DISCONNECT_FIELDS,
  DAEMON_LIFECYCLE_STATES,
  EMPTY_COMMAND_FIELDS,
  EVENT_STORE_STATUSES,
  EVENT_STORE_STATUS_FIELDS,
  LIFECYCLE_DIAGNOSTIC_FIELDS,
  LIFECYCLE_DIAGNOSTIC_SEVERITIES,
  LIFECYCLE_DIAGNOSTIC_SOURCES,
  LIFECYCLE_FIELDS,
  MCP_READINESS_STATUSES,
  PENDING_APPROVAL_FIELDS,
  PROVIDER_READINESS_STATUSES,
  STATUS_RESPONSE_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalBoolean,
  optionalInteger,
  optionalString,
  rejectUnknownFields,
  requiredArray,
  requiredEnum,
  requiredInteger,
  requiredNullableInteger,
  requiredRecord,
  requiredString,
  requiredStringArray,
} from "./base.js";
import {
  validateProviderStatus,
} from "./provider.js";
import { validateMcpStatus } from "./provider.js";

export function validateGetStatusMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetStatusMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid get-status message", issues);

  return ok({ type: "get-status" });
}

export function validateStatusResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<StatusResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, STATUS_RESPONSE_FIELDS, issues);

  const lifecycle = requiredRecord(
    input,
    "lifecycle",
    "$.lifecycle",
    issues
  );
  const activeRuns = requiredArray(
    input,
    "activeRuns",
    "$.activeRuns",
    issues
  );
  const pendingApprovals = requiredArray(
    input,
    "pendingApprovals",
    "$.pendingApprovals",
    issues
  );
  const recentApprovals = requiredArray(
    input,
    "recentApprovals",
    "$.recentApprovals",
    issues
  );
  const providerStatus = requiredRecord(
    input,
    "providerStatus",
    "$.providerStatus",
    issues
  );
  const mcpStatus = requiredRecord(
    input,
    "mcpStatus",
    "$.mcpStatus",
    issues
  );
  const capabilities = requiredRecord(
    input,
    "capabilities",
    "$.capabilities",
    issues
  );

  if (lifecycle) {
    validateLifecycleSnapshot(lifecycle, "$.lifecycle", issues);
  }

  if (activeRuns) {
    activeRuns.forEach((run, index) =>
      validateStatusActiveRun(run, `$.activeRuns[${index}]`, issues)
    );
  }

  if (pendingApprovals) {
    pendingApprovals.forEach((approval, index) =>
      validatePendingApproval(
        approval,
        `$.pendingApprovals[${index}]`,
        issues
      )
    );
  }
  if (recentApprovals) {
    recentApprovals.forEach((approval, index) =>
      validatePendingApproval(
        approval,
        `$.recentApprovals[${index}]`,
        issues
      )
    );
  }

  if (providerStatus) {
    validateProviderStatus(providerStatus, "$.providerStatus", issues);
  }
  if (mcpStatus) {
    validateMcpStatus(mcpStatus, "$.mcpStatus", issues);
  }
  if (capabilities) {
    validateCapabilitySnapshot(capabilities, "$.capabilities", issues);
  }

  if (issues.length > 0) return invalid("Invalid status-response message", issues);

  return ok({
    type: "status-response",
    lifecycle: lifecycle as unknown as StatusResponseMessage["lifecycle"],
    activeRuns: activeRuns as StatusResponseMessage["activeRuns"],
    pendingApprovals:
      pendingApprovals as StatusResponseMessage["pendingApprovals"],
    recentApprovals: recentApprovals as StatusResponseMessage["recentApprovals"],
    providerStatus: providerStatus as unknown as StatusResponseMessage["providerStatus"],
    mcpStatus: mcpStatus as unknown as StatusResponseMessage["mcpStatus"],
    capabilities: capabilities as unknown as StatusResponseMessage["capabilities"],
  });
}

export function validateCapabilitiesResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<CapabilitiesResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CAPABILITIES_RESPONSE_FIELDS, issues);

  const snapshot = requiredRecord(input, "snapshot", "$.snapshot", issues);
  if (snapshot) {
    validateCapabilitySnapshot(snapshot, "$.snapshot", issues);
  }

  if (issues.length > 0) return invalid("Invalid capabilities-response message", issues);

  return ok({
    type: "capabilities-response",
    snapshot: snapshot as unknown as CapabilitiesResponseMessage["snapshot"],
  });
}

export function validateLifecycleSnapshot(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, LIFECYCLE_FIELDS, issues, path);
  requiredEnum(value, "state", `${path}.state`, DAEMON_LIFECYCLE_STATES, issues);
  requiredString(value, "startedAt", `${path}.startedAt`, issues, { nonEmpty: true });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("readyAt" in value) optionalString(value, "readyAt", `${path}.readyAt`, issues, { nonEmpty: true });
  if ("stoppingAt" in value) optionalString(value, "stoppingAt", `${path}.stoppingAt`, issues, { nonEmpty: true });
  if ("stoppedAt" in value) optionalString(value, "stoppedAt", `${path}.stoppedAt`, issues, { nonEmpty: true });
  requiredInteger(value, "uptimeMs", `${path}.uptimeMs`, issues, { min: 0 });
  requiredNullableInteger(value, "currentPort", `${path}.currentPort`, issues, { min: 0 });
  requiredInteger(value, "connectedClientCount", `${path}.connectedClientCount`, issues, { min: 0 });
  requiredInteger(value, "totalClientConnectionCount", `${path}.totalClientConnectionCount`, issues, { min: 0 });
  requiredInteger(value, "totalClientDisconnectCount", `${path}.totalClientDisconnectCount`, issues, { min: 0 });
  requiredInteger(value, "activeRunCount", `${path}.activeRunCount`, issues, { min: 0 });

  if ("recentDisconnect" in value) {
    validateClientDisconnect(value.recentDisconnect, `${path}.recentDisconnect`, issues);
  }
  if ("recentError" in value) {
    validateLifecycleDiagnostic(value.recentError, `${path}.recentError`, issues);
  }
  if ("recentErrors" in value && value.recentErrors !== undefined) {
    if (!Array.isArray(value.recentErrors)) {
      issues.push({ path: `${path}.recentErrors`, message: "Expected array" });
    } else {
      value.recentErrors.forEach((err, index) =>
        validateLifecycleDiagnostic(err, `${path}.recentErrors[${index}]`, issues)
      );
    }
  }
  const eventStore = requiredRecord(value, "eventStore", `${path}.eventStore`, issues);
  if (eventStore) validateEventStoreStatus(eventStore, `${path}.eventStore`, issues);
  requiredEnum(value, "providerReadiness", `${path}.providerReadiness`, PROVIDER_READINESS_STATUSES, issues);
  requiredEnum(value, "mcpReadiness", `${path}.mcpReadiness`, MCP_READINESS_STATUSES, issues);
}

export function validateClientDisconnect(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CLIENT_DISCONNECT_FIELDS, issues, path);
  requiredString(value, "clientId", `${path}.clientId`, issues, { nonEmpty: true });
  requiredInteger(value, "code", `${path}.code`, issues, { min: 0 });
  requiredString(value, "reason", `${path}.reason`, issues);
  requiredString(value, "connectedAt", `${path}.connectedAt`, issues, { nonEmpty: true });
  requiredString(value, "disconnectedAt", `${path}.disconnectedAt`, issues, { nonEmpty: true });
  requiredInteger(value, "durationMs", `${path}.durationMs`, issues, { min: 0 });
}

export function validateEventStoreStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, EVENT_STORE_STATUS_FIELDS, issues, path);
  requiredEnum(value, "status", `${path}.status`, EVENT_STORE_STATUSES, issues);
  requiredString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  if ("failure" in value) {
    validateLifecycleDiagnostic(value.failure, `${path}.failure`, issues);
  }
}

export function validateLifecycleDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, LIFECYCLE_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  requiredEnum(value, "source", `${path}.source`, LIFECYCLE_DIAGNOSTIC_SOURCES, issues);
  requiredEnum(value, "severity", `${path}.severity`, LIFECYCLE_DIAGNOSTIC_SEVERITIES, issues);
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateStatusActiveRun(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, ACTIVE_RUN_FIELDS, issues, path);
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "prompt", `${path}.prompt`, issues);
  requiredString(value, "status", `${path}.status`, issues, { nonEmpty: true });
  requiredInteger(value, "startedAt", `${path}.startedAt`, issues, { min: 0 });
  requiredString(value, "cwd", `${path}.cwd`, issues);
}

export function validatePendingApproval(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PENDING_APPROVAL_FIELDS, issues, path);
  requiredString(value, "toolCallId", `${path}.toolCallId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "toolName", `${path}.toolName`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "summary", `${path}.summary`, issues);
  requiredInteger(value, "createdAt", `${path}.createdAt`, issues, { min: 0 });
  requiredEnum(value, "status", `${path}.status`, ["pending", "approved", "denied", "expired"], issues);
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
}

export function validateCapabilitySnapshot(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, CAPABILITY_SNAPSHOT_FIELDS, issues, path);
  const schemaVersion = requiredInteger(value, "schemaVersion", `${path}.schemaVersion`, issues, {
    min: 1,
  });
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    issues.push({ path: `${path}.schemaVersion`, message: "Expected capability schema version 1" });
  }
  requiredString(value, "generatedAt", `${path}.generatedAt`, issues, { nonEmpty: true });
  const capabilities = requiredArray(value, "capabilities", `${path}.capabilities`, issues);
  capabilities?.forEach((capability, index) =>
    validateCapabilityRecord(capability, `${path}.capabilities[${index}]`, issues)
  );
}

export function validateCapabilityRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CAPABILITY_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  requiredEnum(value, "state", `${path}.state`, CAPABILITY_STATES, issues);
  requiredString(value, "reason", `${path}.reason`, issues, { nonEmpty: true });
  requiredEnum(value, "owner", `${path}.owner`, CAPABILITY_OWNERS, issues);
  requiredStringArray(value, "relatedMessageTypes", `${path}.relatedMessageTypes`, issues);
  requiredStringArray(value, "relatedTauriCommands", `${path}.relatedTauriCommands`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  const diagnostics = requiredArray(value, "diagnostics", `${path}.diagnostics`, issues);
  diagnostics?.forEach((diagnostic, index) =>
    validateCapabilityDiagnostic(diagnostic, `${path}.diagnostics[${index}]`, issues)
  );
}

export function validateCapabilityDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CAPABILITY_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
  requiredEnum(value, "severity", `${path}.severity`, CAPABILITY_DIAGNOSTIC_SEVERITIES, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}
