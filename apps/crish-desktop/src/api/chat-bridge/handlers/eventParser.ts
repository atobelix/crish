/**
 * 事件解析单一入口（T7：双 zod 合并）。
 *
 * 解析顺序：
 * 1. 优先 T6 生成解析器 parseEngineEvent（严格契约，载荷完整时直出具体信封类型）；
 * 2. 生成解析器覆盖不了的前端宽容形态（缺 sessionId/timestamp 等信封字段、
 *    历史别名 text-delta / run-completed / run-failed / run-cancelled、
 *    数据面 task 系与 timer、cron、security-audit 形状漂移）由
 *    本文件及领域子模块的宽容归一器兜底，全部收敛在本单一入口；
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
import { AGENT_END_REASON_VALUES } from '../../../../../../packages/shared-types/src/generated/engine';
import type {
  EngineEvent,
  EngineEventType,
  AgentMessage,
  AgentEndReason,
  ApprovalDecision,
  PermissionRequest,
  TimelineTruncateReason,
  ToolMetadata,
  ToolBatchCall,
  ToolBatchResult,
  ToolProgressUpdate,
  ContextCompressionRecord,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
} from '../../../../../../packages/shared-types/src/generated/engine';
import { TIMELINE_TRUNCATE_REASON_VALUES } from '../../../../../../packages/shared-types/src/generated/engine';
import { blockText } from './eventUtils';
import { logInternalError } from '../../userFacingErrors';
import {
  emptyAgentMessage,
  emptyCheckpointRecord,
  emptyCheckpointRestoreRecord,
  isRecord,
  isToolConcurrency,
  normalizeBatchCalls,
  normalizeBatchResults,
  normalizeDeltaBlock,
  normalizeRunTerminal,
  num,
  str,
  toolCategoryOr,
  type Normalizer,
} from './eventParserShared';
import { DIAGNOSTIC_NORMALIZERS } from './eventParserDiagnostics';
import { TASK_NORMALIZERS } from './eventParserTask';
import { CONTINUITY_NORMALIZERS } from './eventParserContinuity';

export type { Normalizer } from './eventParserShared';

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

const CORE_NORMALIZERS: Record<string, Normalizer> = {
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
  // 撤回域（T1a 统一输入流收敛战役 → T3 补归一器键集漂移锁定）：timeline-truncate
  // 出站终态事件；宽容路径补 reason 规范值校验（非安全向显式登记回退 user-requested）
  'timeline-truncate': (raw) => {
    const reason = String(raw.reason ?? '').trim() as TimelineTruncateReason;
    const normalizedReason: TimelineTruncateReason = (
      TIMELINE_TRUNCATE_REASON_VALUES as readonly string[]
    ).includes(reason)
      ? reason
      : 'user-requested';
    return {
      type: 'timeline-truncate',
      sessionId: str(raw.sessionId),
      runId: str(raw.runId),
      boundarySeq: num(raw.boundarySeq) ?? 0,
      reason: normalizedReason,
      targetMessageId: str(raw.targetMessageId),
      timestamp: str(raw.timestamp),
    };
  },
};

/**
 * 宽容归一器表（T-F 06 T4.1：键集与生成类型由
 * eventParser.normalizer-drift.test.ts 双向锁定——新增事件类型缺归一器即红）。
 */
export const ENGINE_NORMALIZERS: Record<string, Normalizer> = {
  ...CORE_NORMALIZERS,
  ...DIAGNOSTIC_NORMALIZERS,
  ...TASK_NORMALIZERS,
  ...CONTINUITY_NORMALIZERS,
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
