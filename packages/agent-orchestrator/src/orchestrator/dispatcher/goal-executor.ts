import type { JsonObject, AgentEvent } from "@crish/shared-types";
import { ProtocolError } from "@crish/shared-types";
import { compactJsonObject, toJsonObject, MAX_ORCHESTRATOR_EVENTS } from "@crish/shared-utils";
import type {
  AgentOrchestratorOptions,
  GoalContinuationDecision,
  GoalLoopStrategy,
  OrchestratorEvent,
  OrchestratorGoalRunState,
  OrchestratorRunRecord,
  OrchestratorSessionRecord,
  RunStatus,
  StartGoalRunRequest,
  StartRunRequest
} from "../../types";
import { isTerminalRunStatus } from "../../state-machine";
import {
  advanceGoalStallState,
  assessGoalRound,
  createGoalRunState,
  updateGoalState
} from "../../goal-continuation";
import {
  EventScanGoalStrategy,
  createDefaultProviderErrorHandler
} from "../../event-scan-goal-strategy";
import type { ActiveRun, AgentLoop, RunCompletion } from "../agent-loop";

export { createGoalRunState };

export interface GoalRunDriverContext {
  loop: AgentLoop;
  options: AgentOrchestratorOptions;
  updateRun: (
    run: OrchestratorRunRecord,
    status: RunStatus,
    extra?: Partial<Pick<OrchestratorRunRecord, "startedAt" | "finishedAt" | "outcome" | "reason" | "outcomeDetail" | "error">>
  ) => void;
  updateRunGoal: (run: OrchestratorRunRecord, goal: OrchestratorGoalRunState) => void;
  emitToRun: (active: ActiveRun, type: OrchestratorEvent["type"], payload: JsonObject) => void;
  emitRunTerminalEvent: (active: ActiveRun, error?: string) => void;
  applyRuntimeEventStatus: (
    active: ActiveRun,
    runtimeEvent: AgentEvent,
    options?: { agentStopCompletes?: boolean }
  ) => RunCompletion | undefined;
  waitForPendingEmits: (active: ActiveRun) => Promise<void>;
}

