// Protocol validators: run message family
import type {
  ApproveToolMessage,
  ApprovalRequestedMessage,
  ApprovalResolvedMessage,
  CancelRunMessage,
  StreamPauseMessage,
  StreamResumeMessage,
  CapabilitiesResponseMessage,
  ConfigUpdatedMessage,
  DaemonReadyMessage,
  DenyToolMessage,
  ErrorMessage,
  EventMessage,
  GetStatusMessage,
  ListCapabilitiesMessage,
  PingMessage,
  PongMessage,
  RunTaskMessage,
  StatusResponseMessage,
  UpdateConfigMessage,
  ProbeProviderModelsMessage,
  ProbeProviderChatMessage,
  ProviderModelsProbedMessage,
  ProviderChatProbedMessage,
} from '../../types.js';
import type {
  JsonObject,
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from './common.js';
import {
  ACTIVE_RUN_FIELDS,
  APPROVAL_REQUESTED_FIELDS,
  APPROVAL_RESOLVED_FIELDS,
  APPROVE_TOOL_FIELDS,
  CANCEL_RUN_FIELDS,
  STREAM_PAUSE_FIELDS,
  STREAM_RESUME_FIELDS,
  CAPABILITIES_RESPONSE_FIELDS,
  CAPABILITY_DIAGNOSTIC_FIELDS,
  CAPABILITY_DIAGNOSTIC_SEVERITIES,
  CAPABILITY_OWNERS,
  CAPABILITY_RECORD_FIELDS,
  CAPABILITY_SNAPSHOT_FIELDS,
  CAPABILITY_STATES,
  CLIENT_DISCONNECT_FIELDS,
  CONFIG_UPDATED_FIELDS,
  DAEMON_LIFECYCLE_STATES,
  DAEMON_READY_FIELDS,
  DENY_TOOL_FIELDS,
  EMPTY_COMMAND_FIELDS,
  ERROR_FIELDS,
  EVENT_FIELDS,
  EVENT_STORE_STATUSES,
  EVENT_STORE_STATUS_FIELDS,
  LIFECYCLE_DIAGNOSTIC_FIELDS,
  LIFECYCLE_DIAGNOSTIC_SEVERITIES,
  LIFECYCLE_DIAGNOSTIC_SOURCES,
  LIFECYCLE_FIELDS,
  MCP_READINESS_STATUSES,
  MCP_STATUS_FIELDS,
  PENDING_APPROVAL_FIELDS,
  PROVIDER_API_KEY_SOURCES,
  PROVIDER_CREDENTIAL_MODES,
  PROVIDER_DIAGNOSTIC_FIELDS,
  PROVIDER_ENDPOINTS,
  PROVIDER_GATEWAY_STATUS_FIELDS,
  PROVIDER_READINESS_STATUSES,
  PROVIDER_REDACTED_API_KEY_FIELDS,
  PROVIDER_STATUS_FIELDS,
  RUN_TASK_FIELDS,
  STATUS_RESPONSE_FIELDS,
  SYSTEM_PROMPT_WIRE_MODES,
  UPDATE_CONFIG_FIELDS,
  PROBE_PROVIDER_MODELS_FIELDS,
  PROBE_PROVIDER_CHAT_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalNumber,
  optionalString,
  optionalStringArray,
  rejectUnknownFields,
  requiredArray,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredNullableInteger,
  requiredRecord,
  requiredString,
  requiredStringArray,
} from './common.js';
import { validateScopedContextRuntimeConfig } from './background.js';
import { validateAgentEvent } from './session-events.js';

export function validateRunTaskMessage(
  input: UnknownRecord
): ProtocolValidationResult<RunTaskMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RUN_TASK_FIELDS, issues);

  const runId = optionalString(input, 'runId', '$.runId', issues, {
    nonEmpty: true,
  });
  const sessionId = optionalString(input, 'sessionId', '$.sessionId', issues, {
    nonEmpty: true,
  });
  const prompt = requiredString(input, 'prompt', '$.prompt', issues, {
    nonEmpty: true,
  });
  const mode = optionalString(input, 'mode', '$.mode', issues);
  const workspaceMode = optionalEnum(
    input,
    'workspaceMode',
    '$.workspaceMode',
    ['project', 'none'],
    issues
  );
  const cwd = optionalString(input, 'cwd', '$.cwd', issues, {
    nonEmpty: true,
  });
  const visibleGoal = optionalString(
    input,
    'visibleGoal',
    '$.visibleGoal',
    issues,
    {
      nonEmpty: true,
    }
  );
  const budgetDifficulty = optionalString(
    input,
    'budgetDifficulty',
    '$.budgetDifficulty',
    issues,
    {
      nonEmpty: true,
    }
  );
  const runTokenBudget = optionalInteger(
    input,
    'runTokenBudget',
    '$.runTokenBudget',
    issues,
    {
      min: 1,
    }
  );
  const maxRounds = optionalInteger(input, 'maxRounds', '$.maxRounds', issues, {
    min: 1,
  });
  const maxStalledRounds = optionalInteger(
    input,
    'maxStalledRounds',
    '$.maxStalledRounds',
    issues,
    {
      min: 1,
    }
  );
  const backgroundDrainTimeoutMs = optionalInteger(
    input,
    'backgroundDrainTimeoutMs',
    '$.backgroundDrainTimeoutMs',
    issues,
    {
      min: 0,
    }
  );
  const permissionMode = optionalEnum(
    input,
    'permissionMode',
    '$.permissionMode',
    ['ask', 'auto', 'full-access', 'plan'],
    issues
  );
  const workspaceRoot = optionalString(
    input,
    'workspaceRoot',
    '$.workspaceRoot',
    issues,
    {
      nonEmpty: true,
    }
  );
  const projectRoot = optionalString(
    input,
    'projectRoot',
    '$.projectRoot',
    issues,
    {
      nonEmpty: true,
    }
  );
  const projectMarkers = optionalStringArray(
    input,
    'projectMarkers',
    '$.projectMarkers',
    issues
  );
  const projectFiles = optionalStringArray(
    input,
    'projectFiles',
    '$.projectFiles',
    issues
  );
  const projectTags = optionalStringArray(
    input,
    'projectTags',
    '$.projectTags',
    issues
  );
  const packageNames = optionalStringArray(
    input,
    'packageNames',
    '$.packageNames',
    issues
  );
  let mcpDisabledTools: RunTaskMessage['mcpDisabledTools'] | undefined;
  if ('mcpDisabledTools' in input) {
    if (
      !input.mcpDisabledTools ||
      typeof input.mcpDisabledTools !== 'object' ||
      Array.isArray(input.mcpDisabledTools)
    ) {
      issues.push({
        path: '$.mcpDisabledTools',
        message: 'mcpDisabledTools must be an object of serverId -> toolName[]',
      });
    } else {
      const map: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(
        input.mcpDisabledTools as Record<string, unknown>
      )) {
        if (!k || !Array.isArray(v)) continue;
        const tools = v
          .map(String)
          .map((t) => t.trim())
          .filter(Boolean);
        if (tools.length) map[k] = tools;
      }
      if (Object.keys(map).length > 0) mcpDisabledTools = map;
    }
  }
  if ('scopedContextConfig' in input) {
    validateScopedContextRuntimeConfig(
      input.scopedContextConfig,
      '$.scopedContextConfig',
      issues
    );
  }

  // 多模态 content / attachments：宽松校验（数组即可），避免拦死未来 part 形态
  let content: RunTaskMessage['content'] | undefined;
  if ('content' in input) {
    if (!Array.isArray(input.content)) {
      issues.push({
        path: '$.content',
        message: 'content must be an array of content parts',
      });
    } else {
      content = input.content as RunTaskMessage['content'];
    }
  }
  const hasImages = optionalBoolean(input, 'hasImages', '$.hasImages', issues);
  let attachments: RunTaskMessage['attachments'] | undefined;
  if ('attachments' in input) {
    if (!Array.isArray(input.attachments)) {
      issues.push({
        path: '$.attachments',
        message: 'attachments must be an array',
      });
    } else {
      attachments = input.attachments as RunTaskMessage['attachments'];
    }
  }

  const systemPrompt = optionalString(
    input,
    'systemPrompt',
    '$.systemPrompt',
    issues,
    { nonEmpty: true }
  );

  if (issues.length > 0) return invalid('Invalid run-task message', issues);

  return ok({
    type: 'run-task',
    runId: runId ?? '',
    ...(sessionId !== undefined ? { sessionId } : {}),
    prompt: prompt as string,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(workspaceMode !== undefined ? { workspaceMode } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(visibleGoal !== undefined ? { visibleGoal } : {}),
    ...(budgetDifficulty !== undefined ? { budgetDifficulty } : {}),
    ...(runTokenBudget !== undefined ? { runTokenBudget } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(maxStalledRounds !== undefined ? { maxStalledRounds } : {}),
    ...(backgroundDrainTimeoutMs !== undefined
      ? { backgroundDrainTimeoutMs }
      : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(projectMarkers !== undefined ? { projectMarkers } : {}),
    ...(projectFiles !== undefined ? { projectFiles } : {}),
    ...(projectTags !== undefined ? { projectTags } : {}),
    ...(packageNames !== undefined ? { packageNames } : {}),
    ...(mcpDisabledTools !== undefined ? { mcpDisabledTools } : {}),
    ...('scopedContextConfig' in input
      ? {
          scopedContextConfig:
            input.scopedContextConfig as RunTaskMessage['scopedContextConfig'],
        }
      : {}),
    ...(content !== undefined ? { content } : {}),
    ...(hasImages !== undefined ? { hasImages } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  });
}

export function validateApproveToolMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApproveToolMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPROVE_TOOL_FIELDS, issues);

  const toolCallId = requiredString(
    input,
    'toolCallId',
    '$.toolCallId',
    issues,
    { nonEmpty: true }
  );
  const scope = optionalEnum(
    input,
    'scope',
    '$.scope',
    ['project', 'always'],
    issues
  );

  if (issues.length > 0) return invalid('Invalid approve-tool message', issues);

  return ok({
    type: 'approve-tool',
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
    'toolCallId',
    '$.toolCallId',
    issues,
    { nonEmpty: true }
  );

  if (issues.length > 0) return invalid('Invalid deny-tool message', issues);

  return ok({ type: 'deny-tool', toolCallId: toolCallId as string });
}

export function validateCancelRunMessage(
  input: UnknownRecord
): ProtocolValidationResult<CancelRunMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CANCEL_RUN_FIELDS, issues);

  const runId = requiredString(input, 'runId', '$.runId', issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid('Invalid cancel-run message', issues);

  return ok({ type: 'cancel-run', runId: runId as string });
}

export function validateStreamPauseMessage(
  input: UnknownRecord
): ProtocolValidationResult<StreamPauseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, STREAM_PAUSE_FIELDS, issues);

  const runId = requiredString(input, 'runId', '$.runId', issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid('Invalid stream-pause message', issues);

  return ok({ type: 'stream-pause', runId: runId as string });
}

