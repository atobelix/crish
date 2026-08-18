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
// 纯函数拆分至 eventDedupe（T4-11 基线清零），re-export 维持消费方 import 路径不变
import {
  extractToolIdFromEnvelope,
  buildEventDedupeKey,
} from './eventDedupe';
export { extractToolIdFromEnvelope, buildEventDedupeKey };

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

  /** 因果时序乱序到达缓存区：处理 tool-end 先于 tool-start 到达的网络时序抖动，复合键 ${turn}:${toolId} */
  private readonly pendingToolEnds = new Map<string, BridgeEventEnvelope>();
  private readonly knownStartedTools = new Set<string>();
  /** 记录每个 toolId 归属的 turnIndex（DEC-05 / DIM-06） */
  private readonly toolTurnRegistry = new Map<string, number>();
  private currentTurnIndex = 0;

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

  /** 解析 tool 归属的有效 turnIndex，并登记到 toolTurnRegistry */
  private resolveToolTurn(
    envelope: BridgeEventEnvelope,
    toolId: string
  ): number {
    const rawTurn =
      typeof envelope.raw.turnIndex === 'number'
        ? envelope.raw.turnIndex
        : null;
    const eventTurn =
      envelope.kind === 'engine' &&
      'turnIndex' in envelope.event &&
      typeof (envelope.event as { turnIndex?: unknown }).turnIndex === 'number'
        ? (envelope.event as { turnIndex: number }).turnIndex
        : null;
    const explicitTurn = eventTurn ?? rawTurn;
    if (explicitTurn !== null) {
      if (toolId) this.toolTurnRegistry.set(toolId, explicitTurn);
      return explicitTurn;
    }
    if (toolId && this.toolTurnRegistry.has(toolId)) {
      return this.toolTurnRegistry.get(toolId)!;
    }
    return this.currentTurnIndex;
  }

  /** 构造因果缓冲复合键：${turn}:${toolId} */
  private buildCausalKey(envelope: BridgeEventEnvelope): string {
    const toolId = extractToolIdFromEnvelope(envelope);
    if (!toolId) return '';
    const turn = this.resolveToolTurn(envelope, toolId);
    return `${turn}:${toolId}`;
  }

  /** 排空所有由于乱序到达而遗留在因果缓冲中的悬挂事件 */
  public flushPendingCausalBuffers(
    reason: 'terminal' | 'abort' | 'timeout' = 'terminal'
  ): void {
    if (this.pendingToolEnds.size === 0) {
      return;
    }

    recordStreamDiag({
      runId: this.runId,
      scope: 'event-router',
      kind: 'causality-drain',
      message: `draining ${this.pendingToolEnds.size} pendingToolEnds on stream ${reason}`,
    });

    for (const [, endEnv] of this.pendingToolEnds.entries()) {
      dispatchEvent(this.env, endEnv);
    }
    this.pendingToolEnds.clear();
    this.knownStartedTools.clear();
  }

  /** 主路径分派：入参为具体事件信封类型（engine 或 legacy），未知形态不达此方法 */
  handleAgentEvent(envelope: BridgeEventEnvelope): void {
    if (this.state.cancelled || this.state.finished) return;
    if (isDataPlaneEventType(envelope.type)) return;

    // 维护当前活跃轮次
    if (envelope.type === 'turn-start') {
      const rawTurn =
        typeof envelope.raw.turnIndex === 'number'
          ? envelope.raw.turnIndex
          : null;
      const eventTurn =
        envelope.kind === 'engine' &&
        'turnIndex' in envelope.event &&
        typeof (envelope.event as { turnIndex?: unknown }).turnIndex ===
          'number'
          ? (envelope.event as { turnIndex: number }).turnIndex
          : null;
      const turn = eventTurn ?? rawTurn;
      if (turn !== null) {
        this.currentTurnIndex = turn;
      }
      dispatchEvent(this.env, envelope);
      return;
    }

    // 因果时序乱序到达缓冲拦截（复合键 ${turn}:${toolId}）
    if (envelope.type === 'tool-start') {
      const causalKey = this.buildCausalKey(envelope);
      if (causalKey) {
        this.knownStartedTools.add(causalKey);
      }
      dispatchEvent(this.env, envelope);

      // 若此前已有提前到达的 tool-end，在同一微任务内同步触发收口
      if (causalKey && this.pendingToolEnds.has(causalKey)) {
        const pendingEnd = this.pendingToolEnds.get(causalKey)!;
        this.pendingToolEnds.delete(causalKey);
        dispatchEvent(this.env, pendingEnd);
      }
      return;
    }

    if (envelope.type === 'tool-end') {
      const causalKey = this.buildCausalKey(envelope);
      if (causalKey && !this.knownStartedTools.has(causalKey)) {
        // tool-start 尚未到达，挂入因果缓冲队列
        this.pendingToolEnds.set(causalKey, envelope);
        recordStreamDiag({
          runId: this.runId,
          scope: 'event-router',
          kind: 'causality-buffered',
          message: `tool-end arrived before tool-start for ${causalKey}, buffering...`,
        });
        return;
      }
      dispatchEvent(this.env, envelope);
      return;
    }

    if (envelope.type === 'run-terminal' || envelope.type === 'agent-end') {
      this.flushPendingCausalBuffers('terminal');
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
    const dedupeKey = buildEventDedupeKey(parsed.data, this.currentTurnIndex);
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
