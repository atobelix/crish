/**
 * 事件路由器 —— IPC 平铺事件经单一解析入口进 Record<EventType, Handler> 分派表（T7）。
 *
 * - onMsg 仅做信封预过滤（runId 归属；sequence 由引擎单通道保证，前端
 *   不校验——F5-12 收口删除游标死代码）后交给 parseBridgeEvent；
 * - parseBridgeEvent 为唯一解析入口：优先 T6 生成解析器 parseEngineEvent，
 *   宽容形态（缺信封字段、text-delta / run-* 别名）在 handlers/eventParser 收敛；
 * - 分派走 handlers/dispatch 的 engineDispatchTable（41 键全覆盖）与
 *   legacyDispatchTable（subagent-* / error），handler 入参为具体事件信封类型；
 * - 复合因果 Key 去重矩阵（FIN-06 / DIM-02）：实时轨 message-delta 100% 直通放行，
 *   工具事件按 `${type}:${turn}:${toolId}` 隔离，因果时序缓冲 pendingToolEnds 防乱序到达；
 * - 消费侧 per-run 去重集合 consumedEvents 具备 2000 条上限的 FIFO 淘汰机制，防内存泄漏。
 */
import type { StreamCallbacks } from '../chatApi';
import { logInternalError } from '../userFacingErrors';
import { recordStreamDiag } from '../streamDiag';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import { messageBelongsToRun } from './handlers/eventUtils';
import { resolveEventType } from './handlers/eventType';
import {
  parseBridgeEvent,
  type BridgeEventEnvelope,
} from './handlers/eventParser';
import { dispatchEvent } from './handlers/dispatch';
import { isDataPlaneEventType } from './dataPlaneRouter';
import type { HandlerEnv, SendLike } from './handlers/handlerEnv';
import type { StreamState } from './handlers/streamState';

export class EventRouter {
  private state: StreamState;
  private approvalFlow: ApprovalFlowMachine;
  private callbacks: StreamCallbacks;
  private runId: string;
  private sessionId: string;
  private finish: (force?: boolean) => void;
  private tryResumeFinish: () => void;
  private client?: SendLike;

  /**
   * 消费侧 per-run 幂等集合：以 buildEventDedupeKey 生成的键记录已消费事件。
   * 设定 2000 条上限的 FIFO 淘汰机制，彻底根除长会话内存泄漏。
   */
  private readonly consumedEvents = new Set<string>();
  private readonly MAX_CONSUMED_EVENTS = 2000;

  /** 因果时序乱序到达缓存区：处理 tool-end 先于 tool-start 到达的网络时序抖动 */
  private readonly pendingToolEnds = new Map<string, BridgeEventEnvelope>();
  private readonly knownStartedTools = new Set<string>();

  constructor(
    state: StreamState,
    approvalFlow: ApprovalFlowMachine,
    callbacks: StreamCallbacks,
    runId: string,
    finish: (force?: boolean) => void,
    tryResumeFinish: () => void,
    client?: SendLike,
    sessionId = ''
  ) {
    this.state = state;
    this.approvalFlow = approvalFlow;
    this.callbacks = callbacks;
    this.runId = runId;
    this.sessionId = sessionId;
    this.finish = finish;
    this.tryResumeFinish = tryResumeFinish;
    this.client = client;
  }

  /** 分派环境：各 handler 只经此环境访问共享状态（不直连 Router 实例） */
  private get env(): HandlerEnv {
    return {
      state: this.state,
      approvalFlow: this.approvalFlow,
      callbacks: this.callbacks,
      runId: this.runId,
      sessionId: this.sessionId,
      finish: this.finish,
      tryResumeFinish: this.tryResumeFinish,
      client: this.client,
    };
  }