export function validateStreamResumeMessage(
  input: UnknownRecord
): ProtocolValidationResult<StreamResumeMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, STREAM_RESUME_FIELDS, issues);

  const runId = requiredString(input, 'runId', '$.runId', issues, {
    nonEmpty: true,
  });

  if (issues.length > 0)
    return invalid('Invalid stream-resume message', issues);

  return ok({ type: 'stream-resume', runId: runId as string });
}

export function validatePingMessage(
  input: UnknownRecord
): ProtocolValidationResult<PingMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid('Invalid ping message', issues);

  return ok({ type: 'ping' });
}

export function validateGetStatusMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetStatusMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid('Invalid get-status message', issues);

  return ok({ type: 'get-status' });
}

export function validateListCapabilitiesMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListCapabilitiesMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0)
    return invalid('Invalid list-capabilities message', issues);

  return ok({ type: 'list-capabilities' });
}

export function validateUpdateConfigMessage(
  input: UnknownRecord
): ProtocolValidationResult<UpdateConfigMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, UPDATE_CONFIG_FIELDS, issues);

  const apiKey = optionalString(input, 'apiKey', '$.apiKey', issues);
  const baseUrl = optionalString(input, 'baseUrl', '$.baseUrl', issues);
  const model = optionalString(input, 'model', '$.model', issues);
  const credentialMode = optionalEnum(
    input,
    'credentialMode',
    '$.credentialMode',
    PROVIDER_CREDENTIAL_MODES,
    issues
  );
  const endpoint = optionalEnum(
    input,
    'endpoint',
    '$.endpoint',
    PROVIDER_ENDPOINTS,
    issues
  );
  const stream = optionalBoolean(input, 'stream', '$.stream', issues);
  const mcpServers = optionalMcpServersField(
    input,
    'mcpServers',
    '$.mcpServers',
    issues
  );

  if (issues.length > 0)
    return invalid('Invalid update-config message', issues);

  return ok({
    type: 'update-config',
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
): UpdateConfigMessage['mcpServers'] | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  const value = input[key];
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'Expected array of MCP server configs' });
    return undefined;
  }
  const servers: NonNullable<UpdateConfigMessage['mcpServers']> = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push({ path: `${path}[${i}]`, message: 'Expected object' });
      continue;
    }
    const o = item as UnknownRecord;
    const name =
      typeof o.name === 'string'
        ? o.name.trim()
        : typeof o.id === 'string'
          ? o.id.trim()
          : '';
    if (!name) {
      issues.push({
        path: `${path}[${i}].name`,
        message: 'Expected non-empty name',
      });
      continue;
    }
    const entry: NonNullable<UpdateConfigMessage['mcpServers']>[number] = {
      name,
    };
    if (typeof o.label === 'string' && o.label.trim())
      entry.label = o.label.trim();
    if (typeof o.transport === 'string' && o.transport.trim())
      entry.transport = o.transport.trim();
    if (typeof o.command === 'string' && o.command.trim())
      entry.command = o.command.trim();
    if (Array.isArray(o.args)) {
      entry.args = o.args.filter((a): a is string => typeof a === 'string');
    }
    if (o.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
      if (Object.keys(env).length > 0) entry.env = env;
    }
    if (typeof o.cwd === 'string' && o.cwd.trim()) entry.cwd = o.cwd.trim();
    if (typeof o.url === 'string' && o.url.trim()) entry.url = o.url.trim();
    servers.push(entry);
  }
  return servers;
}

