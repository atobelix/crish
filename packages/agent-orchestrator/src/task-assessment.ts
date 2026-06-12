import type { JsonObject, JsonValue } from "@crish/shared-types";
import type { AgentEvent, AgentMessage, ToolBatchResult, ToolOutput } from "@crish/shared-types";
import { compactJsonObject, isRecord, nonEmptyString } from "@crish/shared-utils";
import type {
  GoalContinuationDecision,
  GoalContinuationDecisionSource,
  GoalRoundAssessment,
  GoalRoundBudgetAssessment,
  GoalRoundProgressAssessment,
  OrchestratorRunRecord,
  RunOutcomeReason
} from "./types";

export interface AssessGoalRoundInput {
  run: OrchestratorRunRecord;
  roundIndex: number;
  events: readonly AgentEvent[];
}

interface DecisionMatch {
  decision: GoalContinuationDecision;
  source: GoalContinuationDecisionSource;
}

interface EventFailure {
  state: Extract<GoalRoundAssessment["state"], "completed" | "cancelled" | "failed" | "blocked">;
  reason: string;
  runReason?: RunOutcomeReason;
  latestAgentEndReason?: GoalRoundAssessment["latestAgentEndReason"];
  latestError?: string;
  providerFailure?: JsonObject;
}

export function assessGoalRound(input: AssessGoalRoundInput): GoalRoundAssessment {
  const progress = assessRoundProgress(input.events);
  const explicit = structuredGoalContinuationDecisionFromEvents(input.events);
  const budget = budgetAssessment(input.run);
  const latestToolError = latestToolErrorFromEvents(input.events);
  const runTerminal = terminalAssessmentFromRun(input.run);
  const eventTerminal = terminalAssessmentFromEvents(input.events);
  const issues: string[] = [];

  if (runTerminal) {
    issues.push(runTerminal.reason);
    return compactAssessment({
      state: runTerminal.state,
      reason: runTerminal.reason,
      runStatus: input.run.status,
      runOutcome: input.run.outcome,
      runReason: input.run.reason,
      latestError: runTerminal.latestError,
      providerFailure: runTerminal.providerFailure,
      explicitDecision: explicit?.decision,
      explicitDecisionSource: explicit?.source,
      progress,
      budget,
      issues
    });
  }

  if (eventTerminal) {
    issues.push(eventTerminal.reason);
    return compactAssessment({
      state: eventTerminal.state,
      reason: eventTerminal.reason,
      runStatus: input.run.status,
      runOutcome: input.run.outcome,
      runReason: eventTerminal.runReason ?? input.run.reason,
      latestAgentEndReason: eventTerminal.latestAgentEndReason,
      latestError: eventTerminal.latestError,
      providerFailure: eventTerminal.providerFailure,
      explicitDecision: explicit?.decision,
      explicitDecisionSource: explicit?.source,
      progress,
      budget,
      issues
    });
  }

  if (explicit) {
    const state = stateFromDecision(explicit.decision);
    return compactAssessment({
      state,
      reason: explicit.decision.reason,
      runStatus: input.run.status,
      runOutcome: input.run.outcome,
      runReason: input.run.reason,
      latestError: latestToolError,
      explicitDecision: explicit.decision,
      explicitDecisionSource: explicit.source,
      progress,
      budget,
      issues
    });
  }

  if (budget?.maxRoundsReached) {
    issues.push(`Goal reached the maximum round limit: ${budget.maxRounds}`);
    return compactAssessment({
      state: "blocked",
      reason: `Goal reached the maximum round limit: ${budget.maxRounds}`,
      runStatus: input.run.status,
      runOutcome: input.run.outcome,
      runReason: input.run.reason,
      progress,
      budget,
      issues
    });
  }

  const latestAgentEnd = latestEvent(input.events, "agent-end");
  if (latestToolError) {
    const reason = "Goal round ended with tool errors and no typed continuation decision.";
    issues.push(reason);
    return compactAssessment({
      state: "no-progress",
      reason,
      runStatus: input.run.status,
      runOutcome: input.run.outcome,
      runReason: input.run.reason,
      latestAgentEndReason: latestAgentEnd?.reason,
      latestError: latestToolError,
      progress,
      budget,
      issues
    });
  }

  const reason =
    latestAgentEnd?.reason === "stop" && progress.observed
      ? "Goal round stopped after observable work but did not emit a typed continuation decision."
      : "Goal round ended without observable progress or a typed continuation decision.";
  issues.push(reason);

  return compactAssessment({
    state: progress.observed ? "blocked" : "no-progress",
    reason,
    runStatus: input.run.status,
    runOutcome: input.run.outcome,
    runReason: input.run.reason,
    latestAgentEndReason: latestAgentEnd?.reason,
    progress,
    budget,
    issues
  });
}

