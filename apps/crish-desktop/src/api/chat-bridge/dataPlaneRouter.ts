/**
 * 全局数据面路由（14-T7）：task-* 7 + timer-* 2 + cron-fired 共 10 类事件的
 * 真实消费面。
 *
 * 背景（A-04 根因，34 §8.2）：
 * - 任务/定时器域事件为数据面（信封 runId/sequence 均不注入，34 §8.6），
 *   经 per-run EventRouter 到达时按 messageBelongsToRun 对无 runId 事件放行
 *   ——run 期间双面并存；run 结束 router 卸载后，跨 run 存活任务的后续事件
 *   无消费者；
 * - transport 已有现成全局广播订阅 onMessage（tauriTransport.ts:204-211，
 *   懒订阅 workbench-run-event fanout）——本模块复用该 fanout 建全局数据面
 *   路由，无需新监听通道。
 *
 * 职责：
 * - 模块级单例订阅 transport.onMessage（refcount 对齐 useEngineState 模式，
 *   归零退订防泄漏）；transport 重连后 fanout 自动恢复（懒订阅机制现成）；
 * - 只处理 DATA_PLANE_EVENT_TYPES，复用 resolveEventType / parseBridgeEvent
 *   解析，经 dispatchEvent 分派到 taskEventHandlers 的 10 个真实消费 handler；
 * - 不带 runId 过滤（数据面事件 runId 为 None）；
 * - per-run EventRouter 对数据面类型直接 return（isDataPlaneEventType 共享
 *   常量），双面隔离防重复 dispatch。
 *
 * 激活接线（待装配）：本批交付注入式验收（34 §8.5）；生产侧订阅方
 * （轮询层 useEngineState / useBackgroundTaskPolling 等）接入点 = 调用
 * ensureDataPlaneRouter() 持有引用（A-04 邻接登记，34 §9）。
 */
import { getTransport } from '../transport';
import { logInternalError } from '../userFacingErrors';
import {
  resolveEventType,
  parseBridgeEvent,
  type BridgeEventEnvelope,
} from './handlers/eventParser';
import { dispatchEvent } from './handlers/dispatch';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import type { StreamCallbacks } from '../chatApi';
import type { StreamState } from './handlers/streamState';
import type { HandlerEnv } from './handlers/handlerEnv';

/**
 * 数据面事件类型集合（task-* 7 + timer-* 2 + cron-fired）。
 * wire 名 = conex-types events.rs serde rename，与 Rust 发射面契约一一对应
 * （34 §8.6；security-audit 默认不入——现走 per-run 面已真实消费，并入防
 * 双面双写）。
 */
export const DATA_PLANE_EVENT_TYPES = [
  'task-started',
  'task-output',
  'task-heartbeat',
  'task-suspicious',
  'task-completed',
  'task-failed',
  'task-killed',
  'timer-fired',
  'timer-cancelled',
  'cron-fired',
] as const;

export type DataPlaneEventType = (typeof DATA_PLANE_EVENT_TYPES)[number];

/** 数据面类型判定（EventRouter 数据面隔离共用，防双面重复 dispatch） */
export function isDataPlaneEventType(type: string): type is DataPlaneEventType {
  return (DATA_PLANE_EVENT_TYPES as readonly string[]).includes(type);
}

// ── 数据面空环境 ──────────────────────────────────────────────

/**
 * 数据面事件 runId 为 None、无 run 上下文，handler 不触碰 env——
 * 此处为共享的 no-op 最小环境（真实对象组装，非测试替身），
 * 仅满足 dispatchEvent 签名要求。
 */
const NOOP = (): void => {};

const dataPlaneState: StreamState = {
  cancelled: false,
  finished: false,
  assistantText: '',
  assistantThought: '',
  unsub: null,
  endTimer: null,
};

const dataPlaneCallbacks: StreamCallbacks = {
  onThought: NOOP,
  onToolStart: NOOP,
  onToolSuccess: NOOP,
  onToolError: NOOP,
  onChunk: NOOP,
  onComplete: NOOP,
};

const dataPlaneEnv: HandlerEnv = {
  state: dataPlaneState,
  approvalFlow: new ApprovalFlowMachine(),
  callbacks: dataPlaneCallbacks,
  runId: '',
  sessionId: '',
  finish: NOOP,
  tryResumeFinish: NOOP,
};

// ── 模块级单例 + refcount 生命周期 ─────────────────────────────

let _refCount = 0;
let _unsubMessage: (() => void) | null = null;

function handleDataPlaneMessage(msg: Record<string, unknown>): void {
  const envelope = resolveEventType(msg);
  if (!envelope) return;
  // 只处理数据面类型：run 内类型不被数据面路由拦截（各自消费面分治）
  if (!isDataPlaneEventType(envelope.type)) return;
  // T3.7 D7：解析异常兜底——异常转可观测登记，不中断消息循环
  let parsed: ReturnType<typeof parseBridgeEvent>;
  try {
    parsed = parseBridgeEvent(msg);
  } catch (e) {
    logInternalError('data-plane-parse-failed', {
      type: envelope.type,
      error: 'parser threw: ' + String(e),
      payload: msg,
    });
    return;
  }
  if (parsed.ok !== true) {
    // 数据面类型解析失败属形状漂移：宽容归一器兜底后仍失败 → 可观测，不静默吞
    logInternalError('data-plane-parse-failed', {
      type: envelope.type,
      error: parsed.error,
      payload: msg,
    });
    return;
  }
  dispatchEvent(dataPlaneEnv, parsed.data as BridgeEventEnvelope);
}

/**
 * 订阅数据面路由（refcount）：首个订阅者启动 transport.onMessage 订阅，
 * 归零退订（防常驻监听泄漏）；返回退订函数。
 */
export function ensureDataPlaneRouter(): () => void {
  _refCount++;
  if (_refCount === 1) {
    _unsubMessage = getTransport().onMessage(handleDataPlaneMessage);
  }
  return () => {
    _refCount = Math.max(0, _refCount - 1);
    if (_refCount === 0) {
      _unsubMessage?.();
      _unsubMessage = null;
    }
  };
}

/** 测试用：强制复位单例（退订 + 归零计数，防跨用例泄漏） */
export function resetDataPlaneRouterForTests(): void {
  _unsubMessage?.();
  _unsubMessage = null;
  _refCount = 0;
}