export function validateDaemonReadyMessage(
  input: UnknownRecord
): ProtocolValidationResult<DaemonReadyMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DAEMON_READY_FIELDS, issues);

  const port = requiredInteger(input, 'port', '$.port', issues, { min: 0 });
  const protocolVersion = requiredInteger(
    input,
    'protocolVersion',
    '$.protocolVersion',
    issues,
    { min: 1 }
  );
  const buildHash = requiredString(input, 'buildHash', '$.buildHash', issues);

  if (issues.length > 0) return invalid('Invalid daemon-ready message', issues);

  return ok({
    type: 'daemon-ready',
    port: port as number,
    protocolVersion: protocolVersion as number,
    buildHash: buildHash as string,
  });
}

export function validateEventMessage(
  input: UnknownRecord
): ProtocolValidationResult<EventMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EVENT_FIELDS, issues);

  const runId = requiredString(input, 'runId', '$.runId', issues, {
    nonEmpty: true,
  });
  const orchestratorEventId = optionalString(
    input,
    'orchestratorEventId',
    '$.orchestratorEventId',
    issues,
    { nonEmpty: true }
  );
  const sequence = optionalInteger(input, 'sequence', '$.sequence', issues, {
    min: 0,
  });
  const timestamp = optionalString(input, 'timestamp', '$.timestamp', issues, {
    nonEmpty: true,
  });
  validateAgentEvent(input.event, '$.event', issues);

  if (issues.length > 0) return invalid('Invalid event message', issues);

  return ok({
    type: 'event',
    runId: runId as string,
    ...(orchestratorEventId !== undefined ? { orchestratorEventId } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    event: input.event as EventMessage['event'],
  });
}

