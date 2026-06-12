/**
 * Protocol schema — daemon lifecycle validators.
 *
 * Extracted from schema.ts.
 */
import type {
  CapabilitiesResponseMessage,
  ConfigUpdatedMessage,
  DaemonReadyMessage,
  ErrorMessage,
  GetStatusMessage,
  ListCapabilitiesMessage,
  PingMessage,
  PongMessage,
  StatusResponseMessage,
  UpdateConfigMessage,
} from "../../types.js";
import {
  type ProtocolValidationIssue,
  type ProtocolValidationResult,
  type UnknownRecord,
  ACCOUNT_GATEWAY_STATUSES,
  ACCOUNT_LOGIN_STATUSES,
  ACCOUNT_QUOTA_STATUSES,
  ACCOUNT_RUNTIME_CREDENTIAL_STATUSES,
  CAPABILITY_DIAGNOSTIC_SEVERITIES,
  CAPABILITY_OWNERS,
  CAPABILITY_STATES,
  DAEMON_LIFECYCLE_STATES,
  EVENT_STORE_STATUSES,
  LIFECYCLE_DIAGNOSTIC_SEVERITIES,
  LIFECYCLE_DIAGNOSTIC_SOURCES,
  MCP_READINESS_STATUSES,
  PROVIDER_API_KEY_SOURCES,
  PROVIDER_CREDENTIAL_MODES,
  PROVIDER_ENDPOINTS,
  PROVIDER_READINESS_STATUSES,
  SYSTEM_PROMPT_WIRE_MODES,
  invalid,
  isRecord,
  ok,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  rejectUnknownFields,
  requiredArray,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredNullableInteger,
  requiredRecord,
  requiredString,
  requiredStringArray,
} from "./schema-core.js";
import {
  ACCOUNT_CENTER_STATUS_FIELDS,
  ACTIVE_RUN_FIELDS,
  CAPABILITIES_RESPONSE_FIELDS,
  CAPABILITY_DIAGNOSTIC_FIELDS,
  CAPABILITY_RECORD_FIELDS,
  CAPABILITY_SNAPSHOT_FIELDS,
  CLIENT_DISCONNECT_FIELDS,
  CONFIG_UPDATED_FIELDS,
  DAEMON_READY_FIELDS,
  EMPTY_COMMAND_FIELDS,
  ERROR_FIELDS,
  EVENT_STORE_STATUS_FIELDS,
  LIFECYCLE_DIAGNOSTIC_FIELDS,
  LIFECYCLE_FIELDS,
  MCP_STATUS_FIELDS,
  PENDING_APPROVAL_FIELDS,
  PROVIDER_DIAGNOSTIC_FIELDS,
  PROVIDER_GATEWAY_STATUS_FIELDS,
  PROVIDER_REDACTED_API_KEY_FIELDS,
  PROVIDER_STATUS_FIELDS,
  STATUS_RESPONSE_FIELDS,
  UPDATE_CONFIG_FIELDS,
} from "./schema-fields.js";

// ─── Sub-validators (internal helpers) ────────────────────────

function validateLifecycleDiagnostic(
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

function validateStatusActiveRun(
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

// ─── Command validators ───────────────────────────────────────

export function validatePingMessage(
  input: UnknownRecord
): ProtocolValidationResult<PingMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid ping message", issues);

  return ok({ type: "ping" });
}

export function validateGetStatusMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetStatusMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid get-status message", issues);

  return ok({ type: "get-status" });
}

export function validateListCapabilitiesMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListCapabilitiesMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid list-capabilities message", issues);

  return ok({ type: "list-capabilities" });
}

export function validateUpdateConfigMessage(
  input: UnknownRecord
): ProtocolValidationResult<UpdateConfigMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, UPDATE_CONFIG_FIELDS, issues);

  const apiKey = optionalString(input, "apiKey", "$.apiKey", issues);
  const baseUrl = optionalString(input, "baseUrl", "$.baseUrl", issues);
  const model = optionalString(input, "model", "$.model", issues);
  const credentialMode = optionalEnum(
    input,
    "credentialMode",
    "$.credentialMode",
    PROVIDER_CREDENTIAL_MODES,
    issues
  );
  const endpoint = optionalEnum(
    input,
    "endpoint",
    "$.endpoint",
    PROVIDER_ENDPOINTS,
    issues
  );
  const stream = optionalBoolean(input, "stream", "$.stream", issues);

  if (issues.length > 0) return invalid("Invalid update-config message", issues);

  return ok({
    type: "update-config",
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(credentialMode !== undefined ? { credentialMode } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(stream !== undefined ? { stream } : {}),
  });
}

