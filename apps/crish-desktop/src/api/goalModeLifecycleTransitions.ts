/**
 * 目标模式 lifecycle 状态机 — 状态转移逻辑（transitionGoalLifecycle / applyGoalUpdate）。
 *
 * 本模块从 goalModeController.ts 拆出，仅含 lifecycle 转移函数与便利包装；
 * 类型/工厂/桥接见 goalModeLifecycleTypes.ts；
 * 续写/提示/checklist 域纯函数见 goalModeContinuation.ts。
 */

import type { SessionGoalTask } from '../store/types';
import { GOAL_DEFAULT_MAX_ITERATIONS } from './goalModeContinuation';
import type {
  GoalLifecycleEvent,
  GoalLifecycleState,
  GoalTransitionOutcome,
  GoalTransitionResult,
  GoalUpdatePayload,
} from './goalModeLifecycleTypes';
import {
  appendGoalProgressMessage,
  createActiveGoalLifecycle,
  createIdleGoalLifecycle,
  validateGoalUpdateExclusivity,
} from './goalModeLifecycleTypes';

function isRunningPhase(phase: GoalLifecycleState['phase']): boolean {
  return phase === 'active' || phase === 'paused' || phase === 'blocked';
}

function canEnterFrom(phase: GoalLifecycleState['phase']): boolean {
  return phase === 'idle' || phase === 'completed';
}

/**
 * Pure lifecycle transition: enter / exit / pause / resume / progress / complete / update.
 *
 * Guards (illegal):
 * - enter with empty goal
 * - enter while active|paused|blocked (must exit first)
 * - pause / resume / progress / complete from idle or completed (where inapplicable)
 * - update with both completed:true and non-empty blocked_reason
 *
 * Noops:
 * - exit from idle / completed
 * - pause when already paused
 * - resume when already active
 * - complete when already completed
 * - empty progress / empty update
 */
export function transitionGoalLifecycle(
  state: GoalLifecycleState,
  event: GoalLifecycleEvent
): GoalTransitionResult {
  const finish = (
    outcome: GoalTransitionOutcome,
    reason: string | null,
    next: GoalLifecycleState
  ): GoalTransitionResult => ({
    outcome,
    reason,
    event: event.type,
    changed: outcome === 'applied',
    state: next,
  });

  switch (event.type) {
    case 'enter': {
      const g = (event.goal || '').trim();
      if (!g) return finish('illegal', 'empty_goal', state);
      if (!canEnterFrom(state.phase)) {
        return finish('illegal', 'already_running', state);
      }
      const max =
        event.maxIterations && event.maxIterations > 0
          ? event.maxIterations
          : GOAL_DEFAULT_MAX_ITERATIONS;
      return finish('applied', 'entered', createActiveGoalLifecycle(g, max));
    }

    case 'exit': {
      if (state.phase === 'idle') return finish('noop', 'already_idle', state);
      if (state.phase === 'completed') {
        // Terminal success already exited auto-loop; clear to idle for re-enter
        return finish(
          'applied',
          'cleared_completed',
          createIdleGoalLifecycle()
        );
      }
      return finish('applied', 'exited', createIdleGoalLifecycle());
    }

    case 'pause': {
      if (state.phase === 'idle')
        return finish('illegal', 'not_running', state);
      if (state.phase === 'completed')
        return finish('illegal', 'already_completed', state);
      if (state.phase === 'paused')
        return finish('noop', 'already_paused', state);
      if (state.phase === 'blocked') {
        // Soft pause from blocked keeps blockedReason but moves to paused? No —
        // stay blocked (stronger terminal-stuck); treat as noop.
        return finish('noop', 'already_blocked', state);
      }
      // active → paused; clear blocked/completed exclusivity side
      let next: GoalLifecycleState = {
        ...state,
        phase: 'paused',
        blockedReason: null,
        completed: false,
      };
      const reasonMsg = (event.reason || '').trim();
      if (reasonMsg) next = appendGoalProgressMessage(next, reasonMsg);
      return finish('applied', 'paused', next);
    }

    case 'resume': {
      if (state.phase === 'idle')
        return finish('illegal', 'not_running', state);
      if (state.phase === 'completed')
        return finish('illegal', 'already_completed', state);
      if (state.phase === 'active')
        return finish('noop', 'already_active', state);
      // paused | blocked → active; clear blocked on resume
      return finish('applied', 'resumed', {
        ...state,
        phase: 'active',
        blockedReason: null,
        completed: false,
      });
    }

    case 'progress': {
      if (!isRunningPhase(state.phase)) {
        return finish(
          'illegal',
          state.phase === 'completed' ? 'already_completed' : 'not_running',
          state
        );
      }
      const msg = (event.message || '').trim();
      if (!msg) return finish('noop', 'empty_message', state);
      return finish(
        'applied',
        'progress_logged',
        appendGoalProgressMessage(state, msg)
      );
    }

    case 'complete': {
      if (state.phase === 'idle')
        return finish('illegal', 'not_running', state);
      if (state.phase === 'completed')
        return finish('noop', 'already_completed', state);
      let next: GoalLifecycleState = {
        ...state,
        phase: 'completed',
        completed: true,
        blockedReason: null, // exclusivity: success clears blocked
        tasks: (state.tasks || []).map((t) =>
          t.done ? t : { ...t, done: true }
        ),
      };
      const msg = (event.message || '').trim() || '目标已完成';
      next = appendGoalProgressMessage(next, msg);
      return finish('applied', 'completed', next);
    }

    case 'update': {
      return applyGoalUpdate(state, {
        ...(event.completed !== undefined && { completed: event.completed }),
        ...(event.message !== undefined && { message: event.message }),
        ...(event.blocked_reason !== undefined && { blocked_reason: event.blocked_reason }),
      });
    }

    default: {
      // Exhaustiveness — should be unreachable
      const _never: never = event;
      void _never;
      return finish('illegal', 'unknown_event', state);
    }
  }
}

