/**
 * Session Branch 状态机
 *
 * 管理会话分支的切换与恢复。
 * 替代 session.ts 中 findSessionLeafId 的推断式分支管理。
 *
 * States:
 *   active → suspended → abandoned → restored
 */

import {
  ConexStateMachine,
  StateMachineBuilder,
  type StateMachineDefinition,
  type StateMachineSnapshot,
  transitionTo,
  transitionWith,
} from "./core";

// ─── 状态与事件类型 ───────────────────────────────────────

export type SessionBranchState =
  | "active"
  | "suspended"
  | "abandoned"
  | "restored";

export type SessionBranchEvent =
  | "BRANCH_SWITCH"
  | "BRANCH_RESTORE"
  | "BRANCH_ABANDON"
  | "BRANCH_VALIDATE";

// ─── 上下文 ───────────────────────────────────────────────

export interface SessionBranchContext {
  sessionId: string;
  activeBranchId: string;
  activeLeafId: string;
  branchStack: string[];
  switchedAt?: string;
  restoredAt?: string;
}

// ─── 辅助函数 ─────────────────────────────────────────────

function switchToBranch(ctx: SessionBranchContext, payload: unknown): SessionBranchContext {
  const data = payload as { targetBranchId: string; targetLeafId: string };
  return {
    ...ctx,
    branchStack: [...ctx.branchStack, ctx.activeBranchId],
    activeBranchId: data.targetBranchId,
    activeLeafId: data.targetLeafId,
    switchedAt: new Date().toISOString()
  };
}

function restoreBranch(ctx: SessionBranchContext, payload: unknown): SessionBranchContext {
  const data = payload as { targetBranchId?: string; targetLeafId?: string } | undefined;
  const previousBranch = ctx.branchStack.length > 0 ? ctx.branchStack[ctx.branchStack.length - 1] : ctx.activeBranchId;
  return {
    ...ctx,
    activeBranchId: data?.targetBranchId ?? previousBranch,
    activeLeafId: data?.targetLeafId ?? ctx.activeLeafId,
    branchStack: ctx.branchStack.slice(0, -1),
    restoredAt: new Date().toISOString()
  };
}

function abandonBranch(ctx: SessionBranchContext): SessionBranchContext {
  return {
    ...ctx,
    switchedAt: new Date().toISOString()
  };
}

function restoreFromAbandoned(ctx: SessionBranchContext, payload: unknown): SessionBranchContext {
  const data = payload as { targetBranchId: string; targetLeafId: string };
  return {
    ...ctx,
    activeBranchId: data.targetBranchId,
    activeLeafId: data.targetLeafId,
    restoredAt: new Date().toISOString()
  };
}

// ─── 定义 ─────────────────────────────────────────────────

export const SESSION_BRANCH_DEFINITION: StateMachineDefinition<
  SessionBranchState,
  SessionBranchEvent,
  SessionBranchContext
> = new StateMachineBuilder<SessionBranchState, SessionBranchEvent, SessionBranchContext>()
  .type("session-branch")
  .initial("active")
  .context(() => ({
    sessionId: "",
    activeBranchId: "main",
    activeLeafId: "",
    branchStack: []
  }))
  .state("active", {
    transitions: [
      ["BRANCH_SWITCH", transitionTo("suspended", {
        effect: (ctx, payload) => [{ kind: "update-context" as const, updater: () => switchToBranch(ctx, payload) }]
      })]
    ]
  })
  .state("suspended", {
    transitions: [
      ["BRANCH_RESTORE", transitionTo("active", {
        effect: (ctx, payload) => [{ kind: "update-context" as const, updater: () => restoreBranch(ctx, payload) }]
      })],
      ["BRANCH_ABANDON", transitionWith("abandoned", (ctx) => abandonBranch(ctx))]
    ]
  })
  .state("abandoned", {
    transitions: [
      ["BRANCH_RESTORE", transitionTo("restored", {
        effect: (ctx, payload) => [{ kind: "update-context" as const, updater: () => restoreFromAbandoned(ctx, payload) }]
      })]
    ]
  })
  .state("restored", {
    transitions: [
      ["BRANCH_SWITCH", transitionTo("suspended", {
        effect: (ctx, payload) => [{ kind: "update-context" as const, updater: () => switchToBranch(ctx, payload) }]
      })]
    ]
  })
  .build();

// ─── 工厂函数 ─────────────────────────────────────────────

export function createSessionBranchMachine(
  sessionId: string,
  initialBranchId: string = "main",
  initialLeafId: string = "",
  options?: { snapshot?: StateMachineSnapshot<SessionBranchState, SessionBranchContext> }
): ConexStateMachine<SessionBranchState, SessionBranchEvent, SessionBranchContext> {
  return new ConexStateMachine(
    SESSION_BRANCH_DEFINITION,
    `session-branch-${sessionId}`,
    {
      initialContext: {
        sessionId,
        activeBranchId: initialBranchId,
        activeLeafId: initialLeafId,
        branchStack: []
      },
      snapshot: options?.snapshot
    }
  );
}