  /** 主路径分派：入参为具体事件信封类型（engine 或 legacy），未知形态不达此方法 */
  handleAgentEvent(envelope: BridgeEventEnvelope): void {
    if (this.state.cancelled || this.state.finished) return;
    if (isDataPlaneEventType(envelope.type)) return;

    // 因果时序乱序到达缓冲拦截
    if (envelope.type === 'tool-start') {
      const toolId = extractToolIdFromEnvelope(envelope);
      if (toolId) {
        this.knownStartedTools.add(toolId);
      }
      dispatchEvent(this.env, envelope);

      // 若此前已有提前到达的 tool-end，在同一微任务内同步触发收口
      if (toolId && this.pendingToolEnds.has(toolId)) {
        const pendingEnd = this.pendingToolEnds.get(toolId)!;
        this.pendingToolEnds.delete(toolId);
        dispatchEvent(this.env, pendingEnd);
      }
      return;
    }

    if (envelope.type === 'tool-end') {
      const toolId = extractToolIdFromEnvelope(envelope);
      if (toolId && !this.knownStartedTools.has(toolId)) {
        // tool-start 尚未到达，挂入因果缓冲队列
        this.pendingToolEnds.set(toolId, envelope);
        recordStreamDiag({
          runId: this.runId,
          scope: 'event-router',
          kind: 'causality-buffered',
          message: `tool-end arrived before tool-start for ${toolId}, buffering...`,
        });
        return;
      }
      dispatchEvent(this.env, envelope);
      return;
    }

    dispatchEvent(this.env, envelope);
  }

  onMsg = (msg: Record<string, unknown>): void => {
    if (this.state.cancelled || this.state.finished) return;
    const envelope = resolveEventType(msg);
    if (!envelope) return;
    const raw = envelope.raw;

    if (!messageBelongsToRun(raw.runId, this.runId)) return;

    let parsed: ReturnType<typeof parseBridgeEvent>;
    try {
      parsed = parseBridgeEvent(raw);
    } catch (e) {
      this.registerUnknownEvent(raw, 'parser threw: ' + String(e));
      return;
    }
    if (parsed.ok !== true) {
      this.registerUnknownEvent(raw, parsed.error);
      return;
    }

    // 复合因果 Key 去重检查（流式 delta 无 seq 时 100% 直通放行）
    const dedupeKey = buildEventDedupeKey(parsed.data);
    if (dedupeKey !== null && this.consumedEvents.has(dedupeKey)) {
      this.recordSkippedDuplicate(dedupeKey);
      return;
    }
    if (dedupeKey !== null) {
      this.recordConsumedEvent(dedupeKey);
    }

    this.handleAgentEvent(parsed.data);
  };

  /** FIFO 淘汰机制记录已消费事件（上限 2000 条） */
  private recordConsumedEvent(key: string): void {
    if (this.consumedEvents.size >= this.MAX_CONSUMED_EVENTS) {
      const oldest = this.consumedEvents.values().next().value;
      if (oldest !== undefined) {
        this.consumedEvents.delete(oldest);
      }
    }
    this.consumedEvents.add(key);
  }

  /** 重复事件跳过：静默 + recordStreamDiag 可观测计数（不阻断） */
  private recordSkippedDuplicate(key: string): void {
    recordStreamDiag({
      runId: this.runId,
      scope: 'event-dedupe',
      kind: 'duplicate',
      message: `duplicate event skipped: ${key}`,
    });
  }

  /** 未知事件显式登记：可观测（logInternalError），不静默吞 */
  private registerUnknownEvent(
    raw: Record<string, unknown>,
    error: string
  ): void {
    logInternalError('engine-unknown-event', {
      error,
      type: String(raw.type ?? raw.event ?? raw.kind ?? ''),
      payload: raw,
    });
  }
}

/**
 * 辅助函数：从信封中安全提取 toolId（FIN-06 统一寻址）
 */
export function extractToolIdFromEnvelope(
  envelope: BridgeEventEnvelope
): string {
  const { raw } = envelope;
  if (envelope.kind === 'engine') {
    const { event } = envelope;
    if (
      'call' in event &&
      event.call &&
      typeof event.call === 'object' &&
      'id' in event.call
    ) {
      const id = String((event.call as { id?: unknown }).id ?? '').trim();
      if (id) return id;
    }
    if (
      'result' in event &&
      event.result &&
      typeof event.result === 'object' &&
      'id' in event.result
    ) {
      const id = String((event.result as { id?: unknown }).id ?? '').trim();
      if (id) return id;
    }
    if (
      'callId' in event &&
      typeof (event as { callId?: unknown }).callId === 'string'
    ) {
      const id = ((event as { callId: string }).callId || '').trim();
      if (id) return id;
    }
  }
  if (typeof raw.toolCallId === 'string' && raw.toolCallId.trim()) {
    return raw.toolCallId.trim();
  }
  if (typeof raw.callId === 'string' && raw.callId.trim()) {
    return raw.callId.trim();
  }
  if (typeof raw.id === 'string' && raw.id.trim()) {
    return raw.id.trim();
  }
  if (
    raw.call &&
    typeof raw.call === 'object' &&
    'id' in (raw.call as object)
  ) {
    const id = String((raw.call as { id?: unknown }).id ?? '').trim();
    if (id) return id;
  }
  if (
    raw.result &&
    typeof raw.result === 'object' &&
    'id' in (raw.result as object)
  ) {
    const id = String((raw.result as { id?: unknown }).id ?? '').trim();
    if (id) return id;
  }
  return '';
}

