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
    // 侧背压缓冲）保证，前端不校验 sequence，亦不做乱序缓冲/去重/缺口检测。
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
    this.handleAgentEvent(parsed.data);
  };

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
