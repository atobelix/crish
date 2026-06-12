import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@crish/shared-types";
import type { OrchestratorRunRecord } from "./types";
import {
  assessGoalRound,
  goalContinuationDecisionFromAssessment,
  goalContinuationDecisionFromEvents
} from "./task-assessment";

describe("goal task assessment", () => {
  it("maps completed run outcomes to complete decisions", () => {
    const assessment = assessGoalRound({
      run: goalRun({ status: "completed", outcome: "completed", reason: "goal-completed" }),
      roundIndex: 0,
      events: []
    });

    expect(assessment).toMatchObject({
      state: "completed",
      runStatus: "completed",
      runOutcome: "completed",
      runReason: "goal-completed"
    });
    expect(goalContinuationDecisionFromAssessment(assessment)).toMatchObject({
      action: "complete",
      reason: "Goal run completed."
    });
  });

  it("blocks cancelled run outcomes instead of continuing", () => {
    const assessment = assessGoalRound({
      run: goalRun({ status: "cancelled", outcome: "cancelled", reason: "aborted", error: "cancelled by runtime" }),
      roundIndex: 0,
      events: [goalDecisionToolEnd({ action: "continue", reason: "try again", prompt: "continue" })]
    });

    expect(assessment).toMatchObject({
      state: "cancelled",
      latestError: "cancelled by runtime",
      explicitDecision: {
        action: "continue"
      }
    });
    expect(goalContinuationDecisionFromAssessment(assessment)).toMatchObject({
      action: "block",
      reason: "cancelled by runtime"
    });
  });

  it("blocks failed run outcomes instead of continuing", () => {
    const assessment = assessGoalRound({
      run: goalRun({ status: "failed", outcome: "failed", reason: "run-engine-error", error: "engine exploded" }),
      roundIndex: 0,
      events: [goalDecisionToolEnd({ action: "continue", reason: "keep going", prompt: "continue" })]
    });

    expect(assessment).toMatchObject({
      state: "failed",
      runReason: "run-engine-error",
      latestError: "engine exploded"
    });
    expect(goalContinuationDecisionFromAssessment(assessment)).toMatchObject({
      action: "block",
      reason: "engine exploded"
    });
  });

  it("lets max-turns override an explicit continue decision", () => {
    const assessment = assessGoalRound({
      run: goalRun(),
      roundIndex: 0,
      events: [
        goalDecisionToolEnd({ action: "continue", reason: "more work", prompt: "continue" }),
        { type: "agent-end", sessionId: "session_goal", timestamp: "2026-01-01T00:00:01.000Z", reason: "max-turns" }
      ]
    });

    expect(assessment).toMatchObject({
      state: "failed",
      runReason: "max-turns",
      latestAgentEndReason: "max-turns",
      explicitDecision: {
        action: "continue"
      }
    });
    expect(goalContinuationDecisionFromAssessment(assessment)).toMatchObject({
      action: "block",
      reason: "Goal round reached the maximum turn limit."
    });
  });

  it("classifies runtime errors after provider failures as provider errors", () => {
    const assessment = assessGoalRound({
      run: goalRun(),
      roundIndex: 0,
      events: [
        {
          type: "provider-diagnostic",
          sessionId: "session_goal",
          timestamp: "2026-01-01T00:00:00.000Z",
          diagnostic: {
            phase: "response-start",
            providerId: "test-provider",
            status: 429,
            errorKind: "rate-limit"
          }
        },
        {
          type: "runtime-error",
          sessionId: "session_goal",
          timestamp: "2026-01-01T00:00:01.000Z",
          error: "rate limited"
        }
      ]
    });

    expect(assessment).toMatchObject({
      state: "failed",
      runReason: "provider-error",
      latestError: "rate limited",
      providerFailure: {
        status: 429,
        errorKind: "rate-limit"
      }
    });
    expect(goalContinuationDecisionFromAssessment(assessment)).toMatchObject({
      action: "block",
      reason: "rate limited"
    });
  });

  it("classifies runtime errors without provider failures as runtime errors", () => {
    const assessment = assessGoalRound({
      run: goalRun(),
      roundIndex: 0,
      events: [
        {
          type: "runtime-error",
          sessionId: "session_goal",
          timestamp: "2026-01-01T00:00:01.000Z",
          error: "tool bridge crashed"
        }
      ]
    });

    expect(assessment).toMatchObject({
      state: "failed",
      runReason: "runtime-error",
      latestError: "tool bridge crashed"
    });
    expect(goalContinuationDecisionFromAssessment(assessment)).toMatchObject({
      action: "block",
      reason: "tool bridge crashed"
    });
  });

  it("does not treat legacy message markers as typed assessment input", () => {
    const events: AgentEvent[] = [
      goalDecisionMessageEnd({ action: "complete", reason: "legacy marker says done" }),
      { type: "agent-end", sessionId: "session_goal", timestamp: "2026-01-01T00:00:01.000Z", reason: "stop" }
    ];
    const assessment = assessGoalRound({
      run: goalRun(),
      roundIndex: 0,
      events
    });

    expect(goalContinuationDecisionFromEvents(events)).toMatchObject({
      action: "complete",
      reason: "legacy marker says done"
    });
    expect(assessment).toMatchObject({
      state: "no-progress",
      progress: {
        observed: false,
        signature: "no-progress"
      }
    });
    expect(assessment.explicitDecision).toBeUndefined();
    expect(goalContinuationDecisionFromAssessment(assessment)).toMatchObject({
      action: "block",
      reason: "Goal round ended without observable progress or a typed continuation decision."
    });
  });
});

function goalRun(overrides: Partial<OrchestratorRunRecord> = {}): OrchestratorRunRecord {
  const defaultGoal = {
    status: "running" as const,
    visibleGoal: "ship the feature",
    maxRounds: 3,
    maxStalledRounds: 1,
    currentRound: 0,
    completedRounds: 1,
    stalledRounds: 0
  };

  return {
    id: "run_goal",
    sessionId: "session_goal",
    cwd: "C:/tmp",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    kind: "goal",
    ...overrides,
    goal: overrides.goal ? { ...defaultGoal, ...overrides.goal } : defaultGoal
  };
}

function goalDecisionToolEnd(decision: {
  action: "continue" | "complete" | "block";
  reason: string;
  prompt?: string;
  progressSignature?: string;
}): AgentEvent {
  return {
    type: "tool-end",
    sessionId: "session_goal",
    batchId: "batch_goal",
    timestamp: "2026-01-01T00:00:00.500Z",
    result: {
      id: "tool_goal",
      toolName: "goal_status",
      durationMs: 1,
      isError: false,
      output: {
        text: decision.reason,
        json: {
          continuation: decision
        }
      }
    }
  };
}

function goalDecisionMessageEnd(decision: {
  action: "continue" | "complete" | "block";
  reason: string;
  prompt?: string;
  progressSignature?: string;
}): AgentEvent {
  return {
    type: "message-end",
    sessionId: "session_goal",
    message: {
      id: `message_${decision.action}`,
      role: "assistant",
      createdAt: "2026-01-01T00:00:00.250Z",
      blocks: [
        {
          type: "text",
          text: `Round finished.\nCONEX_GOAL_DECISION: ${JSON.stringify(decision)}`
        }
      ]
    }
  };
}
