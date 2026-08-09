/**
 * 事件解析单一入口（T7：双 zod 合并）。
 *
 * 解析顺序：
 * 1. 优先 T6 生成解析器 parseEngineEvent（严格契约，载荷完整时直出具体信封类型）；
 * 2. 生成解析器覆盖不了的前端宽容形态（缺 sessionId/timestamp 等信封字段、
 *    历史别名 text-delta / run-completed / run-failed / run-cancelled、
 *    数据面 task 系与 timer、cron、security-audit 形状漂移）由
 *    本文件的宽容归一器兜底，全部收敛在本单一入口；
 * 3. 信封级遗留事件（subagent-* / error）以 legacy 信封直出；
 * 4. 其余一律 parseErr，由 EventRouter 显式登记 unknown-case（可观测，不静默吞）。
 *
 * resolveEventType 为纯信封类型抽取（type/event/kind 别名），供 onMsg 预过滤使用。
 */
import {
  parseEngineEvent,
  parseOk,
  parseErr,
  type ParseResult,
} from '../../../../../../packages/shared-types/src/generated/engine';
import {
  AGENT_END_REASON_VALUES,
  MISS_ATTRIBUTION_VALUES,
  SECURITY_AUDIT_OPERATION_VALUES,
  SECURITY_AUDIT_DECISION_VALUES,
} from '../../../../../../packages/shared-types/src/generated/engine';
import type {
  EngineEvent,
  EngineEventType,
  EngineCacheWasteAlertEvent,
  EngineSecurityAuditEvent,
  EngineTaskStartedEvent,
  EngineTaskOutputEvent,
  EngineTaskHeartbeatEvent,
  EngineTaskSuspiciousEvent,
  EngineTaskCompletedEvent,
  EngineTaskFailedEvent,
  EngineTaskKilledEvent,
  EngineTimerFiredEvent,
  EngineTimerCancelledEvent,
  EngineCronFiredEvent,
  AgentMessage,
  AgentMessageBlock,
  AgentMessageBlockToolCall,
  AgentMessageBlockToolResult,
  AgentEndReason,
  RunTerminalStatus,
  ApprovalDecision,
  PermissionRequest,
  ToolMetadata,
  ToolBatchCall,
  ToolBatchResult,
  ToolProgressUpdate,
  ProviderDiagnostic,
  ContextCompressionRecord,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
  ToolCategory,
  ToolConcurrency,
  RunCacheStats,
  MissAttribution,
  SecurityAuditOperation,
  SecurityAuditDecision,
  ImpactAssessment,
} from '../../../../../../packages/shared-types/src/generated/engine';
import type { JsonValue } from '../../../../../../packages/shared-types/src/primitive-types';
import { blockText } from './eventUtils';
import { logInternalError } from '../../userFacingErrors';

export type LegacyEventType =
  'subagent-started' | 'subagent-event' | 'subagent-ended' | 'error';

export const LEGACY_EVENT_TYPES: readonly LegacyEventType[] = [
  'subagent-started',
  'subagent-event',
  'subagent-ended',
  'error',
];

export interface EngineEnvelope<ET extends EngineEventType = EngineEventType> {
  kind: 'engine';
  type: ET;
  /** 原始 type 字段（宽容归一前的别名，如 run-cancelled），供 handler 区分行为 */
  originalType: string;
  event: Extract<EngineEvent, { type: ET }>;
  raw: Record<string, unknown>;
}

export interface LegacyEnvelope {
  kind: 'legacy';
  type: LegacyEventType;
  raw: Record<string, unknown>;
}

export type BridgeEventEnvelope =
  EngineEnvelope<EngineEventType> | LegacyEnvelope;

/** 纯信封类型抽取：type/event/kind 别名，trim 后返回；非对象/空 type 返回 null */
export function resolveEventType(
  event: unknown
): { type: string; raw: Record<string, unknown> } | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const raw = event as Record<string, unknown>;
  const type = String(raw.type ?? raw.event ?? raw.kind ?? '').trim();
  if (!type) return null;
  return { type, raw };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 宽容路径深度守卫（T-F 06 T4.4）：对齐生成 parser 的 256 层常量语义
 * （packages/shared-types/src/generated/engine/parser.ts:65-100，`depth > 256`
 * 拒绝）——宽容归一器透传自由 JSON（tool-call input / tool-result output /
 * message block）前先做深度检查，超限返回 true（调用方记可观测日志并回退），
 * 不依赖 EventRouter 顶层 try/catch 兜底（EventRouter.ts:109-115）。
 */