export function goalContinuationDecisionFromAssessment(assessment: GoalRoundAssessment): GoalContinuationDecision {
  if (assessment.state === "cancelled" || assessment.state === "failed") {
    return blockDecisionFromAssessment(assessment);
  }

  if (assessment.explicitDecision) {
    return decisionWithAssessmentDetail(assessment.explicitDecision, assessment);
  }

  if (assessment.state === "completed") {
    return decisionWithAssessmentDetail(
      {
        action: "complete",
        reason: assessment.reason
      },
      assessment
    );
  }

  return blockDecisionFromAssessment(assessment);
}

export function structuredGoalContinuationDecisionFromEvents(events: readonly AgentEvent[]): DecisionMatch | undefined {
  for (const event of [...events].reverse()) {
    if (event.type === "tool-end") {
      const decision = goalContinuationDecisionFromJson(event.result.output.json);
      if (decision) return { decision, source: "tool-output" };
    }
    if (event.type === "tool-batch-end") {
      for (const result of [...event.calls].reverse()) {
        const decision = goalContinuationDecisionFromJson(result.output.json);
        if (decision) return { decision, source: "tool-output" };
      }
    }
    if (event.type === "tool-update") {
      const decision = goalContinuationDecisionFromJson(event.update.json);
      if (decision) return { decision, source: "tool-update" };
    }
  }
  return undefined;
}

export function goalContinuationDecisionFromEvents(events: readonly AgentEvent[]): GoalContinuationDecision | undefined {
  for (const event of [...events].reverse()) {
    if (event.type === "tool-end") {
      const decision = goalContinuationDecisionFromJson(event.result.output.json);
      if (decision) return decision;
    }
    if (event.type === "tool-batch-end") {
      for (const result of [...event.calls].reverse()) {
        const decision = goalContinuationDecisionFromJson(result.output.json);
        if (decision) return decision;
      }
    }
    if (event.type === "tool-update") {
      const decision = goalContinuationDecisionFromJson(event.update.json);
      if (decision) return decision;
    }
    if (event.type === "message-end" || event.type === "message-start") {
      const decision = goalContinuationDecisionFromMessage(event.message);
      if (decision) return decision;
    }
  }
  return undefined;
}

export function goalContinuationDecisionFromJson(value: JsonValue | undefined): GoalContinuationDecision | undefined {
  const record = continuationRecord(value);
  if (!record) return undefined;
  return parseGoalContinuationDecision(record);
}

export function goalContinuationDecisionFromMessage(message: AgentMessage): GoalContinuationDecision | undefined {
  for (const block of [...message.blocks].reverse()) {
    if (block.type !== "text") continue;
    const fromMarker = parseGoalDecisionMarker(block.text);
    if (fromMarker) return fromMarker;
  }
  return undefined;
}

