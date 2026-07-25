import type {
  GoalContinuationDecider,
  GoalContinuationDecision,
  GoalRunOptions,
  GoalRunStatus,
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
  goal: GoalRunOptions | undefined;
  fallbackVisibleGoal: string;
}): OrchestratorGoalRunState {
  return {
    status: "queued" as GoalRunStatus,
    visibleGoal: nonEmptyString(input.goal?.visibleGoal) ?? input.fallbackVisibleGoal,
    maxRounds: positiveInteger(input.goal?.maxRounds, DEFAULT_GOAL_MAX_ROUNDS),
    maxStalledRounds: positiveInteger(input.goal?.maxStalledRounds, DEFAULT_GOAL_MAX_STALLED_ROUNDS),
    currentRound: -1,
    completedRounds: 0,
    stalledRounds: 0,
  } as OrchestratorGoalRunState;
}

export const defaultGoalContinuationDecider: GoalContinuationDecider = (input) =>
  goalContinuationDecisionFromAssessment(input.assessment);

export function advanceGoalStallState(
  goal: OrchestratorGoalRunState,
  decision: GoalContinuationDecision
): OrchestratorGoalRunState {
  if (decision.action !== "continue" || !decision.progressSignature) {
    return {
      status: goal.status,
      visibleGoal: goal.visibleGoal,
      maxRounds: goal.maxRounds,
      maxStalledRounds: goal.maxStalledRounds,
      currentRound: goal.currentRound,
      completedRounds: goal.completedRounds,
      stalledRounds: 0,
      ...(goal.stoppedReason !== undefined ? { stoppedReason: goal.stoppedReason } : {}),
      ...(goal.lastDecision !== undefined ? { lastDecision: goal.lastDecision } : {}),
      ...(goal.lastStalledRoundIndex !== undefined ? { lastStalledRoundIndex: goal.lastStalledRoundIndex } : {}),
      ...(decision.progressSignature !== undefined ? { lastProgressSignature: decision.progressSignature } : {}),
    } as OrchestratorGoalRunState;
  }

  const stalledRounds = decision.progressSignature === goal.lastProgressSignature ? goal.stalledRounds + 1 : 0;
  return {
    status: goal.status,
    visibleGoal: goal.visibleGoal,
    maxRounds: goal.maxRounds,
    maxStalledRounds: goal.maxStalledRounds,
    currentRound: goal.currentRound,
    completedRounds: goal.completedRounds,
    stalledRounds,
    ...(goal.stoppedReason !== undefined ? { stoppedReason: goal.stoppedReason } : {}),
    ...(goal.lastDecision !== undefined ? { lastDecision: goal.lastDecision } : {}),
    ...(goal.lastStalledRoundIndex !== undefined ? { lastStalledRoundIndex: goal.lastStalledRoundIndex } : {}),
    ...(decision.progressSignature !== undefined ? { lastProgressSignature: decision.progressSignature } : {}),
  } as OrchestratorGoalRunState;
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
    visibleGoal: goal.visibleGoal,
    maxRounds: goal.maxRounds,
    maxStalledRounds: goal.maxStalledRounds,
    currentRound: goal.currentRound,
    completedRounds: goal.completedRounds,
    stalledRounds: goal.stalledRounds,
    ...(goal.stoppedReason !== undefined ? { stoppedReason: goal.stoppedReason } : {}),
    ...(goal.lastDecision !== undefined ? { lastDecision: goal.lastDecision } : {}),
    ...(goal.lastStalledRoundIndex !== undefined ? { lastStalledRoundIndex: goal.lastStalledRoundIndex } : {}),
    ...(goal.lastProgressSignature !== undefined ? { lastProgressSignature: goal.lastProgressSignature } : {}),
  } as OrchestratorGoalRunState;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}


