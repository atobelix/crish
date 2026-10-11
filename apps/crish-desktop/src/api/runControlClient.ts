/**
 * Desktop Run 控制客户端（B1）
 *
 * 产品语义（shared-types / docs/architecture/run-control.md）：
 * - L1 soft_inject：运行中再发消息 → 入队，不杀 stream
 * - L2 cooperative_stop：默认 Stop，协作收尾
 * - L3 force_cancel：强制取消（二次确认 / Shift+点击 / 长按）
 *
 * ## Wire 策略（C3.1 transport 路径 · Wave C D-F07 收敛）
 * - Canonical 协议：`run-control`（命令名 core_run_control）**唯一出站命令**。
 * - 过渡双线（`cancel-run` / `core_cancel_run` 成对发送）已物理删除；
 *   L2/L3 终止同样仅发 `run-control`。
 * - 产品路径只走本模块 / `compositionRoot.runControl`；禁止 UI 直发取消命令。
 *
 * 3. 本地 EventBus 镜像 `run:control` 便于观测（不替代核心真相）
 *
 * @see packages/shared-types/src/run-control.ts
 * @see docs/architecture/run-control.md
 * @see docs/plans/progress/architecture-dedup-inventory.md #3/#4
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md §5 / Round B1
 */

import {
  RUN_CONTROL_LEVEL,
  createRunControlIntent,
  type RunControlIntent,
  type RunControlLevel,
} from '@crish/shared-types';
import { getTransport, type Transport } from './transport';
import { eventBus } from '../services/EventBus';
import { recordRunControlLevel } from './controlMetrics';
import { logInternalError } from './userFacingErrors';

/**
 * Stream cancel mode 字面量（**唯一真源**）。
 * - `createStreamCancel` / SessionStreamHandle / useAgentPanel 均 re-export 或 import 本类型
 * - 禁止在 ConnectionLifecycle 等处再定义平行 union
 */
export type StreamCancelMode = 'cooperative' | 'force';

export type RunControlRequest = {
  level: RunControlLevel;
  runId?: string | null;
  sessionId?: string | null;
  reason?: string;
  /** soft_inject 正文等扩展 */
  payload?: RunControlIntent['payload'];
};

/** wire level → cancel mode（仅终止类有意义；流内 cancel 路径用，不触发第二 wire） */
export function cancelModeForLevel(level: RunControlLevel): StreamCancelMode | null {
  if (level === RUN_CONTROL_LEVEL.L2) return 'cooperative';
  if (level === RUN_CONTROL_LEVEL.L3) return 'force';
  return null;
}

/** 构造协议载荷（可测纯函数） */
export function buildRunControlWireMessage(req: RunControlRequest): Record<string, unknown> {
  const intent = createRunControlIntent(req.level, {
    ...(req.runId ? { runId: req.runId } : {}),
    ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    ...(req.reason ? { reason: req.reason } : {}),
    ...(req.payload ? { payload: req.payload } : {}),
  });
  return {
    type: 'run-control',
    level: intent.level,
    ...(intent.runId ? { runId: intent.runId } : {}),
    ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
    ...(intent.reason ? { reason: intent.reason } : {}),
    ...(intent.payload ? { payload: intent.payload } : {}),
  };
}

/** 把 WS 形状 wire 消息经 transport.send 发出（剥离 type 后按命令名调用） */
function sendWireViaTransport(
  transport: Transport,
  msg: Record<string, unknown>,
): Promise<void> {
  const type = String(msg.type ?? '');
  // Wave C（D-F07）：唯一出站命令 = core_run_control；cancel-run 双线已删
  if (type !== 'run-control') return Promise.resolve();
  const { type: _type, ...rest } = msg;
  return transport.send('core_run_control', rest);
}

/**
 * 向核心发送控制意图；失败不抛（UI 仍可本地收口）。
 * 返回是否至少成功发出一条命令。
 *
 * L0–L3 一律仅发 `run-control`（core_run_control 单一命令面）。
 */
