/**
 * Desktop Run 控制客户端（B1）
 *
 * 产品语义（shared-types / docs/architecture/run-control.md）：
 * - L1 soft_inject：运行中再发消息 → 入队，不杀 stream
 * - L2 cooperative_stop：默认 Stop，协作收尾
 * - L3 force_cancel：强制取消（二次确认 / Shift+点击 / 长按）
 *
 * ## Wire 策略（C3.1 transport 路径）
 * - Canonical 协议：`run-control`（命令名 core_run_control）。
 * - 过渡双线保留：L2/L3 终止经 {@link sendTerminateDualWire} **成对**发送
 *   core_run_control + core_cancel_run（Rust 侧两条命令均已在 manifest 注册面内）。
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

/** wire level → cancel mode（仅终止类有意义） */
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

/** cancel-run 扩展：mode 供 daemon 区分 soft/hard（旧端忽略） */
export function buildCancelRunWireMessage(
  runId: string,
  mode: StreamCancelMode
): Record<string, unknown> {
  return {
    type: 'cancel-run',
    runId,
    mode,
  };
}

/**
 * Feature flag：L2/L3 是否仍附带 `cancel-run.mode`（过渡双线）。
 * Canonical 仅 `run-control`；关 flag 前须 E0 live Stop 证明 daemon L2 已接。
 * @see architecture-dedup-inventory #4
 */
export const TRANSITIONAL_DUAL_CANCEL_RUN_WIRE = true as const;

type DaemonSendClient = {
  send: (msg: Record<string, unknown>) => unknown;
};

/**
 * WS 消息 type → transport 命令名（03 §3.2；命令名以 commandManifest 为准）：
 * - 'run-control' → core_run_control
 * - 'cancel-run'  → core_cancel_run
 * 未知 type → 空操作（不 invoke）。
 */
function wireTypeToCommand(type: string): string | null {
  if (type === 'run-control') return 'core_run_control';
  if (type === 'cancel-run') return 'core_cancel_run';
  return null;
}

/** 把 WS 形状 wire 消息经 transport.send 发出（剥离 type 后按命令名调用） */
function sendWireViaTransport(
  transport: Transport,
  msg: Record<string, unknown>,
): Promise<void> {
  const type = String(msg.type ?? '');
  const cmd = wireTypeToCommand(type);
  if (!cmd) return Promise.resolve();
  const { type: _type, ...rest } = msg;
  return transport.send(cmd, rest);
}

/**
 * **唯一** L2/L3 双线发送点：始终成对（或 flag 关闭后仅 run-control）。
 * 勿在其它模块再手写 `cancel-run` / 第二套 pairing。
 *
 * 顺序固定：
 * 1. `{ type: 'run-control', level: cooperative_stop|force_cancel, ... }`
 * 2. 若 {@link TRANSITIONAL_DUAL_CANCEL_RUN_WIRE} 且有 runId：
 *    `{ type: 'cancel-run', runId, mode: cooperative|force }`
 *
 * L1 不走此函数（无 cancel-run）。
 */
export async function sendTerminateDualWire(
  client: DaemonSendClient,
  req: RunControlRequest,
  mode: StreamCancelMode
): Promise<boolean> {
  let sent = false;

  try {
    await Promise.resolve(client.send(buildRunControlWireMessage(req)));
    sent = true;
  } catch {
    /* ignore */
  }

  const runId = req.runId || undefined;
  if (TRANSITIONAL_DUAL_CANCEL_RUN_WIRE && runId) {
    try {
      await Promise.resolve(client.send(buildCancelRunWireMessage(runId, mode)));
      sent = true;
    } catch {
      /* ignore */
    }
  }

  return sent;
}

/**
 * 向核心发送控制意图；失败不抛（UI 仍可本地收口）。
 * 返回是否至少成功发出一条命令。
 *
 * L2/L3 经 {@link sendTerminateDualWire}（过渡双线唯一配对点）。
 * L1 仅 `run-control`（永不附 cancel-run）。
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

  let transport: Transport;
  try {
    transport = getTransport();
  } catch {
    // 单元测试 / 非 Tauri 环境无 transport：metrics 仍已记录，发送静默失败
    return false;
  }

  // 终止类：单一 helper 成对双线（metrics 仍只记一次 level）
  const mode = cancelModeForLevel(req.level);
  if (mode) {
    return sendTerminateDualWire(
      { send: (msg) => sendWireViaTransport(transport, msg) },
      req,
      mode
    );
  }

  // L0/L1：仅 run-control
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
