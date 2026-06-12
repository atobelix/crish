/**
 * Orchestrator Run 状态转移
 *
 * 基于 @crish/agent-runtime 的 ConexStateMachine 基础设施。
 * 保留原有的函数式 API 以保持向后兼容，内部使用状态机定义驱动校验。
 */

import {
  RUN_LIFECYCLE_DEFINITION,
  isTerminalRunLifecycleState,
  type RunLifecycleState,
  type RunLifecycleEvent,
  type RunLifecycleContext,
} from "@crish/agent-runtime";
import type { RunStatus } from "./types";

// ─── 状态映射 ─────────────────────────────────────────────

/**
 * RunLifecycleState 与 Orchestrator RunStatus 之间的映射
 *
 * RunLifecycleState 是更精细的状态（包含 initializing / completing 中间态），
 * Orchestrator 的 RunStatus 是面向外部的简化状态。
 */
const LIFECYCLE_TO_RUN_STATUS: Record<RunLifecycleState, RunStatus> = {
  queued: "queued",
  initializing: "running",
  running: "running",
  "awaiting-approval": "awaiting-approval",
  cancelling: "cancelling",
  cancelled: "cancelled",
  completing: "completed",
  completed: "completed",
  failed: "failed"
};

const RUN_STATUS_TO_LIFECYCLE: Record<RunStatus, RunLifecycleState> = {
  queued: "queued",
  running: "running",
  "awaiting-approval": "awaiting-approval",
  cancelling: "cancelling",
  cancelled: "cancelled",
  completed: "completed",
  failed: "failed"
};

// ─── 从状态机定义构建转移表 ───────────────────────────────

/**
 * 从 RUN_LIFECYCLE_DEFINITION 中提取所有合法转移，
 * 映射为 Orchestrator RunStatus 级别的转移表。
 */
function buildRunStatusTransitionsFromDefinition(): Record<RunStatus, Set<RunStatus>> {
  const transitions: Record<string, Set<RunStatus>> = {};

  for (const [fromState, stateDef] of RUN_LIFECYCLE_DEFINITION.states) {
    const fromStatus = LIFECYCLE_TO_RUN_STATUS[fromState];
    if (!transitions[fromStatus]) {
      transitions[fromStatus] = new Set<RunStatus>();
    }

    for (const [, target] of stateDef.transitions) {
      const toStatus = LIFECYCLE_TO_RUN_STATUS[target.target];
      // 同一 RunStatus 内的转移（如 running → running）不需要记录
      if (toStatus !== fromStatus) {
        transitions[fromStatus].add(toStatus);
      }
    }
  }

  // 确保所有 RunStatus 都有条目
  const allStatuses: RunStatus[] = ["queued", "running", "awaiting-approval", "cancelling", "cancelled", "completed", "failed"];
  for (const status of allStatuses) {
    if (!transitions[status]) {
      transitions[status] = new Set<RunStatus>();
    }
  }

  return transitions as Record<RunStatus, Set<RunStatus>>;
}

const RUN_STATUS_TRANSITIONS = buildRunStatusTransitionsFromDefinition();

const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["cancelled", "completed", "failed"]);

// ─── 公共 API（保持向后兼容）───────────────────────────────

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function assertRunStatusTransition(current: RunStatus, next: RunStatus): void {
  if (current === next) return;
  const allowed = RUN_STATUS_TRANSITIONS[current];
  if (allowed?.has(next)) return;
  throw new Error(`Invalid run status transition: ${current} -> ${next}`);
}

export function transitionRunStatus(current: RunStatus, next: RunStatus): RunStatus {
  assertRunStatusTransition(current, next);
  return next;
}

// ─── 扩展 API ─────────────────────────────────────────────

/**
 * 将 RunLifecycleState 映射为 Orchestrator RunStatus
 */
export function mapLifecycleStateToRunStatus(state: RunLifecycleState): RunStatus {
  return LIFECYCLE_TO_RUN_STATUS[state];
}

/**
 * 将 Orchestrator RunStatus 映射为 RunLifecycleState
 */
export function mapRunStatusToLifecycleState(status: RunStatus): RunLifecycleState {
  return RUN_STATUS_TO_LIFECYCLE[status];
}

/**
 * 获取从指定 RunStatus 可达的所有下一个 RunStatus
 */
export function getAvailableRunStatusTransitions(status: RunStatus): RunStatus[] {
  return [...(RUN_STATUS_TRANSITIONS[status] ?? [])];
}
