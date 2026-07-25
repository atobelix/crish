import type {
  ConfigUpdatedMessage,
  ProbeProviderChatMessage,
  ProbeProviderModelsMessage,
  ProviderChatProbedMessage,
  ProviderModelsProbedMessage,
  UpdateConfigMessage,
} from "../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "./base.js";
import {
  CONFIG_UPDATED_FIELDS,
  MCP_READINESS_STATUSES,
  MCP_STATUS_FIELDS,
  PROBE_PROVIDER_CHAT_FIELDS,
  PROBE_PROVIDER_MODELS_FIELDS,
  PROVIDER_API_KEY_SOURCES,
  PROVIDER_CREDENTIAL_MODES,
  PROVIDER_DIAGNOSTIC_FIELDS,
  PROVIDER_ENDPOINTS,
  PROVIDER_GATEWAY_STATUS_FIELDS,
  PROVIDER_READINESS_STATUSES,
  PROVIDER_REDACTED_API_KEY_FIELDS,
  PROVIDER_STATUS_FIELDS,
  SYSTEM_PROMPT_WIRE_MODES,
  UPDATE_CONFIG_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalNumber,
  optionalString,
  rejectUnknownFields,
  requiredArray,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredRecord,
  requiredString,
} from "./base.js";

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
  const mcpServers = optionalMcpServersField(input, "mcpServers", "$.mcpServers", issues);

  if (issues.length > 0) return invalid("Invalid update-config message", issues);

  return ok({
    type: "update-config",
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(credentialMode !== undefined ? { credentialMode } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(stream !== undefined ? { stream } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
  });
}

function optionalMcpServersField(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): UpdateConfigMessage["mcpServers"] | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  const value = input[key];
  if (!Array.isArray(value)) {
    issues.push({ path, message: "Expected array of MCP server configs" });
    return undefined;
  }
  const servers: NonNullable<UpdateConfigMessage["mcpServers"]> = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push({ path: `${path}[${i}]`, message: "Expected object" });
      continue;
    }
    const o = item as UnknownRecord;
    const name = typeof o.name === "string" ? o.name.trim() : typeof o.id === "string" ? o.id.trim() : "";
    if (!name) {
      issues.push({ path: `${path}[${i}].name`, message: "Expected non-empty name" });
      continue;
    }
    const entry: NonNullable<UpdateConfigMessage["mcpServers"]>[number] = { name, label: undefined, transport: undefined, command: undefined, args: undefined, env: undefined, cwd: undefined, url: undefined };
    if (typeof o.label === "string" && o.label.trim()) entry.label = o.label.trim();
    if (typeof o.transport === "string" && o.transport.trim()) entry.transport = o.transport.trim();
    if (typeof o.command === "string" && o.command.trim()) entry.command = o.command.trim();
    if (Array.isArray(o.args)) {
      entry.args = o.args.filter((a): a is string => typeof a === "string");
    }
    if (o.env && typeof o.env === "object" && !Array.isArray(o.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
      if (Object.keys(env).length > 0) entry.env = env;
    }
    if (typeof o.cwd === "string" && o.cwd.trim()) entry.cwd = o.cwd.trim();
    if (typeof o.url === "string" && o.url.trim()) entry.url = o.url.trim();
    servers.push(entry);
  }
  return servers;
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

export function validateProbeProviderModelsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ProbeProviderModelsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PROBE_PROVIDER_MODELS_FIELDS, issues);

  const profileId = requiredString(input, "profileId", "$.profileId", issues, { nonEmpty: true });
  const baseUrl = requiredString(input, "baseUrl", "$.baseUrl", issues, { nonEmpty: true });
  const apiKey = requiredString(input, "apiKey", "$.apiKey", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid probe-provider-models message", issues);

  return ok({
    type: "probe-provider-models",
    profileId: profileId!,
    baseUrl: baseUrl!,
    apiKey: apiKey!,
  });
}

export function validateProbeProviderChatMessage(
  input: UnknownRecord
): ProtocolValidationResult<ProbeProviderChatMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PROBE_PROVIDER_CHAT_FIELDS, issues);

  const profileId = requiredString(input, "profileId", "$.profileId", issues, { nonEmpty: true });
  const baseUrl = requiredString(input, "baseUrl", "$.baseUrl", issues, { nonEmpty: true });
  const apiKey = requiredString(input, "apiKey", "$.apiKey", issues, { nonEmpty: true });
  const model = requiredString(input, "model", "$.model", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid probe-provider-chat message", issues);

  return ok({
    type: "probe-provider-chat",
    profileId: profileId!,
    baseUrl: baseUrl!,
    apiKey: apiKey!,
    model: model!,
  });
}

const PROVIDER_MODELS_PROBED_FIELDS = ["type", "ok", "models", "error"];

export function validateProviderModelsProbedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ProviderModelsProbedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PROVIDER_MODELS_PROBED_FIELDS, issues);

  const okVal = requiredBoolean(input, "ok", "$.ok", issues);
  const models = requiredArray(input, "models", "$.models", issues);
  const error = optionalString(input, "error", "$.error", issues);

  if (issues.length > 0) return invalid("Invalid provider-models-probed message", issues);

  return ok({
    type: "provider-models-probed",
    ok: okVal!,
    models: (models || []).map((m) => String(m)),
    ...(error !== undefined ? { error } : {}),
  });
}

const PROVIDER_CHAT_PROBED_FIELDS = ["type", "ok", "latencyMs", "error"];

export function validateProviderChatProbedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ProviderChatProbedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PROVIDER_CHAT_PROBED_FIELDS, issues);

  const okVal = requiredBoolean(input, "ok", "$.ok", issues);
  const latencyMs = optionalNumber(input, "latencyMs", "$.latencyMs", issues);
  const error = optionalString(input, "error", "$.error", issues);

  if (issues.length > 0) return invalid("Invalid provider-chat-probed message", issues);

  return ok({
    type: "provider-chat-probed",
    ok: okVal!,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(error !== undefined ? { error } : {}),
  });
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

  const gateway = requiredRecord(value, "gateway", `${path}.gateway`, issues);
  if (gateway) validateProviderGatewayStatus(gateway, `${path}.gateway`, issues);
  if ("lastDiagnostic" in value) {
    validateProviderDiagnostic(value.lastDiagnostic, `${path}.lastDiagnostic`, issues);
  }
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("lastProbeOk" in value && value.lastProbeOk !== undefined) {
    optionalBoolean(value, "lastProbeOk", `${path}.lastProbeOk`, issues);
  }
  if ("lastProbeAt" in value && value.lastProbeAt !== undefined) {
    optionalString(value, "lastProbeAt", `${path}.lastProbeAt`, issues, { nonEmpty: true });
  }
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
  if ("selectedCredentialSource" in value && value.selectedCredentialSource !== undefined && !isRecord(value.selectedCredentialSource)) {
    issues.push({ path: `${path}.selectedCredentialSource`, message: "Expected object" });
  }
  if ("lastSuccess" in value && value.lastSuccess !== undefined && !isRecord(value.lastSuccess)) {
    issues.push({ path: `${path}.lastSuccess`, message: "Expected object" });
  }
  if ("lastFailure" in value && value.lastFailure !== undefined && !isRecord(value.lastFailure)) {
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