// ─── Response validators ──────────────────────────────────────

export function validateDaemonReadyMessage(
  input: UnknownRecord
): ProtocolValidationResult<DaemonReadyMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DAEMON_READY_FIELDS, issues);

  const port = requiredInteger(input, "port", "$.port", issues, { min: 0 });
  const protocolVersion = requiredInteger(input, "protocolVersion", "$.protocolVersion", issues, { min: 1 });
  const buildHash = requiredString(input, "buildHash", "$.buildHash", issues);

  if (issues.length > 0) return invalid("Invalid daemon-ready message", issues);

  return ok({
    type: "daemon-ready",
    port: port as number,
    protocolVersion: protocolVersion as number,
    buildHash: buildHash as string,
  });
}

export function validateErrorMessage(
  input: UnknownRecord
): ProtocolValidationResult<ErrorMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, ERROR_FIELDS, issues);

  const code = requiredString(input, "code", "$.code", issues, {
    nonEmpty: true,
  });
  const message = requiredString(input, "message", "$.message", issues);
  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid error message", issues);

  return ok({
    type: "error",
    code: code as string,
    message: message as string,
    ...(runId !== undefined ? { runId } : {}),
  });
}

export function validatePongMessage(
  input: UnknownRecord
): ProtocolValidationResult<PongMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid pong message", issues);

  return ok({ type: "pong" });
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

export function validateConfigUpdatedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ConfigUpdatedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONFIG_UPDATED_FIELDS, issues);

  const updatedFields = requiredArray(
    input,
    "updatedFields",
    "$.updatedFields",
    issues
  );
  if (updatedFields) {
    updatedFields.forEach((field, index) => {
      if (typeof field !== "string") {
        issues.push({
          path: `$.updatedFields[${index}]`,
          message: "Expected string",
        });
      }
    });
  }

  if (issues.length > 0) return invalid("Invalid config-updated message", issues);

  return ok({
    type: "config-updated",
    updatedFields: updatedFields as string[],
  });
}

// ─── Lifecycle sub-validators ─────────────────────────────────

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

export function validateProviderStatus(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PROVIDER_STATUS_FIELDS, issues, path);
  requiredEnum(value, "credentialMode", `${path}.credentialMode`, PROVIDER_CREDENTIAL_MODES, issues);
  requiredEnum(value, "readiness", `${path}.readiness`, PROVIDER_READINESS_STATUSES, issues);
  requiredString(value, "providerId", `${path}.providerId`, issues, { nonEmpty: true });
  requiredString(value, "routeId", `${path}.routeId`, issues, { nonEmpty: true });
  requiredString(value, "baseUrl", `${path}.baseUrl`, issues);
  requiredString(value, "model", `${path}.model`, issues);
  requiredString(value, "upstreamModel", `${path}.upstreamModel`, issues);
  requiredEnum(value, "endpoint", `${path}.endpoint`, PROVIDER_ENDPOINTS, issues);
  requiredBoolean(value, "stream", `${path}.stream`, issues);
  requiredEnum(value, "systemPromptWireMode", `${path}.systemPromptWireMode`, SYSTEM_PROMPT_WIRE_MODES, issues);
  const apiKey = requiredRecord(value, "apiKey", `${path}.apiKey`, issues);
  if (apiKey) validateRedactedApiKeyStatus(apiKey, `${path}.apiKey`, issues);
  requiredBoolean(value, "hasDirectApiKey", `${path}.hasDirectApiKey`, issues);
  requiredEnum(value, "apiKeySource", `${path}.apiKeySource`, PROVIDER_API_KEY_SOURCES, issues);

  const accountCenter = requiredRecord(value, "accountCenter", `${path}.accountCenter`, issues);
  if (accountCenter) validateAccountCenterStatus(accountCenter, `${path}.accountCenter`, issues);
  const gateway = requiredRecord(value, "gateway", `${path}.gateway`, issues);
  if (gateway) validateProviderGatewayStatus(gateway, `${path}.gateway`, issues);
  if ("lastDiagnostic" in value) {
    validateProviderDiagnostic(value.lastDiagnostic, `${path}.lastDiagnostic`, issues);
  }
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateRedactedApiKeyStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, PROVIDER_REDACTED_API_KEY_FIELDS, issues, path);
  requiredBoolean(value, "hasApiKey", `${path}.hasApiKey`, issues);
  requiredEnum(value, "source", `${path}.source`, PROVIDER_API_KEY_SOURCES, issues);
  if ("last4" in value) optionalString(value, "last4", `${path}.last4`, issues, { nonEmpty: true });
}