/**
 * 复合因果 Key 去重矩阵（FIN-06 / DIM-02 权威规范）：
 * - message-delta：实时轨（无 sequence）坚决返回 null 100% 直通放行，彻底根除 "TheTheThe..." 乱码与吞词；
 * - 工具事件：统一按 `${type}:${turn}:${toolId}` 安全取值，消除 undefined 误杀；
 * - 轮次事件与终态消息：带 turnIndex 隔离多轮自主循环；
 * - 其余通用事件：按 `${type}:${messageId}:${sequence}` 或 `${type}:${sequence}` 幂等。
 */
export function buildEventDedupeKey(
  envelope: BridgeEventEnvelope
): string | null {
  if (envelope.kind === 'legacy') return null;
  const { event, raw } = envelope;

  // 1. 增量流式 Delta：实时轨无 sequence 时必须返回 null 100% 透传，严禁按 messageId 拦截
  if (event.type === 'message-delta') {
    const seq = raw.sequence;
    if (seq !== null && seq !== undefined && seq !== '') {
      const messageId =
        event.messageId ||
        (typeof raw.messageId === 'string' ? raw.messageId : '');
      return `message-delta:${messageId}:${String(seq)}`;
    }
    return null; // 实时轨 Token 增量全量放行！
  }

  // 2. 工具域事件：严格按 toolId + turnIndex 复合因果隔离
  if (
    event.type === 'tool-start' ||
    event.type === 'tool-update' ||
    event.type === 'tool-end'
  ) {
    const toolId = extractToolIdFromEnvelope(envelope);
    const seq = raw.sequence;
    const sequence =
      seq === null || seq === undefined || seq === '' ? null : String(seq);
    const turnIndex =
      'turnIndex' in event &&
      typeof (event as { turnIndex?: unknown }).turnIndex === 'number'
        ? (event as { turnIndex: number }).turnIndex
        : typeof raw.turnIndex === 'number'
          ? raw.turnIndex
          : null;
    const turn = turnIndex !== null ? `turn-${turnIndex}` : 't0';

    if (toolId && sequence !== null) {
      return `${event.type}:${turn}:${toolId}:${sequence}`;
    }
    if (toolId) {
      if (event.type === 'tool-update') return null; // 进度更新无 seq 全放行
      return `${event.type}:${turn}:${toolId}`;
    }
    if (sequence !== null) return `${event.type}:${sequence}`;
    return null;
  }

  // 3. 轮次域与终态消息：结合 turnIndex 隔离多轮自主循环
  if (
    event.type === 'turn-start' ||
    event.type === 'turn-end' ||
    event.type === 'message-end'
  ) {
    const turnIdx =
      'turnIndex' in event &&
      typeof (event as { turnIndex?: unknown }).turnIndex === 'number'
        ? (event as { turnIndex: number }).turnIndex
        : typeof raw.turnIndex === 'number'
          ? raw.turnIndex
          : null;
    const seq = raw.sequence;
    const sequence =
      seq === null || seq === undefined || seq === '' ? null : String(seq);
    let messageId = '';
    if (event.type === 'message-end' && event.message?.id) {
      messageId = event.message.id;
    } else if (typeof raw.messageId === 'string') {
      messageId = raw.messageId;
    }

    const turnTag = turnIdx !== null ? `turn-${turnIdx}` : 't0';

    if (sequence !== null) {
      return `${event.type}:${messageId || 'm'}:${turnTag}:${sequence}`;
    }
    if (turnIdx !== null) {
      return `${event.type}:${messageId || 'm'}:${turnTag}`;
    }
    if (event.type === 'message-end') {
      return messageId ? `message-end:${messageId}:${turnTag}` : null;
    }
    return null;
  }

  // 4. 其余通用事件
  const seq = raw.sequence;
  const sequence =
    seq === null || seq === undefined || seq === '' ? null : String(seq);
  const messageId = typeof raw.messageId === 'string' ? raw.messageId : '';
  if (messageId && sequence !== null) {
    return `${event.type}:${messageId}:${sequence}`;
  }
  if (sequence !== null) return `${event.type}:${sequence}`;
  return null;
}
