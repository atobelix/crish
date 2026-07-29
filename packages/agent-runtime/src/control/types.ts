/**
 * Run 控制语义类型（B0）
 *
 * 协议 wire 名 / L0–L3 代号 / 协议载荷：单一真源 `@crish/shared-types`（run-control.ts）。
 * 本文件在其上适配 ControlBus 运行时意图（id / kind / message / source），避免双定义漂移。
 *
 * 命名约定：
 * - shared `RunControlLevel` = wire 名（continue | soft_inject | …）
 * - shared `RunControlLevelCode` = L0 | L1 | L2 | L3
 * - runtime `RunControlLevel` = L0–L3 代号（ControlBus.intent.level，兼容既有测试）
 * - runtime `RunControlKind` = wire 名 + `steer` / `follow_up`（L1 变体，分环）
 *
 * @see docs/architecture/run-control.md
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md §5
 */

import type { AgentMessage, JsonObject } from '@crish/shared-types';
import {
  RUN_CONTROL_LEVEL,
  RUN_CONTROL_LEVELS,
  createRunControlIntent as createProtocolRunControlIntent,
  isForceCancelRunControl,
  isRunControlLevel as isRunControlWireLevel,
  isTerminatingRunControl,
  runControlLevelCode,
  type RunControlIntent as ProtocolRunControlIntent,
  type RunControlLevel as RunControlWireLevel,
  type RunControlLevelCode,
} from '@crish/shared-types';

// ─── shared-types 协议面 re-export ──────────────────────────

export type {
  /** 协议 wire 控制级别 */
  RunControlWireLevel,
  /** L0–L3 代号 */
  RunControlLevelCode,
  /** 协议侧控制意图（event log / 跨进程） */
  ProtocolRunControlIntent,
};

export {
  RUN_CONTROL_LEVEL,
  RUN_CONTROL_LEVELS,
  isRunControlWireLevel,
  runControlLevelCode,
  isTerminatingRunControl,
  isForceCancelRunControl,
  createProtocolRunControlIntent,
};

// ─── ControlBus 运行时形态（保持既有 API） ──────────────────

/**
 * ControlBus / UI 内部用的 L0–L3 代号。
 * 等于 shared `RunControlLevelCode`，与 wire 名通过 RUN_CONTROL_LEVEL 互映。
 */
export type RunControlLevel = RunControlLevelCode;

/**
 * 控制意图种类
 * - continue / soft_inject / cooperative_stop / force_cancel：shared wire
 * - steer：runtime L1 变体 → AgentInputQueue.steer（下一安全点；对齐 pi steer）
 * - follow_up：runtime L1 变体 → AgentInputQueue.followUp（仅 run idle；对齐 pi followUp）
 */
export type RunControlKind = RunControlWireLevel | 'steer' | 'follow_up';

/** ControlBus 队列中的单条控制意图（运行时） */
export interface RunControlIntent {
  /** 稳定 id，可观测 / 可测 */
  id: string;
  kind: RunControlKind;
  level: RunControlLevel;
  /** 入队时间（ms epoch） */
  createdAt: number;
  /** soft_inject / steer / follow_up 附带消息 */
  message?: AgentMessage;
  /** 人类可读原因 */
  reason?: string;
  /** 来源（ui / hook / policy / system） */
  source?: string;
}

/** request() 入参：id / createdAt 可由总线补齐 */
export type RunControlIntentInput = Omit<RunControlIntent, 'id' | 'createdAt' | 'level'> & {
  id?: string;
  createdAt?: number;
  /** 省略时按 kind 推导 level */
  level?: RunControlLevel;
};

/** kind → 默认 L0–L3（steer / follow_up → L1；其余走 shared runControlLevelCode） */
export function levelForKind(kind: RunControlKind): RunControlLevel {
  if (kind === 'steer' || kind === 'follow_up') {
    return 'L1';
  }
  return runControlLevelCode(kind);
}

/** kind → 协议 wire 级别；steer / follow_up 折叠为 soft_inject */
export function wireLevelForKind(kind: RunControlKind): RunControlWireLevel {
  if (kind === 'steer' || kind === 'follow_up') {
    return RUN_CONTROL_LEVEL.L1;
  }
  return kind;
}

/** L1 注入类 kind（写入 input queue 的某一环） */
export function isL1InjectKind(kind: RunControlKind): boolean {
  return kind === 'soft_inject' || kind === 'steer' || kind === 'follow_up';
}

/** follow_up → followUp 环；soft_inject / steer → steer 环 */
export function injectRingForKind(kind: RunControlKind): 'steer' | 'followUp' | null {
  if (kind === 'follow_up') return 'followUp';
  if (kind === 'soft_inject' || kind === 'steer') return 'steer';
  return null;
}

/**
 * 将 ControlBus 运行时意图投影为协议侧 RunControlIntent（可写 event log / 跨进程）。
 * message 放入 payload.message 摘要位（完整 AgentMessage 仍由 runtime 持有）。
 */
export function toProtocolRunControlIntent(
  intent: RunControlIntent,
  fields?: { runId?: string; sessionId?: string; payload?: JsonObject },
): ProtocolRunControlIntent {
  const level = wireLevelForKind(intent.kind);
  const payload: JsonObject = {
    ...(fields?.payload ?? {}),
    kind: intent.kind,
    intentId: intent.id,
    levelCode: intent.level,
    ...(intent.source !== undefined ? { source: intent.source } : {}),
  };
  return createProtocolRunControlIntent(level, {
    ...(intent.reason !== undefined ? { reason: intent.reason } : {}),
    ...(fields?.runId !== undefined ? { runId: fields.runId } : {}),
    ...(fields?.sessionId !== undefined ? { sessionId: fields.sessionId } : {}),
    payload,
  });
}
