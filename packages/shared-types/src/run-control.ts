/**
 * Run 控制契约（中控 A1）
 *
 * 四级控制（L0–L3），名称固定，便于协议与 UI：
 * - L0 continue：继续下一 turn
 * - L1 soft_inject：安全点注入，不杀当前 stream
 * - L2 cooperative_stop：协作停，当前 turn 干净收尾
 * - L3 force_cancel：硬停，abort provider + tools
 *
 * 默认用户 Stop = L2；Force / 二次确认 = L3。
 *
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md §5.2
 */

import type { JsonObject } from './primitive-types';
import {
  PERMISSION_MODE_VALUES,
  type PermissionMode,
} from './generated/device/types';

export { PERMISSION_MODE_VALUES };
export type { PermissionMode };

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === 'string' &&
    (PERMISSION_MODE_VALUES as readonly string[]).includes(value)
  );
}

/** Run 控制级别（协议 wire 名） */
export type RunControlLevel =
  'continue' | 'soft_inject' | 'cooperative_stop' | 'force_cancel';

export const RUN_CONTROL_LEVELS = [
  'continue',
  'soft_inject',
  'cooperative_stop',
  'force_cancel',
] as const satisfies readonly RunControlLevel[];

/**
 * L0–L3 与 wire 名的固定映射。
 * 产品语义表：§5.2；改默认 Stop 级别只改映射表消费者，不改本常量字面量。
 */
export const RUN_CONTROL_LEVEL = {
  /** L0 — 继续 */
  L0: 'continue',
  /** L1 — 软注入 */
  L1: 'soft_inject',
  /** L2 — 协作停 */
  L2: 'cooperative_stop',
  /** L3 — 强制取消 */
  L3: 'force_cancel',
} as const satisfies Record<'L0' | 'L1' | 'L2' | 'L3', RunControlLevel>;

export type RunControlLevelCode = keyof typeof RUN_CONTROL_LEVEL;

/** 控制意图一等事件载荷（写入 event log，可观测、可测） */
export interface RunControlIntent {
  level: RunControlLevel;
  reason?: string;
  runId?: string;
  sessionId?: string;
  /** 级别相关扩展：如 soft_inject 的消息正文、steer 提示等 */
  payload?: JsonObject;
}

export function isRunControlLevel(value: unknown): value is RunControlLevel {
  return (
    typeof value === 'string' &&
    (RUN_CONTROL_LEVELS as readonly string[]).includes(value)
  );
}

/** wire level → L0–L3 代号；未知返回 null */
export function runControlLevelCode(
  level: RunControlLevel
): RunControlLevelCode {
  switch (level) {
    case 'continue':
      return 'L0';
    case 'soft_inject':
      return 'L1';
    case 'cooperative_stop':
      return 'L2';
    case 'force_cancel':
      return 'L3';
  }
}

/** 是否为会终止 run 的控制（L2/L3） */
export function isTerminatingRunControl(level: RunControlLevel): boolean {
  return level === 'cooperative_stop' || level === 'force_cancel';
}

/** 是否为硬中断（仅 L3 应 abort provider） */
export function isForceCancelRunControl(level: RunControlLevel): boolean {
  return level === 'force_cancel';
}

/** 构造控制意图的便捷工厂 */
export function createRunControlIntent(
  level: RunControlLevel,
  fields?: Omit<RunControlIntent, 'level'>
): RunControlIntent {
  return {
    level,
    ...fields,
  };
}
