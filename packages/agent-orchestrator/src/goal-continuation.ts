import type {
  GoalContinuationDecider,
  GoalContinuationDecision,
  GoalRunOptions,
  OrchestratorGoalRunState
} from "./types";
import { goalContinuationDecisionFromAssessment } from "./task-assessment";
import { nonEmptyString } from "@crish/shared-utils";

export {
  assessGoalRound,
  goalContinuationDecisionFromAssessment,
  goalContinuationDecisionFromEvents,
  goalContinuationDecisionFromJson,
  goalContinuationDecisionFromMessage,
  structuredGoalContinuationDecisionFromEvents
} from "./task-assessment";
export type { AssessGoalRoundInput } from "./task-assessment";

export const DEFAULT_GOAL_MAX_ROUNDS = 12;
export const DEFAULT_GOAL_MAX_STALLED_ROUNDS = 2;

export function createGoalRunState(input: {
  goal?: GoalRunOptions;
  fallbackVisibleGoal: string;
}): OrchestratorGoalRunState {
  return {
    status: "queued",
    visibleGoal: nonEmptyString(input.goal?.visibleGoal) ?? input.fallbackVisibleGoal,
    maxRounds: positiveInteger(input.goal?.maxRounds, DEFAULT_GOAL_MAX_ROUNDS),
    maxStalledRounds: positiveInteger(input.goal?.maxStalledRounds, DEFAULT_GOAL_MAX_STALLED_ROUNDS),
    currentRound: -1,
    completedRounds: 0,
    stalledRounds: 0
  };
}

export const defaultGoalContinuationDecider: GoalContinuationDecider = (input) =>
  goalContinuationDecisionFromAssessment(input.assessment);

export function advanceGoalStallState(
  goal: OrchestratorGoalRunState,
  decision: GoalContinuationDecision
): OrchestratorGoalRunState {
  if (decision.action !== "continue" || !decision.progressSignature) {
    return {
      ...goal,
      stalledRounds: 0,
      ...(decision.progressSignature ? { lastProgressSignature: decision.progressSignature } : {})
    };
  }

  const stalledRounds = decision.progressSignature === goal.lastProgressSignature ? goal.stalledRounds + 1 : 0;
  return {
    ...goal,
    stalledRounds,
    lastProgressSignature: decision.progressSignature
  };
}

export function updateGoalState(
  goal: OrchestratorGoalRunState,
  patch: Partial<OrchestratorGoalRunState>
): OrchestratorGoalRunState {
  const next = { ...goal, ...patch };
  return compactGoalState(next);
}

function compactGoalState(goal: OrchestratorGoalRunState): OrchestratorGoalRunState {
  return {
    status: goal.status,
    ...(goal.visibleGoal ? { visibleGoal: goal.visibleGoal } : {}),
    maxRounds: goal.maxRounds,
    maxStalledRounds: goal.maxStalledRounds,
    currentRound: goal.currentRound,
    completedRounds: goal.completedRounds,
    stalledRounds: goal.stalledRounds,
    ...(goal.stoppedReason ? { stoppedReason: goal.stoppedReason } : {}),
    ...(goal.lastProgressSignature ? { lastProgressSignature: goal.lastProgressSignature } : {}),
    ...(goal.lastDecision ? { lastDecision: goal.lastDecision } : {})
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}


