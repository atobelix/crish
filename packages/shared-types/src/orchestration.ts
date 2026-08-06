import type { JsonObject } from "./primitive-types";
import type { AgentEvent } from "./events";

export type SessionStatus = "open" | "closed" | "archived";
// RunStatus 放宽（审计 11-T1 / 裁决 D3）：string 兜底使未知状态字面量
// 通过类型检查；消费面「原样显示」未知字面量（不 panic、落默认分支）。
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | (string & {});
export type RunOutcome = "completed" | "blocked" | "cancelled" | "failed";

export type RunOutcomeReason =
  | "completed"
  | "cancelled"
  | "aborted"
  | "daemon-restarted"
  | "goal-completed"
  | "goal-blocked"
  | "goal-max-rounds"
  | "goal-stalled"
  | "max-turns"
  | "agent-error"
  | "provider-error"
  | "runtime-error"
  | "intervention-required"
  | "event-store-write-failed"
  | "awaiting-approval"
  | "run-engine-error";

export type GoalContinuationAction = "continue" | "complete" | "block";

export interface GoalContinuationDecision {
  action: GoalContinuationAction;
  reason: string;
  prompt?: string;
  progressSignature?: string;
  detail?: JsonObject;
}

export type GoalRunStatus = "queued" | "running" | "completed" | "blocked" | "cancelled" | "failed";
export type GoalStoppedReason = "complete" | "blocked" | "max-rounds" | "stalled" | "cancelled" | "error";

export interface OrchestratorGoalRunState {
  status: GoalRunStatus;
  visibleGoal?: string;
  maxRounds: number;
  maxStalledRounds: number;
  currentRound: number;
  completedRounds: number;
  stalledRounds: number;
  stoppedReason?: GoalStoppedReason;
  lastProgressSignature?: string;
  lastDecision?: GoalContinuationDecision;
}

export interface GoalRoundAssessmentState {
  state: "completed" | "cancelled" | "failed" | "blocked" | "needs-continuation" | "no-progress";
  reason: string;
  runStatus: RunStatus;
  runOutcome?: RunOutcome;
  runReason?: RunOutcomeReason;
  latestAgentEndReason?: AgentEvent extends { type: "agent-end" } ? AgentEvent["reason"] : never;
  latestError?: string;
  progress: {
    signature: string;
    observed: boolean;
    eventCount: number;
    messageCount: number;
    toolCallCount: number;
    toolResultCount: number;
    toolErrorCount: number;
    checkpointCount: number;
  };
  budget?: {
    completedRounds: number;
    maxRounds: number;
    maxRoundsReached: boolean;
    stalledRounds: number;
    maxStalledRounds: number;
    stalledLimitReached: boolean;
  };
  issues: string[];
}

export interface OrchestratorSessionRecord {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  currentLeafId?: string;
  metadata?: JsonObject;
}

export interface OrchestratorRunRecord {
  id: string;
  sessionId: string;
  cwd: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  outcome?: RunOutcome;
  reason?: RunOutcomeReason;
  outcomeDetail?: JsonObject;
  error?: string;
  kind?: string;
  goal?: OrchestratorGoalRunState;
  lastEventId?: string;
  metadata?: JsonObject;
}

export type PendingInputMode = "after-current-run" | "steer";
export type PendingInputStatus = "pending" | "cancelled" | "dispatched";

export interface PendingInputRecord {
  id: string;
  sessionId: string;
  runId?: string;
  text: string;
  mode: PendingInputMode;
  status: PendingInputStatus;
  createdAt: string;
  updatedAt: string;
  source?: "workbench" | "daemon" | "automation";
  metadata?: JsonObject;
}

export type OrchestratorRunKind = "task" | "goal";
