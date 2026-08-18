/**
 * 目标模式 lifecycle 状态机 — 类型、工厂与桥接函数。
 *
 * 本模块从 goalModeController.ts 拆出，仅含 lifecycle 形状定义与无副作用工厂/桥接；
 * 状态转移逻辑见 goalModeLifecycleTransitions.ts。
 * 续写/提示/checklist 域纯函数见 goalModeContinuation.ts。
 */

import type {
  SessionGoalMode,
  SessionGoalTask,
} from '../store/types';
import {
  GOAL_DEFAULT_MAX_ITERATIONS,
  computeGoalTaskProgress,
} from './goalModeContinuation';

// ---------------------------------------------------------------------------
// Goal lifecycle pure helpers (enter / exit / pause / progress / exclusivity)
// Controller-local state — does not extend SessionGoalMode (store types frozen).
// ---------------------------------------------------------------------------

/** Lifecycle phase for goal mode orchestration */
export type GoalLifecyclePhase =
  | 'idle'
  | 'active'
  | 'paused'
  | 'blocked'
  | 'completed';

/**
 * Controller-local lifecycle snapshot.
 * Maps to SessionGoalMode via {@link goalLifecycleToSessionMode}.
 */
export type GoalLifecycleState = {
  phase: GoalLifecyclePhase;
  goal: string;
  iteration: number;
  maxIterations: number;
  tasks: SessionGoalTask[];
  /** Chronological progress messages (newest last); capped */
  progressMessages: string[];
  /** Latest progress / terminal message for ribbon / UI */
  lastMessage: string | null;
  /**
   * Failure / stuck signal. Exclusive with `completed === true`.
   * Present only when phase === 'blocked'.
   */
  blockedReason: string | null;
  /** Success terminal. Exclusive with non-null blockedReason. */
  completed: boolean;
};

/** Events for the pure lifecycle transition function */
export type GoalLifecycleEvent =
  | { type: 'enter'; goal: string; maxIterations?: number }
  | { type: 'exit' }
  | { type: 'pause'; reason?: string }
  | { type: 'resume' }
  | { type: 'progress'; message: string }
  | { type: 'complete'; message?: string }
  | {
      type: 'update';
      /** Success terminal — exclusive with blocked_reason */
      completed?: boolean;
      /** Progress note (also allowed on complete) */
      message?: string;
      /** Failure / stuck — exclusive with completed:true; pauses as blocked */
      blocked_reason?: string;
    };

export type GoalTransitionOutcome = 'applied' | 'noop' | 'illegal';

export type GoalTransitionResult = {
  outcome: GoalTransitionOutcome;
  /** Machine-readable reason code */
  reason: string | null;
  event: GoalLifecycleEvent['type'];
  changed: boolean;
  state: GoalLifecycleState;
};

/** Structured update payload (update_goal tool shape) */
export type GoalUpdatePayload = {
  completed?: boolean;
  message?: string;
  blocked_reason?: string;
};

const PROGRESS_MESSAGE_CAP = 32;

export function createIdleGoalLifecycle(): GoalLifecycleState {
  return {
    phase: 'idle',
    goal: '',
    iteration: 0,
    maxIterations: GOAL_DEFAULT_MAX_ITERATIONS,
    tasks: [],
    progressMessages: [],
    lastMessage: null,
    blockedReason: null,
    completed: false,
  };
}

/** Fresh active lifecycle from a goal string (enter path) */
export function createActiveGoalLifecycle(
  goal: string,
  maxIterations = GOAL_DEFAULT_MAX_ITERATIONS
): GoalLifecycleState {
  const g = goal.trim();
  return {
    phase: 'active',
    goal: g,
    iteration: 0,
    maxIterations:
      maxIterations > 0 ? maxIterations : GOAL_DEFAULT_MAX_ITERATIONS,
    tasks: g ? [{ id: 'goal-root', text: g, done: false }] : [],
    progressMessages: [],
    lastMessage: null,
    blockedReason: null,
    completed: false,
  };
}

/**
 * blocked_reason vs completed exclusivity.
 * Both set (completed:true AND non-empty blocked_reason) is illegal.
 * Empty/whitespace blocked_reason is treated as absent.
 */
