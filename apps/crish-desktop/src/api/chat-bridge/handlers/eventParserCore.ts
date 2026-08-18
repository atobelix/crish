/**
 * 核心事件宽容归一器表（T7）：agent/turn/message/tool/approval/checkpoint/
 * run-terminal/timeline-truncate 等核心域事件的宽容归一实现。
 *
 * 从 handlers/eventParser.ts 拆出（T4-11 基线清零），hub 保留
 * ENGINE_NORMALIZERS 合并声明与 parseBridgeEvent 单一解析入口。
 */
import {
  AGENT_END_REASON_VALUES,
  TIMELINE_TRUNCATE_REASON_VALUES,
} from '../../../../../../packages/shared-types/src/generated/engine';
import type {
  EngineEvent,
  AgentMessage,
  AgentEndReason,
  ApprovalDecision,
  PermissionRequest,
  TimelineTruncateReason,
  ToolMetadata,
  ToolBatchCall,
  ToolBatchResult,
  ContextCompressionRecord,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
} from '../../../../../../packages/shared-types/src/generated/engine';
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

/**
 * 核心域宽容归一器表（T-F 06 T4.1：键集与生成类型由
 * eventParser.normalizer-drift.test.ts 双向锁定——新增事件类型缺归一器即红）。
 */
export const CORE_NORMALIZERS: Record<string, Normalizer> = {
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