export function validateApprovalRequestedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApprovalRequestedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPROVAL_REQUESTED_FIELDS, issues);

  const runId = requiredString(input, 'runId', '$.runId', issues, {
    nonEmpty: true,
  });
  const toolCallId = requiredString(
    input,
    'toolCallId',
    '$.toolCallId',
    issues,
    { nonEmpty: true }
  );
  const toolName = requiredString(input, 'toolName', '$.toolName', issues, {
    nonEmpty: true,
  });
  const inputObject = requiredRecord(input, 'input', '$.input', issues);
  const summary = requiredString(input, 'summary', '$.summary', issues);
  const timeoutMs = requiredNullableInteger(
    input,
    'timeoutMs',
    '$.timeoutMs',
    issues,
    { min: 0 }
  );
  const expiresAt = requiredNullableInteger(
    input,
    'expiresAt',
    '$.expiresAt',
    issues,
    { min: 0 }
  );
  const remainingMs = requiredNullableInteger(
    input,
    'remainingMs',
    '$.remainingMs',
    issues,
    { min: 0 }
  );
  const risk = optionalString(input, 'risk', '$.risk', issues);
  const riskReason = optionalString(
    input,
    'riskReason',
    '$.riskReason',
    issues
  );
  const requiresDoubleConfirm = optionalBoolean(
    input,
    'requiresDoubleConfirm',
    '$.requiresDoubleConfirm',
    issues
  );
  const recommendSnapshot = optionalBoolean(
    input,
    'recommendSnapshot',
    '$.recommendSnapshot',
    issues
  );
  if ('metadata' in input && !isRecord(input.metadata)) {
    issues.push({ path: '$.metadata', message: 'Expected object' });
  }

  if (issues.length > 0) {
    return invalid('Invalid approval-requested message', issues);
  }

  return ok({
    type: 'approval-requested',
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
    ...(isRecord(input.metadata)
      ? { metadata: input.metadata as JsonObject }
      : {}),
  });
}

export function validateApprovalResolvedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApprovalResolvedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPROVAL_RESOLVED_FIELDS, issues);

  const toolCallId = requiredString(
    input,
    'toolCallId',
    '$.toolCallId',
    issues,
    { nonEmpty: true }
  );
  const decision = requiredEnum(
    input,
    'decision',
    '$.decision',
    ['approved', 'denied', 'expired'],
    issues
  );
  const reason = optionalString(input, 'reason', '$.reason', issues);
  const expiredAt = optionalInteger(input, 'expiredAt', '$.expiredAt', issues, {
    min: 0,
  });

  if (issues.length > 0) {
    return invalid('Invalid approval-resolved message', issues);
  }

  return ok({
    type: 'approval-resolved',
    toolCallId: toolCallId as string,
    decision: decision as ApprovalResolvedMessage['decision'],
    ...(reason !== undefined ? { reason } : {}),
    ...(expiredAt !== undefined ? { expiredAt } : {}),
  });
}

export function validateErrorMessage(
  input: UnknownRecord
): ProtocolValidationResult<ErrorMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, ERROR_FIELDS, issues);

  const code = requiredString(input, 'code', '$.code', issues, {
    nonEmpty: true,
  });
  const message = requiredString(input, 'message', '$.message', issues);
  const runId = optionalString(input, 'runId', '$.runId', issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid('Invalid error message', issues);

  return ok({
    type: 'error',
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

  if (issues.length > 0) return invalid('Invalid pong message', issues);

  return ok({ type: 'pong' });
}

export function validateStatusResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<StatusResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, STATUS_RESPONSE_FIELDS, issues);

  const lifecycle = requiredRecord(input, 'lifecycle', '$.lifecycle', issues);
  const activeRuns = requiredArray(input, 'activeRuns', '$.activeRuns', issues);
  const pendingApprovals = requiredArray(
    input,
    'pendingApprovals',
    '$.pendingApprovals',
    issues
  );
  const recentApprovals = requiredArray(
    input,
    'recentApprovals',
    '$.recentApprovals',
    issues
  );
  const providerStatus = requiredRecord(
    input,
    'providerStatus',
    '$.providerStatus',
    issues
  );
  const mcpStatus = requiredRecord(input, 'mcpStatus', '$.mcpStatus', issues);
  const capabilities = requiredRecord(
    input,
    'capabilities',
    '$.capabilities',
    issues
  );

  if (lifecycle) {
    validateLifecycleSnapshot(lifecycle, '$.lifecycle', issues);
  }

  if (activeRuns) {
    activeRuns.forEach((run, index) =>
      validateStatusActiveRun(run, `$.activeRuns[${index}]`, issues)
    );
  }

  if (pendingApprovals) {
    pendingApprovals.forEach((approval, index) =>
      validatePendingApproval(approval, `$.pendingApprovals[${index}]`, issues)
    );
  }
  if (recentApprovals) {
    recentApprovals.forEach((approval, index) =>
      validatePendingApproval(approval, `$.recentApprovals[${index}]`, issues)
    );
  }

  if (providerStatus) {
    validateProviderStatus(providerStatus, '$.providerStatus', issues);
  }
  if (mcpStatus) {
    validateMcpStatus(mcpStatus, '$.mcpStatus', issues);
  }
  if (capabilities) {
    validateCapabilitySnapshot(capabilities, '$.capabilities', issues);
  }

  if (issues.length > 0)
    return invalid('Invalid status-response message', issues);

  return ok({
    type: 'status-response',
    lifecycle: lifecycle as unknown as StatusResponseMessage['lifecycle'],
    activeRuns: activeRuns as StatusResponseMessage['activeRuns'],
    pendingApprovals:
      pendingApprovals as StatusResponseMessage['pendingApprovals'],
    recentApprovals:
      recentApprovals as StatusResponseMessage['recentApprovals'],
    providerStatus:
      providerStatus as unknown as StatusResponseMessage['providerStatus'],
    mcpStatus: mcpStatus as unknown as StatusResponseMessage['mcpStatus'],
    capabilities:
      capabilities as unknown as StatusResponseMessage['capabilities'],
  });
}

