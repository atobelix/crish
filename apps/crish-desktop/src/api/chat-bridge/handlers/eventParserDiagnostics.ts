/**
 * 诊断与系统事件宽容归一器（Provider / Runtime / Cache / SecurityAudit）。
 */
import type {
  EngineCacheWasteAlertEvent,
  EngineSecurityAuditEvent,
  EngineProviderRequestAnchoredEvent,
  ProviderDiagnostic,
  RunCacheStats,
  MissAttribution,
  SecurityAuditOperation,
  SecurityAuditDecision,
  ImpactAssessment,
  AgentMessage,
  AgentMessageRole,
  ProviderDiagnosticPhase,
  ProviderErrorKind,
  SystemPromptWireMode,
} from '../../../../../../packages/shared-types/src/generated/engine';
import {
  MISS_ATTRIBUTION_VALUES,
  SECURITY_AUDIT_OPERATION_VALUES,
  SECURITY_AUDIT_DECISION_VALUES,
  PROVIDER_DIAGNOSTIC_PHASE_VALUES,
  PROVIDER_ERROR_KIND_VALUES,
  SYSTEM_PROMPT_WIRE_MODE_VALUES,
  AGENT_MESSAGE_ROLE_VALUES,
} from '../../../../../../packages/shared-types/src/generated/engine';
import type { JsonValue } from '../../../../../../packages/shared-types/src/primitive-types';
import {
  alt,
  emptyAgentMessage,
  isRecord,
  normalizeDeltaBlock,
  num,
  str,
  strArray,
  withEnvelopeRunId,
  type Normalizer,
} from './eventParserShared';

/** cache-waste-alert 归因宽容判定：未知/缺失字符串兜底 unknown（8 类 kebab-case） */
function isMissAttribution(v: unknown): v is MissAttribution {
  return (
    typeof v === 'string' &&
    (MISS_ATTRIBUTION_VALUES as readonly string[]).includes(v)
  );
}

/**
 * cache-stats-updated.stats 的宽容归一（RunCacheStats，C6 ④兜底）：
 * 计数类字段缺失/非数值 → 0（聚合无贡献）；比例/时间类字段
 * null/缺失 → 不写字段（null = 未上报，区别于 0，前端隐藏而非显示 0%）。
 */
function normalizeRunCacheStats(rawStats: unknown): RunCacheStats {
  const r = isRecord(rawStats) ? rawStats : {};
  const stats: RunCacheStats = {
    promptTokens: num(r.promptTokens) ?? 0,
    completionTokens: num(r.completionTokens) ?? 0,
    totalTokens: num(r.totalTokens) ?? 0,
    cacheReadTokens: num(r.cacheReadTokens) ?? 0,
    cacheWriteTokens: num(r.cacheWriteTokens) ?? 0,
    cacheMissTokens: num(r.cacheMissTokens) ?? 0,
    sampleCount: num(r.sampleCount) ?? 0,
    missedTokens: num(r.missedTokens) ?? 0,
  };
  const hitRatio = num(r.hitRatio);
  if (hitRatio !== undefined) stats.hitRatio = hitRatio;
  const writeRatio = num(r.writeRatio);
  if (writeRatio !== undefined) stats.writeRatio = writeRatio;
  const warmUntilMs = num(r.warmUntilMs);
  if (warmUntilMs !== undefined) stats.warmUntilMs = warmUntilMs;
  return stats;
}

/** 安全审计操作类别判定（wire kebab-case 六值） */
function isAuditOperation(v: unknown): v is SecurityAuditOperation {
  return (
    typeof v === 'string' &&
    (SECURITY_AUDIT_OPERATION_VALUES as readonly string[]).includes(v)
  );
}

/** 安全审计处置决策判定（wire lowercase 六值） */
function isAuditDecision(v: unknown): v is SecurityAuditDecision {
  return (
    typeof v === 'string' &&
    (SECURITY_AUDIT_DECISION_VALUES as readonly string[]).includes(v)
  );
}

/** 影响面宽容归一：逐项容错，畸形/缺失回退全零空对象 */
function normalizeImpact(rawImpact: unknown): ImpactAssessment {
  const r = isRecord(rawImpact) ? rawImpact : {};
  return {
    fileCount: num(r.fileCount) ?? 0,
    totalSizeBytes: num(r.totalSizeBytes) ?? 0,
    directoryCount: num(r.directoryCount) ?? 0,
    crossDirectory: r.crossDirectory === true,
    flagged: r.flagged === true,
  };
}

function isProviderDiagnosticPhase(v: unknown): v is ProviderDiagnosticPhase {
  return (
    typeof v === 'string' &&
    (PROVIDER_DIAGNOSTIC_PHASE_VALUES as readonly string[]).includes(v)
  );
}

function isProviderErrorKind(v: unknown): v is ProviderErrorKind {
  return (
    typeof v === 'string' &&
    (PROVIDER_ERROR_KIND_VALUES as readonly string[]).includes(v)
  );
}

