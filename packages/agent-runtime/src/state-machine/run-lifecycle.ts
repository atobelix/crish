/**
 * Run Lifecycle 状态机
 *
 * 管理 Run 从创建到结束的完整生命周期 * 替代 orchestrator/src/state-machine.ts 中的手工转移矩阵 *
 * States:
 *   queued -> initializing -> running -> awaiting-approval -> cancelling -> cancelled -> completing -> completed -> failed
 *
 * 关键约束： * - 终态（cancelled / completed / failed）无出边
 * - awaiting-approval 可回到 running（审批通过）或进入 cancelling
 * - completing 是一个中间态，表示 agent 已停止但还需要执行收尾工作 */

import {
  ConexStateMachine,
  StateMachineBuilder,
  type StateMachineDefinition,
  type StateMachineSnapshot,
  transitionTo,
  transitionWithPatch,
} from "./core";

// ─── 状态与事件类型 ───────────────────────────────────────

export type RunLifecycleState =
  | "queued"
  | "initializing"
  | "running"
  | "awaiting-approval"
  | "cancelling"
  | "cancelled"
  | "completing"
  | "completed"
  | "failed";

export type RunLifecycleEvent =
  | "START"
  | "RUNTIME_READY"
  | "INIT_ERROR"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_RESOLVED"
  | "CANCEL_REQUESTED"
  | "CANCEL_CONFIRMED"
  | "AGENT_STOP"
  | "MAX_TURNS_REACHED"
  | "GOAL_COMPLETE"
  | "RUNTIME_ERROR"
  | "FINALIZED"
  | "FINALIZE_ERROR"
  | "FORCE_INTERRUPT";

// ─── 上下文───────────────────────────────────────────────

export interface RunLifecycleContext {
  sessionId: string;
  startedAt?: string;
  finishedAt?: string;
  endReason?: RunEndReason;
  endError?: string;
  approvalCount: number;
  turnCount: number;
  cancelReason?: string;
}

export type RunEndReason =
  | "stop"
  | "max-turns"
  | "aborted"
  | "error"
  | "goal-completed"
  | "goal-blocked"
  | "goal-max-rounds";

// ─── 定义 ─────────────────────────────────────────────────

export const RUN_LIFECYCLE_DEFINITION: StateMachineDefinition<
  RunLifecycleState,
  RunLifecycleEvent,
  RunLifecycleContext
> = new StateMachineBuilder<RunLifecycleState, RunLifecycleEvent, RunLifecycleContext>()
  .type("run-lifecycle")
  .initial("queued")
  .context(() => ({
    sessionId: "",
    approvalCount: 0,
    turnCount: 0
  }))
  .state("queued", {
    transitions: [
      ["START", transitionTo("initializing", {
        effect: () => [{ kind: "patch-context" as const, patch: { startedAt: new Date().toISOString() } }]
      })],
      ["FORCE_INTERRUPT", transitionWithPatch("failed", { endReason: "error", finishedAt: new Date().toISOString() })]
    ]
  })
  .state("initializing", {
    transitions: [
      ["RUNTIME_READY", transitionTo("running")],
      ["INIT_ERROR", transitionWithPatch("failed", { endReason: "error", finishedAt: new Date().toISOString() })],
      ["CANCEL_REQUESTED", transitionTo("cancelling")],
      ["FORCE_INTERRUPT", transitionWithPatch("failed", { endReason: "error", finishedAt: new Date().toISOString() })]
    ]
  })
  .state("running", {
    onExit: (ctx, event) => {
      if (event === "APPROVAL_REQUESTED") {
        return [{ kind: "patch-context" as const, patch: { approvalCount: ctx.approvalCount + 1 } }];
      }
      return [];
    },
    transitions: [
      ["APPROVAL_REQUESTED", transitionTo("awaiting-approval")],
      ["AGENT_STOP", transitionWithPatch("completing", { endReason: "stop" })],
      ["MAX_TURNS_REACHED", transitionWithPatch("completing", { endReason: "max-turns" })],
      ["GOAL_COMPLETE", transitionWithPatch("completing", { endReason: "goal-completed" })],
      ["CANCEL_REQUESTED", transitionTo("cancelling")],
      ["RUNTIME_ERROR", transitionWithPatch("failed", { endReason: "error", finishedAt: new Date().toISOString() })],
      ["FORCE_INTERRUPT", transitionWithPatch("failed", { endReason: "error", finishedAt: new Date().toISOString() })]
    ]
  })
  .state("awaiting-approval", {
    transitions: [
      ["APPROVAL_RESOLVED", transitionTo("running")],
      ["CANCEL_REQUESTED", transitionTo("cancelling")],
      ["RUNTIME_ERROR", transitionWithPatch("failed", { endReason: "error", finishedAt: new Date().toISOString() })],
      ["FORCE_INTERRUPT", transitionWithPatch("failed", { endReason: "error", finishedAt: new Date().toISOString() })]
    ]
  })
  .state("cancelling", {
    transitions: [
      ["CANCEL_CONFIRMED", transitionWithPatch("cancelled", { endReason: "aborted", finishedAt: new Date().toISOString() })],
      ["RUNTIME_ERROR", transitionWithPatch("failed", { endReason: "error", finishedAt: new Date().toISOString() })],
      ["FORCE_INTERRUPT", transitionWithPatch("cancelled", { endReason: "aborted", finishedAt: new Date().toISOString() })]
    ]
  })
  .state("cancelled", {
    transitions: []
  })
  .state("completing", {
    transitions: [
      ["FINALIZED", transitionWithPatch("completed", { finishedAt: new Date().toISOString() })],
      ["FINALIZE_ERROR", transitionWithPatch("failed", { endReason: "error", finishedAt: new Date().toISOString() })],
      ["FORCE_INTERRUPT", transitionWithPatch("failed", { endReason: "error", finishedAt: new Date().toISOString() })]
    ]
  })
  .state("completed", {
    transitions: []
  })
  .state("failed", {
    transitions: []
  })
  .build();

// ─── 工厂函数 ─────────────────────────────────────────────

export function createRunLifecycleMachine(
  runId: string,
  sessionId: string,
  options?: { snapshot?: StateMachineSnapshot<RunLifecycleState, RunLifecycleContext> }
): ConexStateMachine<RunLifecycleState, RunLifecycleEvent, RunLifecycleContext> {
  return new ConexStateMachine(
    RUN_LIFECYCLE_DEFINITION,
    runId,
    {
      initialContext: { sessionId, approvalCount: 0, turnCount: 0 },
      ...(options?.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
    }
  );
}

// ─── 辅助函数 ─────────────────────────────────────────────

const TERMINAL_STATES = new Set<RunLifecycleState>(["cancelled", "completed", "failed"]);

export function isTerminalRunLifecycleState(state: RunLifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * 将状态机的 endReason 映射为 Orchestrator 层的 RunOutcomeReason
 */
export function mapEndReasonToOutcomeReason(
  endReason: RunEndReason | undefined,
  state: RunLifecycleState
): string {
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return endReason === "error" ? "runtime-error" : "agent-error";
  if (state === "completed") {
    switch (endReason) {
      case "stop": return "completed";
      case "max-turns": return "max-turns";
      case "goal-completed": return "goal-completed";
      case "goal-blocked": return "goal-blocked";
      case "goal-max-rounds": return "goal-max-rounds";
      default: return "completed";
    }
  }
  return "completed";
}