export function validateCapabilitiesResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<CapabilitiesResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CAPABILITIES_RESPONSE_FIELDS, issues);

  const snapshot = requiredRecord(input, 'snapshot', '$.snapshot', issues);
  if (snapshot) {
    validateCapabilitySnapshot(snapshot, '$.snapshot', issues);
  }

  if (issues.length > 0)
    return invalid('Invalid capabilities-response message', issues);

  return ok({
    type: 'capabilities-response',
    snapshot: snapshot as unknown as CapabilitiesResponseMessage['snapshot'],
  });
}

export function validateConfigUpdatedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ConfigUpdatedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONFIG_UPDATED_FIELDS, issues);

  const updatedFields = requiredArray(
    input,
    'updatedFields',
    '$.updatedFields',
    issues
  );
  if (updatedFields) {
    updatedFields.forEach((field, index) => {
      if (typeof field !== 'string') {
        issues.push({
          path: `$.updatedFields[${index}]`,
          message: 'Expected string',
        });
      }
    });
  }

  if (issues.length > 0)
    return invalid('Invalid config-updated message', issues);

  return ok({
    type: 'config-updated',
    updatedFields: updatedFields as string[],
  });
}

export function validateLifecycleSnapshot(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, LIFECYCLE_FIELDS, issues, path);
  requiredEnum(
    value,
    'state',
    `${path}.state`,
    DAEMON_LIFECYCLE_STATES,
    issues
  );
  requiredString(value, 'startedAt', `${path}.startedAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, 'updatedAt', `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ('readyAt' in value)
    optionalString(value, 'readyAt', `${path}.readyAt`, issues, {
      nonEmpty: true,
    });
  if ('stoppingAt' in value)
    optionalString(value, 'stoppingAt', `${path}.stoppingAt`, issues, {
      nonEmpty: true,
    });
  if ('stoppedAt' in value)
    optionalString(value, 'stoppedAt', `${path}.stoppedAt`, issues, {
      nonEmpty: true,
    });
  requiredInteger(value, 'uptimeMs', `${path}.uptimeMs`, issues, { min: 0 });
  requiredNullableInteger(value, 'currentPort', `${path}.currentPort`, issues, {
    min: 0,
  });
  requiredInteger(
    value,
    'connectedClientCount',
    `${path}.connectedClientCount`,
    issues,
    { min: 0 }
  );
  requiredInteger(
    value,
    'totalClientConnectionCount',
    `${path}.totalClientConnectionCount`,
    issues,
    { min: 0 }
  );
  requiredInteger(
    value,
    'totalClientDisconnectCount',
    `${path}.totalClientDisconnectCount`,
    issues,
    { min: 0 }
  );
  requiredInteger(value, 'activeRunCount', `${path}.activeRunCount`, issues, {
    min: 0,
  });

  if ('recentDisconnect' in value) {
    validateClientDisconnect(
      value.recentDisconnect,
      `${path}.recentDisconnect`,
      issues
    );
  }
  if ('recentError' in value) {
    validateLifecycleDiagnostic(
      value.recentError,
      `${path}.recentError`,
      issues
    );
  }
  const eventStore = requiredRecord(
    value,
    'eventStore',
    `${path}.eventStore`,
    issues
  );
  if (eventStore)
    validateEventStoreStatus(eventStore, `${path}.eventStore`, issues);
  requiredEnum(
    value,
    'providerReadiness',
    `${path}.providerReadiness`,
    PROVIDER_READINESS_STATUSES,
    issues
  );
  requiredEnum(
    value,
    'mcpReadiness',
    `${path}.mcpReadiness`,
    MCP_READINESS_STATUSES,
    issues
  );
}