export function validateAccountCenterStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, ACCOUNT_CENTER_STATUS_FIELDS, issues, path);
  requiredBoolean(value, "configured", `${path}.configured`, issues);
  if ("accountId" in value) optionalString(value, "accountId", `${path}.accountId`, issues, { nonEmpty: true });
  requiredEnum(value, "login", `${path}.login`, ACCOUNT_LOGIN_STATUSES, issues);
  requiredEnum(value, "quota", `${path}.quota`, ACCOUNT_QUOTA_STATUSES, issues);
  requiredEnum(value, "gateway", `${path}.gateway`, ACCOUNT_GATEWAY_STATUSES, issues);
  requiredEnum(
    value,
    "runtimeCredential",
    `${path}.runtimeCredential`,
    ACCOUNT_RUNTIME_CREDENTIAL_STATUSES,
    issues
  );
  if ("lastCheckedAt" in value) optionalString(value, "lastCheckedAt", `${path}.lastCheckedAt`, issues, { nonEmpty: true });
  if ("lastDiagnostic" in value) {
    validateProviderDiagnostic(value.lastDiagnostic, `${path}.lastDiagnostic`, issues);
  }
}

export function validateProviderGatewayStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, PROVIDER_GATEWAY_STATUS_FIELDS, issues, path);
  requiredBoolean(value, "ready", `${path}.ready`, issues);
  requiredBoolean(value, "credentialConfigured", `${path}.credentialConfigured`, issues);
  const routeDecision = requiredArray(value, "routeDecision", `${path}.routeDecision`, issues);
  routeDecision?.forEach((item, index) => {
    if (typeof item !== "string") {
      issues.push({ path: `${path}.routeDecision[${index}]`, message: "Expected string" });
    }
  });
  if ("code" in value) optionalString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  if ("selectedRouteId" in value) optionalString(value, "selectedRouteId", `${path}.selectedRouteId`, issues, { nonEmpty: true });
  if ("selectedProviderId" in value) optionalString(value, "selectedProviderId", `${path}.selectedProviderId`, issues, { nonEmpty: true });
  if ("selectedEndpointSupport" in value) optionalEnum(value, "selectedEndpointSupport", `${path}.selectedEndpointSupport`, PROVIDER_ENDPOINTS, issues);
  if ("selectedStreamingSupport" in value) optionalString(value, "selectedStreamingSupport", `${path}.selectedStreamingSupport`, issues, { nonEmpty: true });
  if ("selectedCredentialSource" in value && !isRecord(value.selectedCredentialSource)) {
    issues.push({ path: `${path}.selectedCredentialSource`, message: "Expected object" });
  }
  if ("lastSuccess" in value && !isRecord(value.lastSuccess)) {
    issues.push({ path: `${path}.lastSuccess`, message: "Expected object" });
  }
  if ("lastFailure" in value && !isRecord(value.lastFailure)) {
    issues.push({ path: `${path}.lastFailure`, message: "Expected object" });
  }
  if ("updatedAt" in value) optionalString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateProviderDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PROVIDER_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("kind" in value) optionalString(value, "kind", `${path}.kind`, issues, { nonEmpty: true });
  if ("status" in value) optionalInteger(value, "status", `${path}.status`, issues, { min: 100 });
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateMcpStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, MCP_STATUS_FIELDS, issues, path);
  requiredBoolean(value, "configured", `${path}.configured`, issues);
  requiredEnum(value, "readiness", `${path}.readiness`, MCP_READINESS_STATUSES, issues);
  requiredInteger(value, "serverCount", `${path}.serverCount`, issues, { min: 0 });
  requiredRecord(value, "summary", `${path}.summary`, issues);
  const diagnostics = requiredArray(value, "diagnostics", `${path}.diagnostics`, issues);
  diagnostics?.forEach((diagnostic, index) => {
    if (!isRecord(diagnostic)) {
      issues.push({ path: `${path}.diagnostics[${index}]`, message: "Expected object" });
    }
  });
  const servers = requiredArray(value, "servers", `${path}.servers`, issues);
  servers?.forEach((server, index) => {
    if (!isRecord(server)) {
      issues.push({ path: `${path}.servers[${index}]`, message: "Expected object" });
    }
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
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