function terminalAssessmentFromRun(run: OrchestratorRunRecord): EventFailure | undefined {
  if (run.status === "cancelled" || run.outcome === "cancelled") {
    return {
      state: "cancelled",
      reason: run.error ?? "Goal run was cancelled.",
      runReason: run.reason,
      latestError: run.error
    };
  }

  if (run.outcome === "blocked") {
    return {
      state: "blocked",
      reason: run.error ?? `Goal run is blocked with reason: ${run.reason ?? "blocked"}`,
      runReason: run.reason,
      latestError: run.error
    };
  }

  if (run.outcome === "failed" || run.status === "failed") {
    return {
      state: "failed",
      reason: run.error ?? `Goal run failed with reason: ${run.reason ?? "failed"}`,
      runReason: run.reason,
      latestError: run.error,
      providerFailure: providerFailureFromDetail(run.outcomeDetail)
    };
  }

  if (run.outcome === "completed" || run.status === "completed") {
    return {
      state: "completed",
      reason: "Goal run completed.",
      runReason: run.reason
    };
  }

  return undefined;
}

function terminalAssessmentFromEvents(events: readonly AgentEvent[]): EventFailure | undefined {
  const providerFailure = latestProviderFailure(events);

  for (const event of [...events].reverse()) {
    if (event.type === "runtime-error") {
      return {
        state: "failed",
        reason: event.error,
        runReason: providerFailure ? "provider-error" : "runtime-error",
        latestError: event.error,
        providerFailure
      };
    }

    if (event.type === "runtime-intervention-required") {
      return {
        state: "failed",
        reason: event.message,
        runReason: "intervention-required",
        latestError: event.message
      };
    }

    if (event.type === "agent-end") {
      if (event.reason === "aborted") {
        return {
          state: "cancelled",
          reason: event.error ?? "Goal round was aborted.",
          runReason: "aborted",
          latestAgentEndReason: event.reason,
          latestError: event.error
        };
      }
      if (event.reason === "max-turns") {
        return {
          state: "failed",
          reason: event.error ?? "Goal round reached the maximum turn limit.",
          runReason: "max-turns",
          latestAgentEndReason: event.reason,
          latestError: event.error
        };
      }
      if (event.reason === "error") {
        return {
          state: "failed",
          reason: event.error ?? "Goal round ended with an agent error.",
          runReason: "agent-error",
          latestAgentEndReason: event.reason,
          latestError: event.error
        };
      }
    }
  }

  return undefined;
}

function latestProviderFailure(events: readonly AgentEvent[]): JsonObject | undefined {
  const event = [...events]
    .reverse()
    .find((entry): entry is Extract<AgentEvent, { type: "provider-diagnostic" }> =>
      entry.type === "provider-diagnostic" && isProviderFailureDiagnostic(entry.diagnostic)
    );
  return event?.diagnostic as unknown as JsonObject | undefined;
}

function latestToolErrorFromEvents(events: readonly AgentEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type === "tool-end" && event.result.isError) {
      return event.result.output.text ?? `Tool ${event.result.toolName} failed.`;
    }
    if (event.type === "tool-batch-end") {
      const failed = [...event.calls].reverse().find((result) => result.isError);
      if (failed) return failed.output.text ?? `Tool ${failed.toolName} failed.`;
    }
  }
  return undefined;
}