export function validateClientDisconnect(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'Expected object' });
    return;
  }

  rejectUnknownFields(value, CLIENT_DISCONNECT_FIELDS, issues, path);
  requiredString(value, 'clientId', `${path}.clientId`, issues, {
    nonEmpty: true,
  });
  requiredInteger(value, 'code', `${path}.code`, issues, { min: 0 });
  requiredString(value, 'reason', `${path}.reason`, issues);
  requiredString(value, 'connectedAt', `${path}.connectedAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, 'disconnectedAt', `${path}.disconnectedAt`, issues, {
    nonEmpty: true,
  });
  requiredInteger(value, 'durationMs', `${path}.durationMs`, issues, {
    min: 0,
  });
}

export function validateEventStoreStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, EVENT_STORE_STATUS_FIELDS, issues, path);
  requiredEnum(value, 'status', `${path}.status`, EVENT_STORE_STATUSES, issues);
  requiredString(value, 'path', `${path}.path`, issues, { nonEmpty: true });
  if ('failure' in value) {
    validateLifecycleDiagnostic(value.failure, `${path}.failure`, issues);
  }
}

export function validateLifecycleDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'Expected object' });
    return;
  }

  rejectUnknownFields(value, LIFECYCLE_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, 'code', `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, 'message', `${path}.message`, issues);
  requiredString(value, 'updatedAt', `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  requiredEnum(
    value,
    'source',
    `${path}.source`,
    LIFECYCLE_DIAGNOSTIC_SOURCES,
    issues
  );
  requiredEnum(
    value,
    'severity',
    `${path}.severity`,
    LIFECYCLE_DIAGNOSTIC_SEVERITIES,
    issues
  );
  if ('detail' in value)
    optionalString(value, 'detail', `${path}.detail`, issues);
  if ('metadata' in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: 'Expected object' });
  }
}

export function validateStatusActiveRun(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'Expected object' });
    return;
  }

  rejectUnknownFields(value, ACTIVE_RUN_FIELDS, issues, path);
  requiredString(value, 'runId', `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, 'prompt', `${path}.prompt`, issues);
  requiredString(value, 'status', `${path}.status`, issues, { nonEmpty: true });
  requiredInteger(value, 'startedAt', `${path}.startedAt`, issues, { min: 0 });
  requiredString(value, 'cwd', `${path}.cwd`, issues);
}

export function validatePendingApproval(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'Expected object' });
    return;
  }

  rejectUnknownFields(value, PENDING_APPROVAL_FIELDS, issues, path);
  requiredString(value, 'toolCallId', `${path}.toolCallId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, 'runId', `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, 'toolName', `${path}.toolName`, issues, {
    nonEmpty: true,
  });
  requiredString(value, 'summary', `${path}.summary`, issues);
  requiredInteger(value, 'createdAt', `${path}.createdAt`, issues, { min: 0 });
  requiredEnum(
    value,
    'status',
    `${path}.status`,
    ['pending', 'approved', 'denied', 'expired'],
    issues
  );
  requiredNullableInteger(value, 'timeoutMs', `${path}.timeoutMs`, issues, {
    min: 0,
  });
  requiredNullableInteger(value, 'expiresAt', `${path}.expiresAt`, issues, {
    min: 0,
  });
  requiredNullableInteger(value, 'remainingMs', `${path}.remainingMs`, issues, {
    min: 0,
  });
  if ('resolvedAt' in value)
    optionalInteger(value, 'resolvedAt', `${path}.resolvedAt`, issues, {
      min: 0,
    });
  if ('expiredAt' in value)
    optionalInteger(value, 'expiredAt', `${path}.expiredAt`, issues, {
      min: 0,
    });
  if ('reason' in value)
    optionalString(value, 'reason', `${path}.reason`, issues);
  if ('expiredReason' in value)
    optionalString(value, 'expiredReason', `${path}.expiredReason`, issues);
  if ('risk' in value) optionalString(value, 'risk', `${path}.risk`, issues);
  if ('riskReason' in value)
    optionalString(value, 'riskReason', `${path}.riskReason`, issues);
  if ('requiresDoubleConfirm' in value) {
    optionalBoolean(
      value,
      'requiresDoubleConfirm',
      `${path}.requiresDoubleConfirm`,
      issues
    );
  }
  if ('recommendSnapshot' in value) {
    optionalBoolean(
      value,
      'recommendSnapshot',
      `${path}.recommendSnapshot`,
      issues
    );
  }
  if ('metadata' in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: 'Expected object' });
  }
}