/**
 * Apply update_goal-shaped payload with exclusivity + phase guards.
 * - completed:true → complete (clears blockedReason)
 * - blocked_reason → block/pause as blocked (clears completed)
 * - message only → progress log while running
 * - both completed + blocked_reason → illegal (no state change)
 */
export function applyGoalUpdate(
  state: GoalLifecycleState,
  update: GoalUpdatePayload
): GoalTransitionResult {
  const finish = (
    outcome: GoalTransitionOutcome,
    reason: string | null,
    next: GoalLifecycleState
  ): GoalTransitionResult => ({
    outcome,
    reason,
    event: 'update',
    changed: outcome === 'applied',
    state: next,
  });

  const exclusivity = validateGoalUpdateExclusivity(update);
  if (exclusivity.ok === false) {
    return finish('illegal', exclusivity.reason, state);
  }

  const hasCompleted = update.completed === true;
  const blocked = (update.blocked_reason || '').trim();
  const message = (update.message || '').trim();
  const hasBlocked = Boolean(blocked);
  const hasMessage = Boolean(message);

  if (!hasCompleted && !hasBlocked && !hasMessage) {
    return finish('noop', 'empty_update', state);
  }

  // Terminal success
  if (hasCompleted) {
    if (state.phase === 'idle') return finish('illegal', 'not_running', state);
    if (state.phase === 'completed') {
      // Idempotent complete; optional message still logs
      if (!hasMessage) return finish('noop', 'already_completed', state);
      return finish(
        'applied',
        'progress_on_completed',
        appendGoalProgressMessage(state, message)
      );
    }
    let next: GoalLifecycleState = {
      ...state,
      phase: 'completed',
      completed: true,
      blockedReason: null,
      tasks: (state.tasks || []).map((t: SessionGoalTask) =>
        t.done ? t : { ...t, done: true }
      ),
    };
    next = appendGoalProgressMessage(next, message || '目标已完成');
    return finish('applied', 'completed', next);
  }

  // Failure / stuck — exclusive path (no completed)
  if (hasBlocked) {
    if (state.phase === 'idle') return finish('illegal', 'not_running', state);
    if (state.phase === 'completed')
      return finish('illegal', 'already_completed', state);
    let next: GoalLifecycleState = {
      ...state,
      phase: 'blocked',
      completed: false,
      blockedReason: blocked,
    };
    // Progress note (optional) then blocked audit line — never treat blocked as success
    if (hasMessage) next = appendGoalProgressMessage(next, message);
    next = appendGoalProgressMessage(next, `受阻：${blocked}`);
    return finish('applied', 'blocked', next);
  }

  // Progress-only message
  if (!isRunningPhase(state.phase)) {
    return finish(
      'illegal',
      state.phase === 'completed' ? 'already_completed' : 'not_running',
      state
    );
  }
  return finish(
    'applied',
    'progress_logged',
    appendGoalProgressMessage(state, message)
  );
}

/** Convenience: enter */
export function enterGoalMode(
  state: GoalLifecycleState,
  goal: string,
  maxIterations?: number
): GoalTransitionResult {
  return transitionGoalLifecycle(state, {
    type: 'enter',
    goal,
    ...(maxIterations !== undefined && { maxIterations }),
  });
}

/** Convenience: exit / clear */
export function exitGoalMode(state: GoalLifecycleState): GoalTransitionResult {
  return transitionGoalLifecycle(state, { type: 'exit' });
}

/** Convenience: pause (soft; not blocked) */
export function pauseGoalMode(
  state: GoalLifecycleState,
  reason?: string
): GoalTransitionResult {
  return transitionGoalLifecycle(state, {
    type: 'pause',
    ...(reason !== undefined && { reason }),
  });
}

/** Convenience: resume from paused/blocked */
export function resumeGoalMode(
  state: GoalLifecycleState
): GoalTransitionResult {
  return transitionGoalLifecycle(state, { type: 'resume' });
}
