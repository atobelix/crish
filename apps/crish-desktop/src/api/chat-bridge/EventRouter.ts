/**
 * 事件路由器 —— IPC 平铺事件经单一解析入口进 Record<EventType, Handler> 分派表（T7）。
 *
 * - onMsg 仅做信封预过滤（runId 归属；sequence 由引擎单通道保证，前端
 *   不校验——F5-12 收口删除游标死代码）后交给 parseBridgeEvent；
 * - parseBridgeEvent 为唯一解析入口：优先 T6 生成解析器 parseEngineEvent，
 *   宽容形态（缺信封字段、text-delta / run-* 别名）在 handlers/eventParser 收敛；
 * - 分派走 handlers/dispatch 的 engineDispatchTable（41 键全覆盖）与
 *   legacyDispatchTable（subagent-* / error），handler 入参为具体事件信封类型；
 * - 未知事件（非生成类型且无归一器）进 registerUnknownEvent 显式登记，
 *   可观测、不静默吞；
 * - 四源失败统一收敛到 surfaceStreamFailure + finish（03 §2.4 表）。
 *
 * 事件载荷为 IPC 顶层平铺 `{ type, runId, sessionId, sequence, ... }`
 * （03 §3.1），不做二次归一；runId 过滤沿用 messageBelongsToRun。
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
   * 消费侧 per-run 幂等集合（04 §5.1-1 / G1/G2）：以 buildEventDedupeKey 生成的
   * 键记录本 run 已消费事件，同键重复到达（重复 message-end / 重复 delta /
   * 失败多源）只消费一次——防重复不再全押「引擎单发」单点，随 Router 收口释放。
   */
  private readonly consumedEvents = new Set<string>();

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
    // 双面隔离（14-T7）：数据面类型（task-* / timer-* / cron-fired）由全局
    // 数据面路由（dataPlaneRouter）消费，per-run 面直接 return 防重复
    // dispatch（34 §8.3）
    if (isDataPlaneEventType(envelope.type)) return;
    dispatchEvent(this.env, envelope);
  }

  onMsg = (msg: Record<string, unknown>): void => {
    if (this.state.cancelled || this.state.finished) return;
    const envelope = resolveEventType(msg);
    if (!envelope) return;
    const raw = envelope.raw;

    if (!messageBelongsToRun(raw.runId, this.runId)) return;

    // 顺序契约（F5-12 收口）：事件顺序由引擎单通道（Tauri IPC 串行 + Rust
    // 侧背压缓冲）保证，前端不校验 sequence，亦不做乱序缓冲/缺口检测
    // （消费侧幂等去重见 parse 成功后：同键重复只消费一次，04 §5.1-1）。
    // 事件桥已按「Delta 可丢、message-end 必达」契约实现（03 §5.3-6），
    // 丢帧类目丢弃不丢 message-end；如未来引入乱序通道，须在此补真游标。
    // C2.2：平铺事件直进主路径（event 信封 / run-ended 别名分支已删）
    // T3.7 D7：消费侧兜底——生成 parser 已有深度守卫（超限返回 parseErr），
    // 此处防其余未收敛异常路径（深层载荷曾抛 RangeError 逃逸破坏 fail-closed），
    // 捕获后转显式登记，不中断事件处理循环
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
    // 消费侧 per-run 幂等去重（04 §5.1-1 / G1/G2）：同 run 内重复到达的同一
    // 事件（重复 message-end / 重复 delta / 失败多源）只消费一次；键 =
    // type:messageId:sequence，实时轨 sequence=None 时退化 type:messageId，
    // 无 id 无 sequence 的事件不参与去重（透传）。静默跳过 + streamDiag 计数，
    // 不阻断事件流。
    const dedupeKey = buildEventDedupeKey(parsed.data);
    if (dedupeKey !== null && this.consumedEvents.has(dedupeKey)) {
      this.recordSkippedDuplicate(dedupeKey);
      return;
    }
    if (dedupeKey !== null) this.consumedEvents.add(dedupeKey);
    this.handleAgentEvent(parsed.data);
  };

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
 * 事件幂等键生成（消费侧去重，04 §5.1-1 / G1/G2）：
 * - 有 messageId + sequence（收口轨）→ `${type}:${messageId}:${sequence}`；
 * - sequence 缺失（实时轨）→ `${type}:${messageId}`（messageId + type 键控）；
 * - 无 messageId → `${type}:${sequence}`；
 * - 两者皆缺（legacy 信封 / 无键事件）→ 返回 null，不参与去重（透传）。
 * 注意：跨 turn 复用 clientMessageId 的收口轨事件由 sequence 区分（G4 不误伤）；
 * 实时轨 delta 的 messageId 键控存在多轮 turn 同 id 的误伤面，见回报⑤。
 */
export function buildEventDedupeKey(
  envelope: BridgeEventEnvelope
): string | null {
  if (envelope.kind === 'legacy') return null;
  const { event, raw } = envelope;
  let messageId = '';
  if (event.type === 'message-delta') {
    messageId = event.messageId ?? '';
  } else if (event.type === 'message-end') {
    messageId = event.message?.id ?? '';
  }
  if (!messageId && typeof raw.messageId === 'string') {
    messageId = raw.messageId;
  }
  const seq = raw.sequence;
  const sequence =
    seq === null || seq === undefined || seq === '' ? null : String(seq);
  if (messageId && sequence !== null) {
    return `${event.type}:${messageId}:${sequence}`;
  }
  if (messageId) return `${event.type}:${messageId}`;
  if (sequence !== null) return `${event.type}:${sequence}`;
  return null;
}