const MAX_JSON_DEPTH = 256;

function jsonDepthExceeds(v: unknown, budget: number = MAX_JSON_DEPTH): boolean {
  if (budget < 0) return true;
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (jsonDepthExceeds(item, budget - 1)) return true;
    }
    return false;
  }
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (jsonDepthExceeds(o[key], budget - 1)) return true;
  }
  return false;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function isToolCategory(v: unknown): v is ToolCategory {
  return (
    typeof v === 'string' &&
    (
      [
        'terminal',
        'filesystem',
        'network',
        'mcp',
        'skill',
        'agent',
        'internal',
      ] as const
    ).includes(v as ToolCategory)
  );
}

function isToolConcurrency(v: unknown): v is ToolConcurrency {
  return (
    typeof v === 'string' &&
    (['parallel', 'sequential', 'exclusive'] as const).includes(
      v as ToolConcurrency
    )
  );
}

/**
 * 工具分类宽容取值（T-F 06 T4.3 显式化）：合法值直通；未知/缺失 → 登记日志
 * 后回退 'terminal'（不再静默降级——Rust 新枚举值进兜底可观测）。
 * 非安全向：此处仅影响 UI 分类图标/分组，回退不改变安全语义。
 */
function toolCategoryOr(v: unknown): ToolCategory {
  if (isToolCategory(v)) return v;
  logInternalError(
    'engine-protocol',
    `未知 tool category '${String(v)}'，回退 terminal`
  );
  return 'terminal';
}

function emptyAgentMessage(): AgentMessage {
  return { id: '', role: 'assistant', createdAt: '', blocks: [] };
}

function emptyCheckpointRecord(): RuntimeCheckpointRecord {
  return {
    id: '',
    kind: 'workspace-checkpoint',
    label: '',
    toolCallId: '',
    toolName: '',
  };
}

function emptyCheckpointRestoreRecord(): RuntimeCheckpointRestoreRecord {
  return {
    checkpointId: '',
    toolCallId: '',
    toolName: '',
    restored: [],
    deleted: [],
    skipped: [],
  };
}

/** message-delta 的宽容 block 归一：text/thought 直读，tool-call/tool-result 原样透传，未知按 text 取 text/content */
function normalizeDeltaBlock(b: unknown): AgentMessageBlock {
  if (!isRecord(b)) return { type: 'text', text: '' };
  // T-F 06 T4.4：宽容路径深度守卫（对齐生成 parser 256 层语义）——
  // 超限返回可识别失败（空 text 块 + 日志），不依赖 EventRouter 顶层 catch。
  if (jsonDepthExceeds(b)) {
    logInternalError(
      'engine-protocol',
      'normalizeDeltaBlock 载荷超 256 层深度，回退空 text 块'
    );
    return { type: 'text', text: '' };
  }
  const kind = String(b.type ?? b.kind ?? '').trim();
  if (kind === 'thought') {
    const block: AgentMessageBlock = {
      type: 'thought',
      text: blockText(b),
      ...(b.redacted === true ? { redacted: true } : {}),
    };
    return block;
  }
  if (kind === 'tool-call') {
    return {
      type: 'tool-call',
      id: str(b.id ?? b.toolCallId),
      toolName: str(b.toolName ?? b.name),
      input: (b.input ?? {}) as AgentMessageBlockToolCall['input'],
    };
  }
  if (kind === 'tool-result') {
    return {
      type: 'tool-result',
      toolCallId: str(b.toolCallId ?? b.id),
      toolName: str(b.toolName ?? b.name),
      output: (b.output ?? {}) as AgentMessageBlockToolResult['output'],
      isError: b.isError === true,
    };
  }
  return { type: 'text', text: blockText(b) };
}