function isSystemPromptWireMode(v: unknown): v is SystemPromptWireMode {
  return (
    typeof v === 'string' &&
    (SYSTEM_PROMPT_WIRE_MODE_VALUES as readonly string[]).includes(v)
  );
}

function isAgentMessageRole(v: unknown): v is AgentMessageRole {
  return (
    typeof v === 'string' &&
    (AGENT_MESSAGE_ROLE_VALUES as readonly string[]).includes(v)
  );
}

/**
 * 消息体属性安全提取适配器：彻底消除 as unknown as AgentMessage 二次强转。
 */
export function normalizeAgentMessage(rawMsg: unknown): AgentMessage {
  if (!isRecord(rawMsg)) return emptyAgentMessage();
  const id = str(rawMsg.id);
  const rawRole = rawMsg.role;
  const role: AgentMessageRole = isAgentMessageRole(rawRole)
    ? rawRole
    : 'assistant';
  const createdAt = str(
    alt(rawMsg, 'createdAt', 'created_at') ?? rawMsg.timestamp
  );
  const blocks = Array.isArray(rawMsg.blocks)
    ? rawMsg.blocks.map(normalizeDeltaBlock)
    : [];
  return { id, role, createdAt, blocks };
}

/**
 * 提供商诊断数据类型安全属性提取适配器：彻底消除 as unknown as ProviderDiagnostic 二次强转。
 */
export function normalizeProviderDiagnostic(
  rawDiag: unknown
): ProviderDiagnostic {
  const r = isRecord(rawDiag) ? rawDiag : {};
  const rawPhase = alt(r, 'phase', 'code');
  const phase: ProviderDiagnosticPhase = isProviderDiagnosticPhase(rawPhase)
    ? rawPhase
    : 'request-start';

  const diag: ProviderDiagnostic = { phase };

  const providerId = str(alt(r, 'providerId', 'provider_id'));
  if (providerId) diag.providerId = providerId;

  const endpoint = str(r.endpoint);
  if (endpoint) diag.endpoint = endpoint;

  const url = str(r.url);
  if (url) diag.url = url;

  const attempt = num(r.attempt);
  if (attempt !== undefined) diag.attempt = attempt;

  const maxAttempts = num(alt(r, 'maxAttempts', 'max_attempts'));
  if (maxAttempts !== undefined) diag.maxAttempts = maxAttempts;

  const elapsedMs = num(alt(r, 'elapsedMs', 'elapsed_ms'));
  if (elapsedMs !== undefined) diag.elapsedMs = elapsedMs;

  const status = num(r.status);
  if (status !== undefined) diag.status = status;

  const statusText = str(alt(r, 'statusText', 'status_text'));
  if (statusText) diag.statusText = statusText;

  if (typeof r.retryable === 'boolean') diag.retryable = r.retryable;

  const reason = str(r.reason ?? r.message);
  if (reason) diag.reason = reason;

  const rawErrorKind = alt(r, 'errorKind', 'error_kind');
  if (isProviderErrorKind(rawErrorKind)) {
    diag.errorKind = rawErrorKind;
  }

  const retryAfterMs = num(alt(r, 'retryAfterMs', 'retry_after_ms'));
  if (retryAfterMs !== undefined) diag.retryAfterMs = retryAfterMs;

  const chunks = num(r.chunks);
  if (chunks !== undefined) diag.chunks = chunks;

  const bytes = num(r.bytes);
  if (bytes !== undefined) diag.bytes = bytes;

  if (
    r.headers !== undefined &&
    (isRecord(r.headers) || Array.isArray(r.headers))
  ) {
    diag.headers = r.headers as JsonValue;
  }

  const configuredModel = str(
    alt(r, 'configuredModel', 'configured_model') ?? r.model
  );
  if (configuredModel) diag.configuredModel = configuredModel;

  const actualModel = str(alt(r, 'actualModel', 'actual_model'));
  if (actualModel) diag.actualModel = actualModel;

  if (typeof r.modelMismatch === 'boolean')
    diag.modelMismatch = r.modelMismatch;
  else if (typeof r.model_mismatch === 'boolean')
    diag.modelMismatch = r.model_mismatch;

  if (typeof r.streamRequested === 'boolean')
    diag.streamRequested = r.streamRequested;
  else if (typeof r.stream_requested === 'boolean')
    diag.streamRequested = r.stream_requested;

  const rawWireMode = alt(r, 'systemPromptWireMode', 'system_prompt_wire_mode');
  if (isSystemPromptWireMode(rawWireMode)) {
    diag.systemPromptWireMode = rawWireMode;
  }

  if (typeof r.hasSystemRole === 'boolean')
    diag.hasSystemRole = r.hasSystemRole;
  else if (typeof r.has_system_role === 'boolean')
    diag.hasSystemRole = r.has_system_role;

  if (typeof r.systemPromptPresent === 'boolean')
    diag.systemPromptPresent = r.systemPromptPresent;
  else if (typeof r.system_prompt_present === 'boolean')
    diag.systemPromptPresent = r.system_prompt_present;

  const systemMessageCount = num(
    alt(r, 'systemMessageCount', 'system_message_count')
  );
  if (systemMessageCount !== undefined)
    diag.systemMessageCount = systemMessageCount;

  const rewrittenSystemMessageCount = num(
    alt(r, 'rewrittenSystemMessageCount', 'rewritten_system_message_count')
  );
  if (rewrittenSystemMessageCount !== undefined)
    diag.rewrittenSystemMessageCount = rewrittenSystemMessageCount;

  const messageCount = num(alt(r, 'messageCount', 'message_count'));
  if (messageCount !== undefined) diag.messageCount = messageCount;

  const toolCount = num(alt(r, 'toolCount', 'tool_count'));
  if (toolCount !== undefined) diag.toolCount = toolCount;

  if (r.messageRoleCounts !== undefined && isRecord(r.messageRoleCounts)) {
    diag.messageRoleCounts = r.messageRoleCounts as JsonValue;
  } else if (
    r.message_role_counts !== undefined &&
    isRecord(r.message_role_counts)
  ) {
    diag.messageRoleCounts = r.message_role_counts as JsonValue;
  }

  if (r.partial !== undefined) {
    diag.partial = r.partial as JsonValue;
  }

  return diag;
}