export function validateProviderStatus(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'Expected object' });
    return;
  }

  rejectUnknownFields(value, PROVIDER_STATUS_FIELDS, issues, path);
  requiredEnum(
    value,
    'credentialMode',
    `${path}.credentialMode`,
    PROVIDER_CREDENTIAL_MODES,
    issues
  );
  requiredEnum(
    value,
    'readiness',
    `${path}.readiness`,
    PROVIDER_READINESS_STATUSES,
    issues
  );
  requiredString(value, 'providerId', `${path}.providerId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, 'routeId', `${path}.routeId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, 'baseUrl', `${path}.baseUrl`, issues);
  requiredString(value, 'model', `${path}.model`, issues);
  requiredString(value, 'upstreamModel', `${path}.upstreamModel`, issues);
  requiredEnum(
    value,
    'endpoint',
    `${path}.endpoint`,
    PROVIDER_ENDPOINTS,
    issues
  );
  requiredBoolean(value, 'stream', `${path}.stream`, issues);
  requiredEnum(
    value,
    'systemPromptWireMode',
    `${path}.systemPromptWireMode`,
    SYSTEM_PROMPT_WIRE_MODES,
    issues
  );
  const apiKey = requiredRecord(value, 'apiKey', `${path}.apiKey`, issues);
  if (apiKey) validateRedactedApiKeyStatus(apiKey, `${path}.apiKey`, issues);
  requiredBoolean(value, 'hasDirectApiKey', `${path}.hasDirectApiKey`, issues);
  requiredEnum(
    value,
    'apiKeySource',
    `${path}.apiKeySource`,
    PROVIDER_API_KEY_SOURCES,
    issues
  );

  const gateway = requiredRecord(value, 'gateway', `${path}.gateway`, issues);
  if (gateway)
    validateProviderGatewayStatus(gateway, `${path}.gateway`, issues);
  if ('lastDiagnostic' in value) {
    validateProviderDiagnostic(
      value.lastDiagnostic,
      `${path}.lastDiagnostic`,
      issues
    );
  }
  requiredString(value, 'updatedAt', `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
}

export function validateRedactedApiKeyStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, PROVIDER_REDACTED_API_KEY_FIELDS, issues, path);
  requiredBoolean(value, 'hasApiKey', `${path}.hasApiKey`, issues);
  requiredEnum(
    value,
    'source',
    `${path}.source`,
    PROVIDER_API_KEY_SOURCES,
    issues
  );
  if ('last4' in value)
    optionalString(value, 'last4', `${path}.last4`, issues, { nonEmpty: true });
}

export function validateProviderGatewayStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, PROVIDER_GATEWAY_STATUS_FIELDS, issues, path);
  requiredBoolean(value, 'ready', `${path}.ready`, issues);
  requiredBoolean(
    value,
    'credentialConfigured',
    `${path}.credentialConfigured`,
    issues
  );
  const routeDecision = requiredArray(
    value,
    'routeDecision',
    `${path}.routeDecision`,
    issues
  );
  routeDecision?.forEach((item, index) => {
    if (typeof item !== 'string') {
      issues.push({
        path: `${path}.routeDecision[${index}]`,
        message: 'Expected string',
      });
    }
  });
  if ('code' in value)
    optionalString(value, 'code', `${path}.code`, issues, { nonEmpty: true });
  if ('selectedRouteId' in value)
    optionalString(
      value,
      'selectedRouteId',
      `${path}.selectedRouteId`,
      issues,
      { nonEmpty: true }
    );
  if ('selectedProviderId' in value)
    optionalString(
      value,
      'selectedProviderId',
      `${path}.selectedProviderId`,
      issues,
      { nonEmpty: true }
    );
  if ('selectedEndpointSupport' in value)
    optionalEnum(
      value,
      'selectedEndpointSupport',
      `${path}.selectedEndpointSupport`,
      PROVIDER_ENDPOINTS,
      issues
    );
  if ('selectedStreamingSupport' in value)
    optionalString(
      value,
      'selectedStreamingSupport',
      `${path}.selectedStreamingSupport`,
      issues,
      { nonEmpty: true }
    );
  if (
    'selectedCredentialSource' in value &&
    value.selectedCredentialSource !== undefined &&
    !isRecord(value.selectedCredentialSource)
  ) {
    issues.push({
      path: `${path}.selectedCredentialSource`,
      message: 'Expected object',
    });
  }
  if (
    'lastSuccess' in value &&
    value.lastSuccess !== undefined &&
    !isRecord(value.lastSuccess)
  ) {
    issues.push({ path: `${path}.lastSuccess`, message: 'Expected object' });
  }
  if (
    'lastFailure' in value &&
    value.lastFailure !== undefined &&
    !isRecord(value.lastFailure)
  ) {
    issues.push({ path: `${path}.lastFailure`, message: 'Expected object' });
  }
  if ('updatedAt' in value)
    optionalString(value, 'updatedAt', `${path}.updatedAt`, issues, {
      nonEmpty: true,
    });
}

export function validateProviderDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'Expected object' });
    return;
  }

  rejectUnknownFields(value, PROVIDER_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, 'code', `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, 'message', `${path}.message`, issues);
  requiredString(value, 'updatedAt', `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ('kind' in value)
    optionalString(value, 'kind', `${path}.kind`, issues, { nonEmpty: true });
  if ('status' in value)
    optionalInteger(value, 'status', `${path}.status`, issues, { min: 100 });
  if ('detail' in value)
    optionalString(value, 'detail', `${path}.detail`, issues);
  if ('metadata' in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: 'Expected object' });
  }
}

export function validateMcpStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, MCP_STATUS_FIELDS, issues, path);
  requiredBoolean(value, 'configured', `${path}.configured`, issues);
  requiredEnum(
    value,
    'readiness',
    `${path}.readiness`,
    MCP_READINESS_STATUSES,
    issues
  );
  requiredInteger(value, 'serverCount', `${path}.serverCount`, issues, {
    min: 0,
  });
  requiredRecord(value, 'summary', `${path}.summary`, issues);
  const diagnostics = requiredArray(
    value,
    'diagnostics',
    `${path}.diagnostics`,
    issues
  );
  diagnostics?.forEach((diagnostic, index) => {
    if (!isRecord(diagnostic)) {
      issues.push({
        path: `${path}.diagnostics[${index}]`,
        message: 'Expected object',
      });
    }
  });
  const servers = requiredArray(value, 'servers', `${path}.servers`, issues);
  servers?.forEach((server, index) => {
    if (!isRecord(server)) {
      issues.push({
        path: `${path}.servers[${index}]`,
        message: 'Expected object',
      });
    }
  });
  requiredString(value, 'updatedAt', `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
}