/** run-terminal 家族（含别名）宽容归一：terminal 拼写变体与来源 type 推断 */
function normalizeRunTerminal(
  raw: Record<string, unknown>,
  sourceType: string
): EngineEvent {
  const rawTerm = String(raw.terminal ?? '')
    .trim()
    .toLowerCase();
  let terminal: RunTerminalStatus;
  if (rawTerm === 'failed' || rawTerm === 'error') terminal = 'failed';
  else if (rawTerm === 'cancelled' || rawTerm === 'canceled')
    terminal = 'cancelled';
  else if (rawTerm === 'completed') terminal = 'completed';
  else if (sourceType === 'run-failed') terminal = 'failed';
  else if (sourceType === 'run-cancelled') terminal = 'cancelled';
  else {
    // T-F 06 T4.3：非安全向静默默认显式化——未知 terminal 不再静默降级
    // completed（Rust 新枚举值会被吞掉且不可观测），登记日志后回退。
    // 消费方宽容度：run-terminal 是前端硬依赖（terminal 字段必须为规范值），
    // 保留原始值会破坏生成类型消费，故回退 completed + 显式登记。
    logInternalError(
      'engine-protocol',
      `normalizeRunTerminal 未知 terminal '${rawTerm}'（来源 ${sourceType}），回退 completed`
    );
    terminal = 'completed';
  }
  const error =
    typeof raw.error === 'string'
      ? raw.error
      : typeof raw.message === 'string'
        ? raw.message
        : undefined;
  return {
    type: 'run-terminal',
    sessionId: str(raw.sessionId),
    runId: str(raw.runId),
    timestamp: str(raw.timestamp),
    terminal,
    ...(error ? { error } : {}),
  };
}

/**
 * 宽容归一器：生成解析器 parseEngineEvent 失败后的兜底。
 * 返回 null 表示该形态无法归一，交由 unknown-case 登记。
 */
type Normalizer = (
  raw: Record<string, unknown>,
  type: string
) => EngineEvent | null;

/**
 * tool-batch-start 的宽容 calls 抽取：从原始 payload 保留批内调用，不硬编码空数组。
 * 逐项宽容（id/toolCallId 别名、category/concurrency 默认值，语义对齐 tool-start 归一器）；
 * 原始 payload 无 calls 数组时返回 null（调用方记可观测日志后回退空数组）。
 */
function normalizeBatchCalls(rawCalls: unknown): ToolBatchCall[] | null {
  if (!Array.isArray(rawCalls)) return null;
  // T-F 06 T4.4：宽容路径深度守卫（对齐生成 parser 256 层语义）——
  // 超限返回 null（调用方记可观测日志后回退空数组），不依赖顶层 catch。
  if (jsonDepthExceeds(rawCalls)) {
    logInternalError(
      'engine-protocol',
      'normalizeBatchCalls 载荷超 256 层深度，回退空批'
    );
    return null;
  }
  return rawCalls.map((c) => {
    const r = isRecord(c) ? c : {};
    return {
      id: str(r.id ?? r.toolCallId),
      toolName: str(r.toolName ?? r.name),
      summary: str(r.summary),
      input: (r.input ?? r.parameters ?? {}) as ToolBatchCall['input'],
      category: toolCategoryOr(r.category),
      concurrency: isToolConcurrency(r.concurrency)
        ? r.concurrency
        : 'sequential',
    };
  });
}

/**
 * tool-batch-end 的宽容 calls 抽取：从原始 payload 保留批内结果，不硬编码空数组。
 * 逐项宽容（toolCallId/id 别名、output 字符串归一、isError 真值判定，语义对齐 tool-end 归一器）；
 * 原始 payload 无 calls 数组时返回 null（调用方记可观测日志后回退空数组）。
 */
function normalizeBatchResults(rawCalls: unknown): ToolBatchResult[] | null {
  if (!Array.isArray(rawCalls)) return null;
  return rawCalls.map((c) => {
    const r = isRecord(c) ? c : {};
    const output =
      typeof r.output === 'string'
        ? { text: r.output }
        : isRecord(r.output)
          ? (r.output as unknown as ToolBatchResult['output'])
          : {};
    return {
      id: str(r.toolCallId ?? r.id ?? r.tool_call_id),
      toolName: str(r.toolName ?? r.name),
      output,
      isError: r.isError === true || (r.error != null && r.error !== false),
      durationMs: num(r.durationMs) ?? 0,
    };
  });
}