function assessRoundProgress(events: readonly AgentEvent[]): GoalRoundProgressAssessment {
  const facts: JsonValue[] = [];
  let messageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let toolErrorCount = 0;
  let checkpointCount = 0;
  const seenToolResultIds = new Set<string>();

  const recordToolResult = (result: ToolBatchResult) => {
    if (seenToolResultIds.has(result.id)) return;
    seenToolResultIds.add(result.id);
    toolResultCount += 1;
    if (result.isError) toolErrorCount += 1;
    if (goalContinuationDecisionFromJson(result.output.json)) return;
    facts.push({
      type: "tool-end",
      toolName: result.toolName,
      isError: result.isError,
      output: summarizeToolOutput(result.output)
    });
  };

  for (const event of events) {
    if (event.type === "message-end") {
      messageCount += 1;
      continue;
    }
    if (event.type === "tool-start") {
      toolCallCount += 1;
      continue;
    }
    if (event.type === "turn-end") {
      toolCallCount += event.toolCallCount;
      continue;
    }
    if (event.type === "tool-end") {
      recordToolResult(event.result);
      continue;
    }
    if (event.type === "tool-batch-end") {
      for (const result of event.calls) {
        recordToolResult(result);
      }
      continue;
    }
    if (event.type === "tool-update") {
      if (event.update.json !== undefined || event.update.text) {
        if (goalContinuationDecisionFromJson(event.update.json)) continue;
        facts.push({
          type: "tool-update",
          toolCallId: event.toolCallId,
          update: summarizeToolOutput(event.update)
        });
      }
      continue;
    }
    if (event.type === "checkpoint-created") {
      checkpointCount += 1;
      facts.push(compactJsonObject({
        type: "checkpoint-created",
        id: event.checkpoint.id,
        kind: event.checkpoint.kind,
        label: event.checkpoint.label,
        artifactUri: event.checkpoint.artifactUri
      }));
      continue;
    }
    if (event.type === "checkpoint-restored") {
      facts.push({
        type: "checkpoint-restored",
        checkpointId: event.restore.checkpointId,
        restored: event.restore.restored,
        deleted: event.restore.deleted
      });
      continue;
    }
    if (event.type === "context-compression-end") {
      facts.push(compactJsonObject({
        type: "context-compression-end",
        aborted: event.aborted,
        summaryHash: event.result?.summary ? hashText(event.result.summary) : undefined,
        error: event.error
      }));
      continue;
    }
    if (event.type === "tool-input-repaired") {
      facts.push({
        type: "tool-input-repaired",
        toolName: event.toolName,
        notes: event.notes
      });
    }
  }

  const observed = facts.some((fact) => {
    if (!isRecord(fact)) return false;
    if (fact.type !== "tool-end") return true;
    return fact.isError !== true;
  });
  const signature = facts.length > 0 ? `progress:${hashJson(facts)}` : "no-progress";

  return {
    signature,
    observed,
    eventCount: events.length,
    messageCount,
    toolCallCount,
    toolResultCount,
    toolErrorCount,
    checkpointCount
  };
}

function budgetAssessment(run: OrchestratorRunRecord): GoalRoundBudgetAssessment | undefined {
  if (!run.goal) return undefined;
  return {
    completedRounds: run.goal.completedRounds,
    maxRounds: run.goal.maxRounds,
    maxRoundsReached: run.goal.completedRounds >= run.goal.maxRounds,
    stalledRounds: run.goal.stalledRounds,
    maxStalledRounds: run.goal.maxStalledRounds,
    stalledLimitReached: run.goal.stalledRounds >= run.goal.maxStalledRounds
  };
}

function stateFromDecision(decision: GoalContinuationDecision): GoalRoundAssessment["state"] {
  if (decision.action === "complete") return "completed";
  if (decision.action === "block") return "blocked";
  return "needs-continuation";
}

function blockDecisionFromAssessment(assessment: GoalRoundAssessment): GoalContinuationDecision {
  return decisionWithAssessmentDetail(
    {
      action: "block",
      reason: assessment.reason,
      progressSignature: assessment.progress.signature
    },
    assessment
  );
}

function decisionWithAssessmentDetail(
  decision: GoalContinuationDecision,
  assessment: GoalRoundAssessment
): GoalContinuationDecision {
  return {
    ...decision,
    ...(decision.action === "continue" && !decision.progressSignature ? { progressSignature: assessment.progress.signature } : {}),
    detail: compactJsonObject({
      ...decision.detail,
      decisionSource: assessment.explicitDecision ? assessment.explicitDecisionSource : "typed-assessment",
      assessment: assessmentDetail(assessment)
    })
  };
}

function assessmentDetail(assessment: GoalRoundAssessment): JsonObject {
  return compactJsonObject({
    state: assessment.state,
    reason: assessment.reason,
    runStatus: assessment.runStatus,
    runOutcome: assessment.runOutcome,
    runReason: assessment.runReason,
    latestAgentEndReason: assessment.latestAgentEndReason,
    latestError: assessment.latestError,
    providerFailure: assessment.providerFailure,
    explicitDecisionSource: assessment.explicitDecisionSource,
    progress: assessment.progress,
    budget: assessment.budget,
    issues: assessment.issues
  });
}

function continuationRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.continuation)) return value.continuation;
  if (isRecord(value.goalContinuation)) return value.goalContinuation;
  if (isRecord(value.goalDecision)) return value.goalDecision;
  return value;
}

function parseGoalDecisionMarker(text: string): GoalContinuationDecision | undefined {
  const marker = /CONEX_GOAL_DECISION\s*:\s*(\{[\s\S]*?\})/i.exec(text);
  if (marker?.[1]) {
    const parsed = tryParseJsonObject(marker[1]);
    const decision = parsed ? parseGoalContinuationDecision(parsed) : undefined;
    if (decision) return decision;
  }

  const xmlMarker = /<conex-goal-decision>\s*(\{[\s\S]*?\})\s*<\/conex-goal-decision>/i.exec(text);
  if (!xmlMarker?.[1]) return undefined;
  const parsed = tryParseJsonObject(xmlMarker[1]);
  return parsed ? parseGoalContinuationDecision(parsed) : undefined;
}

function parseGoalContinuationDecision(record: Record<string, JsonValue>): GoalContinuationDecision | undefined {
  const action = stringField(record, "action");
  const normalizedAction = normalizeAction(action);
  const reason = stringField(record, "reason") ?? stringField(record, "summary");
  if (!normalizedAction || !reason) return undefined;

  return {
    action: normalizedAction,
    reason,
    ...(nonEmptyString(stringField(record, "prompt")) ? { prompt: stringField(record, "prompt") } : {}),
    ...(nonEmptyString(stringField(record, "progressSignature")) ? { progressSignature: stringField(record, "progressSignature") } : {}),
    ...(isRecord(record.detail) ? { detail: record.detail as JsonObject } : {})
  };
}

function normalizeAction(action: string | undefined): GoalContinuationDecision["action"] | undefined {
  if (action === "continue" || action === "complete" || action === "block") return action;
  if (action === "pause" || action === "blocked") return "block";
  if (action === "done") return "complete";
  return undefined;
}

function summarizeToolOutput(output: Pick<ToolOutput, "text" | "json" | "artifacts">): JsonObject {
  return compactJsonObject({
    textHash: output.text ? hashText(output.text) : undefined,
    jsonHash: output.json === undefined ? undefined : hashJson(output.json),
    artifacts: output.artifacts?.slice(0, 20).map((artifact) =>
      compactJsonObject({
        kind: artifact.kind,
        title: artifact.title,
        uri: artifact.uri
      })
    )
  });
}

function providerFailureFromDetail(detail: JsonObject | undefined): JsonObject | undefined {
  const providerDiagnostic = isRecord(detail?.providerDiagnostic) ? detail.providerDiagnostic : undefined;
  return providerDiagnostic as JsonObject | undefined;
}

function isProviderFailureDiagnostic(diagnostic: Extract<AgentEvent, { type: "provider-diagnostic" }>["diagnostic"]): boolean {
  return diagnostic.phase === "request-error" || (typeof diagnostic.status === "number" && diagnostic.status >= 400);
}

function latestEvent<TType extends AgentEvent["type"]>(
  events: readonly AgentEvent[],
  type: TType
): Extract<AgentEvent, { type: TType }> | undefined {
  return [...events].reverse().find((event): event is Extract<AgentEvent, { type: TType }> => event.type === type);
}

function compactAssessment(assessment: GoalRoundAssessment): GoalRoundAssessment {
  const compacted: Partial<GoalRoundAssessment> = {};
  for (const [key, value] of Object.entries(assessment) as Array<[keyof GoalRoundAssessment, unknown]>) {
    if (value !== undefined) {
      compacted[key] = value as never;
    }
  }
  return compacted as GoalRoundAssessment;
}

function tryParseJsonObject(text: string): Record<string, JsonValue> | undefined {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? (parsed as Record<string, JsonValue>) : undefined;
  } catch {
    return undefined;
  }
}



function stringField(record: Record<string, JsonValue>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function hashJson(value: JsonValue): string {
  return hashText(stableJson(value));
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}