export function validateCapabilitySnapshot(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, CAPABILITY_SNAPSHOT_FIELDS, issues, path);
  const schemaVersion = requiredInteger(
    value,
    'schemaVersion',
    `${path}.schemaVersion`,
    issues,
    {
      min: 1,
    }
  );
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    issues.push({
      path: `${path}.schemaVersion`,
      message: 'Expected capability schema version 1',
    });
  }
  requiredString(value, 'generatedAt', `${path}.generatedAt`, issues, {
    nonEmpty: true,
  });
  const capabilities = requiredArray(
    value,
    'capabilities',
    `${path}.capabilities`,
    issues
  );
  capabilities?.forEach((capability, index) =>
    validateCapabilityRecord(
      capability,
      `${path}.capabilities[${index}]`,
      issues
    )
  );
}

export function validateCapabilityRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'Expected object' });
    return;
  }

  rejectUnknownFields(value, CAPABILITY_RECORD_FIELDS, issues, path);
  requiredString(value, 'id', `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, 'title', `${path}.title`, issues, { nonEmpty: true });
  requiredEnum(value, 'state', `${path}.state`, CAPABILITY_STATES, issues);
  requiredString(value, 'reason', `${path}.reason`, issues, { nonEmpty: true });
  requiredEnum(value, 'owner', `${path}.owner`, CAPABILITY_OWNERS, issues);
  requiredStringArray(
    value,
    'relatedMessageTypes',
    `${path}.relatedMessageTypes`,
    issues
  );
  requiredStringArray(
    value,
    'relatedTauriCommands',
    `${path}.relatedTauriCommands`,
    issues
  );
  requiredString(value, 'updatedAt', `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  const diagnostics = requiredArray(
    value,
    'diagnostics',
    `${path}.diagnostics`,
    issues
  );
  diagnostics?.forEach((diagnostic, index) =>
    validateCapabilityDiagnostic(
      diagnostic,
      `${path}.diagnostics[${index}]`,
      issues
    )
  );
}

export function validateCapabilityDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'Expected object' });
    return;
  }

  rejectUnknownFields(value, CAPABILITY_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, 'code', `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, 'message', `${path}.message`, issues, {
    nonEmpty: true,
  });
  requiredEnum(
    value,
    'severity',
    `${path}.severity`,
    CAPABILITY_DIAGNOSTIC_SEVERITIES,
    issues
  );
  requiredString(value, 'updatedAt', `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ('detail' in value)
    optionalString(value, 'detail', `${path}.detail`, issues);
  if ('metadata' in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: 'Expected object' });
  }
}

export function validateProbeProviderModelsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ProbeProviderModelsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PROBE_PROVIDER_MODELS_FIELDS, issues);

  const profileId = requiredString(input, 'profileId', '$.profileId', issues, {
    nonEmpty: true,
  });
  const baseUrl = requiredString(input, 'baseUrl', '$.baseUrl', issues, {
    nonEmpty: true,
  });
  const apiKey = requiredString(input, 'apiKey', '$.apiKey', issues, {
    nonEmpty: true,
  });

  if (issues.length > 0)
    return invalid('Invalid probe-provider-models message', issues);

  return ok({
    type: 'probe-provider-models',
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

  const profileId = requiredString(input, 'profileId', '$.profileId', issues, {
    nonEmpty: true,
  });
  const baseUrl = requiredString(input, 'baseUrl', '$.baseUrl', issues, {
    nonEmpty: true,
  });
  const apiKey = requiredString(input, 'apiKey', '$.apiKey', issues, {
    nonEmpty: true,
  });
  const model = requiredString(input, 'model', '$.model', issues, {
    nonEmpty: true,
  });

  if (issues.length > 0)
    return invalid('Invalid probe-provider-chat message', issues);

  return ok({
    type: 'probe-provider-chat',
    profileId: profileId!,
    baseUrl: baseUrl!,
    apiKey: apiKey!,
    model: model!,
  });
}

const PROVIDER_MODELS_PROBED_FIELDS = ['type', 'ok', 'models', 'error'];

export function validateProviderModelsProbedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ProviderModelsProbedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PROVIDER_MODELS_PROBED_FIELDS, issues);

  const okVal = requiredBoolean(input, 'ok', '$.ok', issues);
  const models = requiredArray(input, 'models', '$.models', issues);
  const error = optionalString(input, 'error', '$.error', issues);

  if (issues.length > 0)
    return invalid('Invalid provider-models-probed message', issues);

  return ok({
    type: 'provider-models-probed',
    ok: okVal!,
    models: (models || []).map((m) => String(m)),
    error,
  });
}

const PROVIDER_CHAT_PROBED_FIELDS = ['type', 'ok', 'latencyMs', 'error'];

export function validateProviderChatProbedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ProviderChatProbedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PROVIDER_CHAT_PROBED_FIELDS, issues);

  const okVal = requiredBoolean(input, 'ok', '$.ok', issues);
  const latencyMs = optionalNumber(input, 'latencyMs', '$.latencyMs', issues);
  const error = optionalString(input, 'error', '$.error', issues);

  if (issues.length > 0)
    return invalid('Invalid provider-chat-probed message', issues);

  return ok({
    type: 'provider-chat-probed',
    ok: okVal!,
    latencyMs,
    error,
  });
}