/**
 * 事件体附加信封注入的 runId（可选）：Rust 三缓存事件的变体体不占 runId
 * 字段，由信封扁平化注入（raw 顶层同名键）；宽容归一时一并读入，
 * wire 层值与信封注入值天然一致（同一来源），老帧缺失时省略。
 */
function withEnvelopeRunId<E extends EngineEvent>(
  event: E,
  raw: Record<string, unknown>
): E {
  const runId = str(raw.runId);
  return runId ? Object.assign(event, { runId }) : event;
}

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

// ── 数据面 10 类事件宽容兜底辅助（14-T5：strict 失败后生效）──

/** 双形态取值：camelCase 优先、snake_case 兜底（风格对齐 backgroundTasksApi 双容错） */
function alt(
  raw: Record<string, unknown>,
  camel: string,
  snake: string
): unknown {
  const v = raw[camel];
  return v !== undefined ? v : raw[snake];
}

/** 日志尾部容错：字符串按单元素数组收窄，数组过滤字符串元素，其余空数组 */
function tailArray(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  return strArray(v);
}

/** 资源快照宽容读取：JSON 可序列化值直通，畸形/缺失回退空对象 */
function normalizeResource(v: unknown): JsonValue {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v as JsonValue;
  }
  if (Array.isArray(v) || isRecord(v)) return v as JsonValue;
  return {};
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

/**
 * 宽容归一器表（T-F 06 T4.1：键集与生成类型由
 * eventParser.normalizer-drift.test.ts 双向锁定——新增事件类型缺归一器即红）。
 */
