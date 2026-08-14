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
} from '../../../../../../packages/shared-types/src/generated/engine';
import {
  MISS_ATTRIBUTION_VALUES,
  SECURITY_AUDIT_OPERATION_VALUES,
  SECURITY_AUDIT_DECISION_VALUES,
} from '../../../../../../packages/shared-types/src/generated/engine';
import {
  alt,
  emptyAgentMessage,
  isRecord,
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

export const DIAGNOSTIC_NORMALIZERS: Record<string, Normalizer> = {
  'provider-diagnostic': (raw) => ({
    type: 'provider-diagnostic',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    diagnostic: (isRecord(raw.diagnostic)
      ? raw.diagnostic
      : isRecord(raw.data)
        ? raw.data
        : {}) as unknown as ProviderDiagnostic,
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
      ? (raw.message as unknown as AgentMessage)
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