export async function dispatchRunControl(req: RunControlRequest): Promise<boolean> {
  const intent = createRunControlIntent(req.level, {
    ...(req.runId ? { runId: req.runId } : {}),
    ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    ...(req.reason ? { reason: req.reason } : {}),
    ...(req.payload ? { payload: req.payload } : {}),
  });

  // D2：内存计数 L1/L2/L3（不依赖 EventBus / 核心）
  recordRunControlLevel(intent.level);

  // 本地可观测镜像（非核心真源）
  try {
    eventBus.emit('run:control', intent, 'runControlClient');
  } catch {
    /* EventBus 类型表未登记时忽略 */
  }

  // G1（FINAL-PLAN P1-d）：L1–L3 后端 core_run_control 的 run_id 为必填参数，
  // 缺 runId 必然被拒——先可观测记录再返回 false，杜绝「伪连通 + 静默 no-op」
  if (intent.level !== RUN_CONTROL_LEVEL.L0 && !intent.runId) {
    logInternalError(
      'run-control-missing-run-id',
      new Error(
        `run-control ${intent.level} 缺少 runId（sessionId=${intent.sessionId ?? '-'}，reason=${intent.reason ?? '-'}）`
      )
    );
    return false;
  }

  let transport: Transport;
  try {
    transport = getTransport();
  } catch {
    // 单元测试 / 非 Tauri 环境无 transport：metrics 仍已记录，发送静默失败
    return false;
  }

  try {
    await sendWireViaTransport(transport, buildRunControlWireMessage(req));
    return true;
  } catch {
    return false;
  }
}

/** 默认 Stop = L2 cooperative_stop */
export function requestCooperativeStop(opts: {
  runId?: string | null;
  sessionId?: string | null;
  reason?: string;
}): Promise<boolean> {
  return dispatchRunControl({
    level: RUN_CONTROL_LEVEL.L2,
    runId: opts.runId,
    sessionId: opts.sessionId,
    reason: opts.reason ?? 'ui-stop',
  });
}

/** Force / 二次确认 = L3 force_cancel */
export function requestForceCancel(opts: {
  runId?: string | null;
  sessionId?: string | null;
  reason?: string;
}): Promise<boolean> {
  return dispatchRunControl({
    level: RUN_CONTROL_LEVEL.L3,
    runId: opts.runId,
    sessionId: opts.sessionId,
    reason: opts.reason ?? 'ui-force-cancel',
  });
}

/**
 * 运行中再发 = L1 follow_up（pi followUp）：仅 idle 后交付，不杀当前 stream。
 * wire 仍为 soft_inject；payload.kind 区分 follow_up vs steer。
 */
export function requestFollowUp(opts: {
  runId?: string | null;
  sessionId?: string | null;
  text?: string;
  reason?: string;
  clientMessageId?: string;
}): Promise<boolean> {
  return dispatchRunControl({
    level: RUN_CONTROL_LEVEL.L1,
    runId: opts.runId,
    sessionId: opts.sessionId,
    reason: opts.reason ?? 'ui-follow-up',
    payload: {
      kind: 'follow_up',
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.clientMessageId !== undefined
        ? { clientMessageId: opts.clientMessageId }
        : {}),
    },
  });
}

/**
 * L1 soft_inject / steer：下一安全点注入（不 abort provider）。
 * 产品「排队等本轮结束」请用 {@link requestFollowUp}。
 */
export function requestSoftInject(opts: {
  runId?: string | null;
  sessionId?: string | null;
  text?: string;
  reason?: string;
  /** 默认 soft_inject；显式 steer 时入 steer 环语义 */
  kind?: 'soft_inject' | 'steer';
}): Promise<boolean> {
  const kind = opts.kind ?? 'soft_inject';
  return dispatchRunControl({
    level: RUN_CONTROL_LEVEL.L1,
    runId: opts.runId,
    sessionId: opts.sessionId,
    reason: opts.reason ?? 'ui-soft-inject',
    payload: {
      kind,
      ...(opts.text !== undefined ? { text: opts.text } : {}),
    },
  });
}