export const ENGINE_NORMALIZERS: Record<string, Normalizer> = {
  'agent-start': (raw) => ({
    type: 'agent-start',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
  }),
  'agent-end': (raw) => {
    const reason = str(raw.reason).trim() as AgentEndReason;
    if (!(AGENT_END_REASON_VALUES as readonly string[]).includes(reason))
      return null;
    const event: EngineEvent = {
      type: 'agent-end',
      sessionId: str(raw.sessionId),
      timestamp: str(raw.timestamp),
      reason,
      ...(str(raw.error) ? { error: str(raw.error) } : {}),
    };
    return event;
  },
  'turn-start': (raw) => ({
    type: 'turn-start',
    sessionId: str(raw.sessionId),
    turnIndex: num(raw.turnIndex) ?? 0,
    timestamp: str(raw.timestamp),
  }),
  'turn-end': (raw) => ({
    type: 'turn-end',
    sessionId: str(raw.sessionId),
    turnIndex: num(raw.turnIndex) ?? 0,
    timestamp: str(raw.timestamp),
    toolCallCount: num(raw.toolCallCount) ?? 0,
  }),
  'message-start': (raw) => ({
    type: 'message-start',
    sessionId: str(raw.sessionId),
    message: isRecord(raw.message)
      ? (raw.message as unknown as AgentMessage)
      : emptyAgentMessage(),
  }),
  'message-delta': (raw) => ({
    type: 'message-delta',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    messageId: str(raw.messageId),
    block: normalizeDeltaBlock(raw.block),
  }),
  'text-delta': (raw) => ({
    type: 'message-delta',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    messageId: str(raw.messageId),
    block: {
      type: 'text',
      text: typeof raw.text === 'string' ? raw.text : blockText(raw),
    },
  }),
  'message-end': (raw) => {
    if (!isRecord(raw.message)) return null;
    return {
      type: 'message-end',
      sessionId: str(raw.sessionId),
      // G4：多轮 run 分段合并键；旧载荷缺省按 0（单段路径向后兼容）
      turnIndex: num(raw.turnIndex) ?? 0,
      message: raw.message as unknown as AgentMessage,
    };
  },
  'tool-start': (raw) => {
    const call = isRecord(raw.call) ? raw.call : {};
    return {
      type: 'tool-start',
      sessionId: str(raw.sessionId),
      batchId: str(raw.batchId ?? call.batchId),
      timestamp: str(raw.timestamp),
      call: {
        id: str(call.id ?? call.toolCallId ?? raw.toolCallId ?? raw.id),
        toolName: str(call.toolName ?? call.name ?? raw.toolName ?? raw.name),
        summary: str(call.summary ?? raw.summary),
        input: (call.input ??
          raw.input ??
          call.parameters ??
          raw.parameters ??
          {}) as ToolBatchCall['input'],
        category: toolCategoryOr(call.category),
        concurrency: isToolConcurrency(call.concurrency)
          ? call.concurrency
          : 'sequential',
      },
    };
  },
  'tool-update': (raw) => ({
    type: 'tool-update',
    sessionId: str(raw.sessionId),
    batchId: str(raw.batchId),
    toolCallId: str(raw.toolCallId),
    timestamp: str(raw.timestamp),
    update: isRecord(raw.update)
      ? (raw.update as unknown as ToolProgressUpdate)
      : {},
  }),
  'tool-end': (raw) => {
    const r = isRecord(raw.result) ? raw.result : raw;
    return {
      type: 'tool-end',
      sessionId: str(raw.sessionId),
      batchId: str(raw.batchId),
      timestamp: str(raw.timestamp),
      result: {
        id: str(r.toolCallId ?? r.id ?? r.tool_call_id),
        toolName: str(r.toolName ?? r.name),
        output:
          typeof r.output === 'string'
            ? { text: r.output }
            : isRecord(r.output)
              ? (r.output as unknown as ToolBatchResult['output'])
              : {},
        isError: r.isError === true || (r.error != null && r.error !== false),
        durationMs: num(r.durationMs) ?? 0,
      },
    };
  },
  'tool-batch-start': (raw) => {
    const calls = normalizeBatchCalls(raw.calls);
    if (!calls) {
      logInternalError(
        'engine-protocol',
        'tool-batch-start 宽容路径缺 calls 数组，批内调用为空'
      );
    }
    return {
      type: 'tool-batch-start',
      sessionId: str(raw.sessionId),
      batchId: str(raw.batchId),
      timestamp: str(raw.timestamp),
      summary: str(raw.summary),
      calls: calls ?? [],
    };
  },
  'tool-batch-end': (raw) => {
    const calls = normalizeBatchResults(raw.calls);
    if (!calls) {
      logInternalError(
        'engine-protocol',
        'tool-batch-end 宽容路径缺 calls 数组，批内结果为空'
      );
    }
    return {
      type: 'tool-batch-end',
      sessionId: str(raw.sessionId),
      batchId: str(raw.batchId),
      timestamp: str(raw.timestamp),
      calls: calls ?? [],
    };
  },
  'tool-input-repaired': (raw) => ({
    type: 'tool-input-repaired',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    toolCallId: str(raw.toolCallId),
    toolName: str(raw.toolName),
    notes: strArray(raw.notes),
  }),
  'context-compression-start': (raw) => ({
    type: 'context-compression-start',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    reason: str(raw.reason),
    tokensBefore: num(raw.tokensBefore) ?? 0,
  }),
  'context-compression-end': (raw) => ({
    type: 'context-compression-end',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    aborted: raw.aborted === true,
    ...(isRecord(raw.result)
      ? { result: raw.result as unknown as ContextCompressionRecord }
      : {}),
    ...(str(raw.error) ? { error: str(raw.error) } : {}),
  }),
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
  'approval-requested': (raw) => {
    const req = isRecord(raw.request) ? raw.request : raw;
    const parameters = isRecord(req.parameters)
      ? req.parameters
      : isRecord(req.input)
        ? req.input
        : undefined;
    return {
      type: 'approval-requested',
      sessionId: str(raw.sessionId),
      timestamp: str(raw.timestamp),
      request: {
        id: str(req.id ?? req.toolCallId ?? req.requestId ?? ''),
        sessionId: str(req.sessionId ?? raw.sessionId),
        cwd: str(req.cwd),
        toolCallId: str(req.toolCallId ?? req.id ?? req.requestId),
        toolName: str(req.toolName ?? req.name),
        parameters: (parameters ?? {}) as PermissionRequest['parameters'],
        summary: str(req.summary),
        toolMetadata: (isRecord(req.toolMetadata)
          ? req.toolMetadata
          : {}) as ToolMetadata,
      },
    };
  },
  'approval-resolved': (raw) => {
    const toolCallId = str(raw.toolCallId ?? raw.requestId ?? raw.id);
    let decision: ApprovalDecision = 'denied';
    const d = raw.decision;
    if (typeof d === 'string') {
      const s = d.trim().toLowerCase();
      if (s === 'approved' || s === 'allow') decision = 'approved';
      else if (s === 'expired') decision = 'expired';
    } else if (d && typeof d === 'object' && !Array.isArray(d)) {
      const behavior = str((d as Record<string, unknown>).behavior)
        .trim()
        .toLowerCase();
      if (behavior === 'allow') decision = 'approved';
    }
    return {
      type: 'approval-resolved',
      sessionId: str(raw.sessionId),
      timestamp: str(raw.timestamp),
      toolCallId,
      ...(str(raw.requestId) ? { requestId: str(raw.requestId) } : {}),
      decision,
    };
  },
  'checkpoint-created': (raw) => ({
    type: 'checkpoint-created',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    checkpoint: isRecord(raw.checkpoint)
      ? (raw.checkpoint as unknown as RuntimeCheckpointRecord)
      : emptyCheckpointRecord(),
  }),
  'checkpoint-restored': (raw) => ({
    type: 'checkpoint-restored',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
    restore: isRecord(raw.restore)
      ? (raw.restore as unknown as RuntimeCheckpointRestoreRecord)
      : emptyCheckpointRestoreRecord(),
  }),
  'run-terminal': (raw) => normalizeRunTerminal(raw, 'run-terminal'),
  'run-completed': (raw) => normalizeRunTerminal(raw, 'run-completed'),
  'run-failed': (raw) => normalizeRunTerminal(raw, 'run-failed'),
  'run-cancelled': (raw) => normalizeRunTerminal(raw, 'run-cancelled'),
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
  // ── 数据面 10 类宽容兜底（14-T5）──
  // 输出类型显式复用生成事件类型标注（packages/shared-types 生成类型，防漂移），
  // 字段 camelCase/snake_case 双形态读取，统一经 withEnvelopeRunId 补信封 runId。
  'task-started': (raw): EngineTaskStartedEvent =>
    withEnvelopeRunId(
      {
        type: 'task-started',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        taskId: str(alt(raw, 'taskId', 'task_id')),
        command: str(raw.command),
        cwd: str(raw.cwd),
        ownerRunId: str(alt(raw, 'ownerRunId', 'owner_run_id')),
        isDaemon: alt(raw, 'isDaemon', 'is_daemon') === true,
      },
      raw
    ),
  'task-output': (raw): EngineTaskOutputEvent => {
    const event: EngineTaskOutputEvent = {
      type: 'task-output',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      taskId: str(alt(raw, 'taskId', 'task_id')),
    };
    const line = str(raw.line);
    if (line) event.line = line;
    const chunk = str(raw.chunk);
    if (chunk) event.chunk = chunk;
    const lineCount = num(alt(raw, 'lineCount', 'line_count'));
    if (lineCount !== undefined) event.lineCount = lineCount;
    return withEnvelopeRunId(event, raw);
  },
  'task-heartbeat': (raw): EngineTaskHeartbeatEvent =>
    withEnvelopeRunId(
      {
        type: 'task-heartbeat',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        taskId: str(alt(raw, 'taskId', 'task_id')),
        resource: normalizeResource(raw.resource),
      },
      raw
    ),
  'task-suspicious': (raw): EngineTaskSuspiciousEvent =>
    withEnvelopeRunId(
      {
        type: 'task-suspicious',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        taskId: str(alt(raw, 'taskId', 'task_id')),
        silenceMs: num(alt(raw, 'silenceMs', 'silence_ms')) ?? 0,
        lastOutputAtMs: num(alt(raw, 'lastOutputAtMs', 'last_output_at_ms')) ?? 0,
      },
      raw
    ),
  'task-completed': (raw): EngineTaskCompletedEvent =>
    withEnvelopeRunId(
      {
        type: 'task-completed',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        taskId: str(alt(raw, 'taskId', 'task_id')),
        exitCode: num(alt(raw, 'exitCode', 'exit_code')) ?? 0,
        durationMs: num(alt(raw, 'durationMs', 'duration_ms')) ?? 0,
        lineCount: num(alt(raw, 'lineCount', 'line_count')) ?? 0,
      },
      raw
    ),
  'task-failed': (raw): EngineTaskFailedEvent =>
    withEnvelopeRunId(
      {
        type: 'task-failed',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        taskId: str(alt(raw, 'taskId', 'task_id')),
        exitCode: num(alt(raw, 'exitCode', 'exit_code')) ?? 0,
        tail: tailArray(raw.tail),
        durationMs: num(alt(raw, 'durationMs', 'duration_ms')) ?? 0,
      },
      raw
    ),
  'task-killed': (raw): EngineTaskKilledEvent => {
    const event: EngineTaskKilledEvent = {
      type: 'task-killed',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      taskId: str(alt(raw, 'taskId', 'task_id')),
      viaForce: alt(raw, 'viaForce', 'via_force') === true,
    };
    const diagnostics = str(raw.diagnostics);
    if (diagnostics) event.diagnostics = diagnostics;
    return withEnvelopeRunId(event, raw);
  },
  'timer-fired': (raw): EngineTimerFiredEvent =>
    withEnvelopeRunId(
      {
        type: 'timer-fired',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        timerId: str(alt(raw, 'timerId', 'timer_id')),
        prompt: str(raw.prompt),
        firedAtMs: num(alt(raw, 'firedAtMs', 'fired_at_ms')) ?? 0,
      },
      raw
    ),
  'timer-cancelled': (raw): EngineTimerCancelledEvent =>
    withEnvelopeRunId(
      {
        type: 'timer-cancelled',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        timerId: str(alt(raw, 'timerId', 'timer_id')),
        reason: str(raw.reason),
        cancelledAtMs: num(alt(raw, 'cancelledAtMs', 'cancelled_at_ms')) ?? 0,
      },
      raw
    ),
  'cron-fired': (raw): EngineCronFiredEvent =>
    withEnvelopeRunId(
      {
        type: 'cron-fired',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        cronId: str(alt(raw, 'cronId', 'cron_id')),
        prompt: str(raw.prompt),
        expression: str(raw.expression),
        iteration: num(raw.iteration) ?? 0,
        firedAtMs: num(alt(raw, 'firedAtMs', 'fired_at_ms')) ?? 0,
      },
      raw
    ),
  // security-audit：已真实消费（securityAuditHandlers → store），宽容兜底
  // 防形状漂移落 unknown；枚举漂移 operation 兜底 command-exec、
  // decision 兜底 denied（安全向 fail-closed）
  'security-audit': (raw): EngineSecurityAuditEvent => {
    const event: EngineSecurityAuditEvent = {
      type: 'security-audit',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      timestamp: str(raw.timestamp),
      operation: isAuditOperation(raw.operation) ? raw.operation : 'command-exec',
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
};

function isLegacyEventType(type: string): type is LegacyEventType {
  return (LEGACY_EVENT_TYPES as readonly string[]).includes(type);
}

/** 单一解析入口：返回已收窄的分派信封；未知形态 parseErr（由调用方登记） */
export function parseBridgeEvent(
  input: unknown
): ParseResult<BridgeEventEnvelope> {
  const envelope = resolveEventType(input);
  if (!envelope) {
    return parseErr('engine event is not an object or missing type');
  }
  const raw = envelope.raw;
  const type = envelope.type;

  const engine = parseEngineEvent(raw);
  if (engine.ok) {
    return parseOk({
      kind: 'engine',
      type: engine.data.type,
      originalType: type,
      event: engine.data,
      raw,
    });
  }

  const normalizer = ENGINE_NORMALIZERS[type];
  if (normalizer) {
    const event = normalizer(raw, type);
    if (event) {
      return parseOk({
        kind: 'engine',
        type: event.type,
        originalType: type,
        event,
        raw,
      });
    }
  }

  if (isLegacyEventType(type)) {
    return parseOk({ kind: 'legacy', type, raw });
  }

  return parseErr(engine.error || `unknown engine event type '${type}'`);
}
