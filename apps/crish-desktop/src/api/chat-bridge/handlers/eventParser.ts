/**
 * 事件解析单一入口（T7：双 zod 合并）。
 *
 * 解析顺序：
 * 1. 优先 T6 生成解析器 parseEngineEvent（严格契约，载荷完整时直出具体信封类型）；
 * 2. 生成解析器覆盖不了的前端宽容形态（缺 sessionId/timestamp 等信封字段、
 *    历史别名 text-delta / run-completed / run-failed / run-cancelled）由
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
import { AGENT_END_REASON_VALUES } from '../../../../../../packages/shared-types/src/generated/engine';
import type {
  EngineEvent,
  EngineEventType,
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
} from '../../../../../../packages/shared-types/src/generated/engine';
import { blockText } from './eventUtils';
import { logInternalError } from '../../userFacingErrors';

export type LegacyEventType =
  | 'subagent-started'
  | 'subagent-event'
  | 'subagent-ended'
  | 'error';

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

export type BridgeEventEnvelope = EngineEnvelope<EngineEventType> | LegacyEnvelope;

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
    (['terminal', 'filesystem', 'network', 'mcp', 'skill', 'agent', 'internal'] as const).includes(
      v as ToolCategory
    )
  );
}

function isToolConcurrency(v: unknown): v is ToolConcurrency {
  return (
    typeof v === 'string' &&
    (['parallel', 'sequential', 'exclusive'] as const).includes(v as ToolConcurrency)
  );
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
  return { checkpointId: '', toolCallId: '', toolName: '', restored: [], deleted: [], skipped: [] };
}

/** message-delta 的宽容 block 归一：text/thought 直读，tool-call/tool-result 原样透传，未知按 text 取 text/content */
function normalizeDeltaBlock(b: unknown): AgentMessageBlock {
  if (!isRecord(b)) return { type: 'text', text: '' };
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
function normalizeRunTerminal(raw: Record<string, unknown>, sourceType: string): EngineEvent {
  const rawTerm = String(raw.terminal ?? '').trim().toLowerCase();
  let terminal: RunTerminalStatus;
  if (rawTerm === 'failed' || rawTerm === 'error') terminal = 'failed';
  else if (rawTerm === 'cancelled' || rawTerm === 'canceled') terminal = 'cancelled';
  else if (rawTerm === 'completed') terminal = 'completed';
  else if (sourceType === 'run-failed') terminal = 'failed';
  else if (sourceType === 'run-cancelled') terminal = 'cancelled';
  else terminal = 'completed';
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
type Normalizer = (raw: Record<string, unknown>, type: string) => EngineEvent | null;

/**
 * tool-batch-start 的宽容 calls 抽取：从原始 payload 保留批内调用，不硬编码空数组。
 * 逐项宽容（id/toolCallId 别名、category/concurrency 默认值，语义对齐 tool-start 归一器）；
 * 原始 payload 无 calls 数组时返回 null（调用方记可观测日志后回退空数组）。
 */
function normalizeBatchCalls(rawCalls: unknown): ToolBatchCall[] | null {
  if (!Array.isArray(rawCalls)) return null;
  return rawCalls.map((c) => {
    const r = isRecord(c) ? c : {};
    return {
      id: str(r.id ?? r.toolCallId),
      toolName: str(r.toolName ?? r.name),
      summary: str(r.summary),
      input: (r.input ?? r.parameters ?? {}) as ToolBatchCall['input'],
      category: isToolCategory(r.category) ? r.category : 'terminal',
      concurrency: isToolConcurrency(r.concurrency) ? r.concurrency : 'sequential',
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

const ENGINE_NORMALIZERS: Record<string, Normalizer> = {
  'agent-start': (raw) => ({
    type: 'agent-start',
    sessionId: str(raw.sessionId),
    timestamp: str(raw.timestamp),
  }),
  'agent-end': (raw) => {
    const reason = str(raw.reason).trim() as AgentEndReason;
    if (!(AGENT_END_REASON_VALUES as readonly string[]).includes(reason)) return null;
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
    message: isRecord(raw.message) ? (raw.message as unknown as AgentMessage) : emptyAgentMessage(),
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
    block: { type: 'text', text: typeof raw.text === 'string' ? raw.text : blockText(raw) },
  }),
  'message-end': (raw) => {
    if (!isRecord(raw.message)) return null;
    return {
      type: 'message-end',
      sessionId: str(raw.sessionId),
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
        input: (call.input ?? raw.input ?? call.parameters ?? raw.parameters ?? {}) as ToolBatchCall['input'],
        category: isToolCategory(call.category) ? call.category : 'terminal',
        concurrency: isToolConcurrency(call.concurrency) ? call.concurrency : 'sequential',
      },
    };
  },
  'tool-update': (raw) => ({
    type: 'tool-update',
    sessionId: str(raw.sessionId),
    batchId: str(raw.batchId),
    toolCallId: str(raw.toolCallId),
    timestamp: str(raw.timestamp),
    update: isRecord(raw.update) ? (raw.update as unknown as ToolProgressUpdate) : {},
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
    ...(raw.retryable === true || raw.retryable === false ? { retryable: raw.retryable } : {}),
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
        toolMetadata: (isRecord(req.toolMetadata) ? req.toolMetadata : {}) as ToolMetadata,
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
      const behavior = str((d as Record<string, unknown>).behavior).trim().toLowerCase();
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
};

function isLegacyEventType(type: string): type is LegacyEventType {
  return (LEGACY_EVENT_TYPES as readonly string[]).includes(type);
}

/** 单一解析入口：返回已收窄的分派信封；未知形态 parseErr（由调用方登记） */
export function parseBridgeEvent(input: unknown): ParseResult<BridgeEventEnvelope> {
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
      return parseOk({ kind: 'engine', type: event.type, originalType: type, event, raw });
    }
  }

  if (isLegacyEventType(type)) {
    return parseOk({ kind: 'legacy', type, raw });
  }

  return parseErr(engine.error || `unknown engine event type '${type}'`);
}
