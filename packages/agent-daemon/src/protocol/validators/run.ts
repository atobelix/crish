// Protocol validators: run message family
import type {
  ApproveToolMessage,
  ApprovalRequestedMessage,
  ApprovalResolvedMessage,
  CancelRunMessage,
  DaemonReadyMessage,
  DenyToolMessage,
  ErrorMessage,
  EventMessage,
  ListCapabilitiesMessage,
  PingMessage,
  PongMessage,
  RunTaskMessage,
  StreamPauseMessage,
  StreamResumeMessage,
} from '../../types.js';
import type {
  JsonObject,
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from './common.js';
import {
  APPROVAL_REQUESTED_FIELDS,
  APPROVAL_RESOLVED_FIELDS,
  APPROVE_TOOL_FIELDS,
  CANCEL_RUN_FIELDS,
  DAEMON_READY_FIELDS,
  DENY_TOOL_FIELDS,
  EMPTY_COMMAND_FIELDS,
  ERROR_FIELDS,
  EVENT_FIELDS,
  RUN_TASK_FIELDS,
  STREAM_PAUSE_FIELDS,
  STREAM_RESUME_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  optionalStringArray,
  rejectUnknownFields,
  requiredEnum,
  requiredInteger,
  requiredNullableInteger,
  requiredRecord,
  requiredString,
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
    type: 'run-task' as const,
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
  } as RunTaskMessage);
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

export function validateListCapabilitiesMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListCapabilitiesMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0)
    return invalid('Invalid list-capabilities message', issues);

  return ok({ type: 'list-capabilities' });
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