export const DIAGNOSTIC_NORMALIZERS: Record<string, Normalizer> = {
  'provider-diagnostic': (raw) => ({
    type: 'provider-diagnostic',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    diagnostic: normalizeProviderDiagnostic(
      isRecord(raw.diagnostic)
        ? raw.diagnostic
        : isRecord(raw.data)
          ? raw.data
          : {}
    ),
  }),
  'runtime-error': (raw) => ({
    type: 'runtime-error',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    error: typeof raw.error === 'string' ? raw.error : str(raw.data),
    ...(raw.retryable === true || raw.retryable === false
      ? { retryable: raw.retryable }
      : {}),
  }),
  'runtime-steering': (raw) => ({
    type: 'runtime-steering',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    reason: str(raw.reason),
    message: isRecord(raw.message)
      ? normalizeAgentMessage(raw.message)
      : emptyAgentMessage(),
  }),
  'runtime-intervention-required': (raw) => ({
    type: 'runtime-intervention-required',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    reason: str(raw.reason),
    choices: strArray(raw.choices),
    message: str(raw.message),
  }),
  'cache-stats-updated': (raw) =>
    withEnvelopeRunId(
      {
        type: 'cache-stats-updated' as const,
        sessionId: str(raw.sessionId),
        timestamp: str(raw.timestamp),
        stats: normalizeRunCacheStats(raw.stats),
      },
      raw
    ),
  'cache-waste-alert': (raw) => {
    const event: EngineCacheWasteAlertEvent = {
      type: 'cache-waste-alert',
      sessionId: str(raw.sessionId),
      timestamp: str(raw.timestamp),
      attribution: isMissAttribution(raw.attribution)
        ? raw.attribution
        : 'unknown',
      missedTokens: num(raw.missedTokens) ?? 0,
      idleMs: num(raw.idleMs) ?? 0,
      modelChanged: raw.modelChanged === true,
    };
    const missedCostUsd = num(raw.missedCostUsd);
    if (missedCostUsd !== undefined) event.missedCostUsd = missedCostUsd;
    return withEnvelopeRunId(event, raw);
  },
  'cold-cache-warning': (raw) =>
    withEnvelopeRunId(
      {
        type: 'cold-cache-warning' as const,
        sessionId: str(raw.sessionId),
        timestamp: str(raw.timestamp),
        ttlSeconds: num(raw.ttlSeconds) ?? 0,
        idleMs: num(raw.idleMs) ?? 0,
        resendEstimateTokens: num(raw.resendEstimateTokens) ?? 0,
      },
      raw
    ),
  'security-audit': (raw): EngineSecurityAuditEvent => {
    const event: EngineSecurityAuditEvent = {
      type: 'security-audit',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      timestamp: str(raw.timestamp),
      operation: isAuditOperation(raw.operation)
        ? raw.operation
        : 'command-exec',
      targets: strArray(raw.targets),
      impact: normalizeImpact(raw.impact),
      decision: isAuditDecision(raw.decision) ? raw.decision : 'denied',
    };
    const permissionMode = str(alt(raw, 'permissionMode', 'permission_mode'));
    if (permissionMode) event.permissionMode = permissionMode;
    const toolCallId = str(alt(raw, 'toolCallId', 'tool_call_id'));
    if (toolCallId) event.toolCallId = toolCallId;
    return withEnvelopeRunId(event, raw);
  },
  'provider-request-anchored': (raw): EngineProviderRequestAnchoredEvent => {
    const event: EngineProviderRequestAnchoredEvent = {
      type: 'provider-request-anchored',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      timestamp: str(raw.timestamp),
      turnIndex: num(alt(raw, 'turnIndex', 'turn_index')) ?? 0,
      requestStartedAtMs:
        num(alt(raw, 'requestStartedAtMs', 'request_started_at_ms')) ?? 0,
    };
    const model = str(raw.model);
    if (model) event.model = model;
    return withEnvelopeRunId(event, raw);
  },
};