export async function driveGoalRun(
  ctx: GoalRunDriverContext,
  active: ActiveRun,
  session: OrchestratorSessionRecord,
  request: StartGoalRunRequest
): Promise<void> {
  const run = active.run;
  const strategy = request.goalLoopStrategy
    ?? ctx.options.defaultGoalLoopStrategy
    ?? new EventScanGoalStrategy();
  const maxTransientProviderErrors = Math.max(6, Math.ceil((requiredGoal(run).maxRounds) * 0.75));
  const providerBackoffMs = ctx.options.providerRateLimitBackoffMs ?? 90_000;
  const handleProviderError = strategy.handleProviderError
    ?? createDefaultProviderErrorHandler({ maxTransientErrors: maxTransientProviderErrors, backoffMs: providerBackoffMs });
  let currentPrompt = request.input;
  let consecutiveTransientProviderErrors = 0;

  try {
    ctx.updateRun(run, "running", { startedAt: ctx.loop.now() });
    ctx.updateRunGoal(run, updateGoalState(requiredGoal(run), { status: "running" }));
    ctx.emitToRun(active, "run-started", { run: toJsonObject(run) });

    while (!isTerminalRunStatus(run.status)) {
      if (active.persistenceFailed) break;
      if (hasRunStatus(run, "cancelling")) break;
      const goal = requiredGoal(run);
      if (goal.completedRounds >= goal.maxRounds) {
        completeGoalRun(ctx, active, blockedCompletion("goal-max-rounds", `Goal reached the maximum round limit: ${goal.maxRounds}`), {
          status: "blocked",
          stoppedReason: "max-rounds"
        });
        break;
      }

      const roundIndex = goal.completedRounds;
      ctx.updateRunGoal(
        run,
        updateGoalState(goal, {
          status: "running",
          currentRound: roundIndex
        })
      );
      ctx.emitToRun(active, "goal-round-started", {
        run: toJsonObject(run),
        round: { index: roundIndex }
      });

      const { events: roundEvents, roundContext } = await driveGoalRound(ctx, active, session, currentPrompt, strategy);
      if (isTerminalRunStatus(run.status)) break;

      if (hasRunStatus(run, "cancelling")) break;

      const providerError = handleProviderError({
        events: roundEvents,
        roundIndex,
        consecutiveTransientErrors: consecutiveTransientProviderErrors
      });
      if (providerError) {
        if (providerError.action === "fatal") {
          const completion = failedCompletion("provider-error", providerError.reason);
          completeGoalRun(ctx, active, completion, { status: "failed", stoppedReason: "error" });
          break;
        }
        if (providerError.action === "backoff" || providerError.action === "retry") {
          consecutiveTransientProviderErrors += 1;
          const backoffMs = providerError.backoffMs ?? 0;
          if (backoffMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
          }
          continue;
        }
      }
      consecutiveTransientProviderErrors = 0;

      ctx.updateRunGoal(
        run,
        updateGoalState(requiredGoal(run), {
          completedRounds: roundIndex + 1
        })
      );
      ctx.emitToRun(active, "goal-round-completed", {
        run: toJsonObject(run),
        round: { index: roundIndex, eventCount: roundEvents.length }
      });

      const decision = await strategy.assessRound({
        run,
        session,
        roundIndex,
        prompt: currentPrompt,
        events: roundEvents,
        roundContext
      });
      const assessment = assessGoalRound({ run, roundIndex, events: roundEvents });

      const progressSignature = strategy.computeProgressSignature({
        decision,
        events: roundEvents,
        roundContext
      });
      const decisionWithSignature: GoalContinuationDecision = {
        ...decision,
        progressSignature
      };

      const nextGoal = advanceGoalStallState(
        updateGoalState(requiredGoal(run), {
          lastDecision: decisionWithSignature
        }),
        decisionWithSignature
      );
      ctx.updateRunGoal(run, nextGoal);
      ctx.emitToRun(active, "goal-continuation-decided", {
        run: toJsonObject(run),
        decision: toJsonObject(decisionWithSignature),
        assessment: toJsonObject(assessment),
        round: { index: roundIndex }
      });

      const goalCompletion = completionFromGoalDecision(decisionWithSignature, requiredGoal(run));
      if (goalCompletion) {
        completeGoalRun(ctx, active, goalCompletion.completion, goalCompletion.goalPatch);
        break;
      }

      const enrichedPrompt = strategy.buildNextRoundPrompt?.({
        decision: decisionWithSignature,
        roundIndex,
        goalState: requiredGoal(run),
        events: roundEvents,
        roundContext
      });
      currentPrompt = enrichedPrompt ?? decisionWithSignature.prompt ?? currentPrompt;
    }

    if (!active.persistenceFailed && !isTerminalRunStatus(run.status)) {
      const completion =
        run.status === "cancelling"
          ? cancelledCompletion("cancelled")
          : blockedCompletion("goal-max-rounds", `Goal reached the maximum round limit: ${requiredGoal(run).maxRounds}`);
      completeGoalRun(ctx, active, completion, {
        status: completion.outcome === "cancelled" ? "cancelled" : "blocked",
        stoppedReason: completion.outcome === "cancelled" ? "cancelled" : "max-rounds"
      });
    } else if (!active.persistenceFailed) {
      finalizeGoalFromTerminalRun(ctx, run);
    }

    if (!active.persistenceFailed) {
      ctx.emitRunTerminalEvent(active);
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const completion = run.status === "cancelling" ? cancelledCompletion("cancelled", error) : failedCompletion("run-engine-error", error);
    completeGoalRun(ctx, active, completion, {
      status: completion.outcome === "cancelled" ? "cancelled" : "failed",
      stoppedReason: completion.outcome === "cancelled" ? "cancelled" : "error"
    });
    ctx.emitRunTerminalEvent(active, error);
  } finally {
    await ctx.waitForPendingEmits(active);
    ctx.loop.activeRuns.delete(run.id);
    active.queue.close();
  }
}

export async function driveGoalRound(
  ctx: GoalRunDriverContext,
  active: ActiveRun,
  session: OrchestratorSessionRecord,
  prompt: StartRunRequest["input"],
  strategy: GoalLoopStrategy
): Promise<{ events: AgentEvent[]; roundContext: unknown | undefined }> {
  const run = active.run;
  const engine = await ctx.options.createRunEngine({ runId: run.id, session, run });
  active.engine = engine;
  const events: AgentEvent[] = [];
  let roundContext: unknown;
  try {
    for await (const runtimeEvent of engine.run(prompt)) {
      if (active.persistenceFailed) break;
      if (events.length < MAX_ORCHESTRATOR_EVENTS) events.push(runtimeEvent);
      if (strategy.onRoundEvent) {
        roundContext = strategy.onRoundEvent(runtimeEvent, roundContext);
      }
      ctx.applyRuntimeEventStatus(active, runtimeEvent, { agentStopCompletes: false });
      ctx.emitToRun(active, "runtime-event", {
        event: toJsonObject(runtimeEvent)
      });
      await ctx.waitForPendingEmits(active);
    }
    return { events, roundContext };
  } finally {
    if (active.engine === engine) {
      active.engine = undefined;
    }
  }
}

export function completeGoalRun(
  ctx: GoalRunDriverContext,
  active: ActiveRun,
  completion: RunCompletion,
  goalPatch: Partial<OrchestratorGoalRunState>
): void {
  const run = active.run;
  ctx.updateRunGoal(run, updateGoalState(requiredGoal(run), goalPatch));
  ctx.updateRun(run, completion.status, {
    finishedAt: ctx.loop.now(),
    outcome: completion.outcome,
    reason: completion.reason,
    ...(completion.outcomeDetail !== undefined ? { outcomeDetail: completion.outcomeDetail } : {}),
    ...(completion.error ? { error: completion.error } : {})
  });
}

export function finalizeGoalFromTerminalRun(ctx: GoalRunDriverContext, run: OrchestratorRunRecord): void {
  if (!run.goal) return;
  if (run.goal.status !== "running" && run.goal.status !== "queued") return;
  if (run.status === "cancelled") {
    ctx.updateRunGoal(run, updateGoalState(run.goal, { status: "cancelled", stoppedReason: "cancelled" }));
    return;
  }
  if (run.outcome === "blocked") {
    ctx.updateRunGoal(run, updateGoalState(run.goal, { status: "blocked", stoppedReason: goalStoppedReasonFromRun(run) }));
    return;
  }
  if (run.status === "failed") {
    ctx.updateRunGoal(run, updateGoalState(run.goal, { status: "failed", stoppedReason: "error" }));
    return;
  }
  if (run.status === "completed") {
    ctx.updateRunGoal(run, updateGoalState(run.goal, { status: "completed", stoppedReason: "complete" }));
  }
}

export function completionFromGoalDecision(
  decision: GoalContinuationDecision,
  goal: OrchestratorGoalRunState
): { completion: RunCompletion; goalPatch: Partial<OrchestratorGoalRunState> } | undefined {
  if (decision.action === "complete") {
    return {
      completion: {
        status: "completed",
        outcome: "completed",
        reason: "goal-completed",
        outcomeDetail: goalDecisionDetail(decision),
        error: undefined
      },
      goalPatch: {
        status: "completed",
        stoppedReason: "complete",
        lastDecision: decision
      }
    };
  }

  if (decision.action === "block") {
    return {
      completion: blockedCompletion("goal-blocked", decision.reason, goalDecisionDetail(decision)),
      goalPatch: {
        status: "blocked",
        stoppedReason: "blocked",
        lastDecision: decision
      }
    };
  }

  if (!decision.prompt?.trim()) {
    return {
      completion: blockedCompletion("goal-blocked", "Goal continuation requested without a next prompt.", goalDecisionDetail(decision)),
      goalPatch: {
        status: "blocked",
        stoppedReason: "blocked",
        lastDecision: decision
      }
    };
  }

  if (goal.stalledRounds >= goal.maxStalledRounds) {
    return {
      completion: blockedCompletion("goal-stalled", `Goal made no observable progress for ${goal.stalledRounds + 1} rounds.`, goalDecisionDetail(decision)),
      goalPatch: {
        status: "blocked",
        stoppedReason: "stalled",
        lastDecision: decision
      }
    };
  }

  if (goal.completedRounds >= goal.maxRounds) {
    return {
      completion: blockedCompletion("goal-max-rounds", `Goal reached the maximum round limit: ${goal.maxRounds}`, goalDecisionDetail(decision)),
      goalPatch: {
        status: "blocked",
        stoppedReason: "max-rounds",
        lastDecision: decision
      }
    };
  }

  return undefined;
}

export function goalDecisionDetail(decision: GoalContinuationDecision): JsonObject {
  return compactJsonObject({
    action: decision.action,
    reason: decision.reason,
    prompt: decision.prompt,
    progressSignature: decision.progressSignature,
    detail: decision.detail
  });
}

export function hasRunStatus(run: OrchestratorRunRecord, status: RunStatus): boolean {
  return run.status === status;
}

export function goalStoppedReasonFromRun(run: OrchestratorRunRecord): NonNullable<OrchestratorGoalRunState["stoppedReason"]> {
  if (run.reason === "goal-max-rounds") return "max-rounds";
  if (run.reason === "goal-stalled") return "stalled";
  if (run.reason === "cancelled" || run.reason === "aborted") return "cancelled";
  if (run.reason === "goal-completed") return "complete";
  if (run.outcome === "failed") return "error";
  return "blocked";
}

export function requiredGoal(run: OrchestratorRunRecord): OrchestratorGoalRunState {
  if (!run.goal) {
    throw new ProtocolError(`Run ${run.id} is not a goal run`, "NOT_A_GOAL_RUN");
  }
  return run.goal;
}

export function promptSummary(input: StartRunRequest["input"]): string {
  if (typeof input === "string") return trimPromptSummary(input);
  const textBlocks = input.blocks
    .filter((block): block is Extract<(typeof input.blocks)[number], { type: "text" | "thought" }> => block.type === "text" || block.type === "thought")
    .map((block) => block.text)
    .join("\n");
  return trimPromptSummary(textBlocks || input.id);
}

export function trimPromptSummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Goal";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function cancelledCompletion(reason: Extract<import("../../types").RunOutcomeReason, "cancelled" | "aborted">, error?: string): RunCompletion {
  return {
    status: "cancelled",
    outcome: "cancelled",
    reason,
    error: error ?? undefined,
    outcomeDetail: undefined
  };
}

function failedCompletion(
  reason: Extract<import("../../types").RunOutcomeReason, "agent-error" | "provider-error" | "runtime-error" | "max-turns" | "intervention-required" | "run-engine-error" | "event-store-write-failed">,
  error?: string,
  outcomeDetail?: JsonObject
): RunCompletion {
  return {
    status: "failed",
    outcome: "failed",
    reason,
    error: error ?? undefined,
    outcomeDetail: outcomeDetail ?? undefined
  };
}

function blockedCompletion(
  reason: Extract<import("../../types").RunOutcomeReason, "goal-blocked" | "goal-max-rounds" | "goal-stalled">,
  error: string,
  outcomeDetail?: JsonObject
): RunCompletion {
  return {
    status: "failed",
    outcome: "blocked",
    reason,
    error,
    outcomeDetail: outcomeDetail ?? undefined
  };
}