export function validateGoalUpdateExclusivity(
  update: GoalUpdatePayload
): { ok: true } | { ok: false; reason: 'completed_and_blocked' } {
  const blocked = (update.blocked_reason || '').trim();
  if (update.completed === true && blocked) {
    return { ok: false, reason: 'completed_and_blocked' };
  }
  return { ok: true };
}

/** Append a progress message (trim, skip empty, cap length) */
export function appendGoalProgressMessage(
  state: GoalLifecycleState,
  message: string | undefined | null
): GoalLifecycleState {
  const msg = (message || '').trim();
  if (!msg) return state;
  const next = [...state.progressMessages, msg];
  while (next.length > PROGRESS_MESSAGE_CAP) next.shift();
  return { ...state, progressMessages: next, lastMessage: msg };
}

/**
 * Human-readable progress line for ribbon / TasksCard / logs.
 * Prefer explicit message; otherwise synthesize from phase + task progress.
 */
export function formatGoalProgressMessage(input: {
  phase: GoalLifecyclePhase;
  goal: string;
  iteration: number;
  maxIterations: number;
  tasks?: SessionGoalTask[] | null;
  message?: string | null;
  blockedReason?: string | null;
}): string {
  const explicit = (input.message || '').trim();
  if (explicit) return explicit;

  const { total, done, pct } = computeGoalTaskProgress(input.tasks);
  const goalLabel = (input.goal || '').trim() || '目标';
  const round = `第 ${Math.max(0, input.iteration) + 1}/${Math.max(1, input.maxIterations)} 轮`;
  const taskPart =
    total > 0 ? `任务 ${done}/${total}（${pct}%）` : '暂无任务清单';

  switch (input.phase) {
    case 'idle':
      return '目标模式未启动';
    case 'active':
      return `推进中 · ${goalLabel} · ${round} · ${taskPart}`;
    case 'paused':
      return `已暂停 · ${goalLabel} · ${taskPart}`;
    case 'blocked': {
      const br = (input.blockedReason || '').trim();
      return br
        ? `受阻 · ${goalLabel} · ${br}`
        : `受阻 · ${goalLabel} · ${taskPart}`;
    }
    case 'completed':
      return `已完成 · ${goalLabel}${total > 0 ? ` · 任务 ${done}/${total}` : ''}`;
    default:
      return goalLabel;
  }
}

/** Bridge lifecycle → session store shape (null when idle) */
export function goalLifecycleToSessionMode(
  state: GoalLifecycleState
): SessionGoalMode | null {
  if (state.phase === 'idle') return null;
  return {
    active: state.phase === 'active',
    goal: state.goal,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    tasks: state.tasks,
  };
}

/** Bridge session store shape → lifecycle (unknown → idle) */
export function sessionModeToGoalLifecycle(
  gm: SessionGoalMode | null | undefined
): GoalLifecycleState {
  if (!gm) return createIdleGoalLifecycle();
  const maxIterations = gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
  if (gm.active) {
    return {
      phase: 'active',
      goal: gm.goal || '',
      iteration: gm.iteration ?? 0,
      maxIterations,
      tasks: Array.isArray(gm.tasks) ? gm.tasks : [],
      progressMessages: [],
      lastMessage: null,
      blockedReason: null,
      completed: false,
    };
  }
  // inactive but present: treat as completed if all tasks done, else paused
  const tasks = Array.isArray(gm.tasks) ? gm.tasks : [];
  const allDone = tasks.length > 0 && tasks.every((t) => t.done);
  if (allDone) {
    return {
      phase: 'completed',
      goal: gm.goal || '',
      iteration: gm.iteration ?? 0,
      maxIterations,
      tasks,
      progressMessages: [],
      lastMessage: null,
      blockedReason: null,
      completed: true,
    };
  }
  return {
    phase: 'paused',
    goal: gm.goal || '',
    iteration: gm.iteration ?? 0,
    maxIterations,
    tasks,
    progressMessages: [],
    lastMessage: null,
    blockedReason: null,
    completed: false,
  };
}
