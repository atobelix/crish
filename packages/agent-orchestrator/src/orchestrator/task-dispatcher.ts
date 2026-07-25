import type { JsonObject, AgentEvent, AgentMessage } from "@crish/shared-types";
import { SessionError, ProtocolError } from "@crish/shared-types";
import {
  compactJsonObject, BoundedMap, toJsonObject,
  MAX_ORCHESTRATOR_EVENTS,
  Logger, createConsoleTransport,
} from "@crish/shared-utils";
import type {
  AgentOrchestratorOptions,
  CancelPendingInputRequest,
  CreateSessionRequest,
  DispatchPendingInputRequest,
  EnqueuePendingInputRequest,
  GoalContinuationDecision,
  GoalLoopStrategy,
  OrchestratorEvent,
  OrchestratorGoalRunState,
  OrchestratorRunHandle,
  OrchestratorRunRecord,
  OrchestratorSessionRecord,
  PendingInputRecord,
  PendingInputResult,
  PendingInputStatus,
  RunOutcomeReason,
  RunStatus,
  StartGoalRunRequest,
  StartRunRequest
} from "../types";
import { isTerminalRunStatus, transitionRunStatus } from "../state-machine";
import {
  advanceGoalStallState,
  assessGoalRound,
  createGoalRunState,
  updateGoalState
} from "../goal-continuation";
import {
  EventScanGoalStrategy,
  createDefaultProviderErrorHandler
} from "../event-scan-goal-strategy";
import type { ActiveRun, AgentLoop, RunCompletion } from "./agent-loop";
import {
  AsyncQueue,
  completionFromRuntimeEvent,
  isNonDurableRuntimeDelta,
  isProviderFailureDiagnostic,
  terminalPayload
} from "./agent-loop";

const logger = new Logger({ module: "orchestrator", transports: [createConsoleTransport()] });

export class TaskDispatcher {
  constructor(
    private readonly loop: AgentLoop,
    private readonly options: AgentOrchestratorOptions
  ) {}

  listPendingInputs(sessionId?: string): PendingInputRecord[] {
    return [...this.loop.pendingInputs.values()]
      .filter((input) => input.status === "pending" && (!sessionId || input.sessionId === sessionId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async enqueuePendingInput(request: EnqueuePendingInputRequest): Promise<PendingInputResult> {
    const session = this.loop.sessions.get(request.sessionId);
    if (!session) {
      throw new SessionError(`Session not found: ${request.sessionId}`, "not_found");
    }

    const text = request.text.trim();
    if (!text) {
      throw new SessionError("Pending input text cannot be empty", "invalid_entry");
    }

    const now = this.loop.now();
    const input = {
      id: request.id ?? this.loop.createId("pending_input"),
      sessionId: request.sessionId,
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      text,
      mode: request.mode ?? "after-current-run",
      status: "pending" as PendingInputStatus,
      createdAt: now,
      updatedAt: now,
      ...(request.source !== undefined ? { source: request.source } : {}),
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    } as PendingInputRecord;
    const event = this.loop.event("pending-input-created", request.sessionId, request.runId, {
      input: toJsonObject(input)
    });
    await this.loop.storeEvent(event);
    this.loop.pendingInputs.set(input.id, input);
    session.updatedAt = now;

    return { input, event };
  }

  async cancelPendingInput(request: CancelPendingInputRequest): Promise<PendingInputResult> {
    const input = this.loop.pendingInputs.get(request.id);
    if (!input || input.status !== "pending") {
      throw new SessionError(`Pending input not found: ${request.id}`, "not_found");
    }
    if (request.sessionId && input.sessionId !== request.sessionId) {
      throw new SessionError(`Pending input ${request.id} does not belong to session ${request.sessionId}`, "invalid_state");
    }

    const updated = this.updatePendingInputStatus(input, "cancelled");
    const event = this.loop.event("pending-input-cancelled", updated.sessionId, updated.runId, {
      input: toJsonObject(updated),
      inputId: updated.id,
      ...(request.reason ? { reason: request.reason } : {})
    });
    await this.loop.storeEvent(event);
    this.loop.pendingInputs.set(updated.id, updated);
    this.loop.sessions.get(updated.sessionId)!.updatedAt = updated.updatedAt;
    return { input: updated, event };
  }

  async dispatchPendingInput(request: DispatchPendingInputRequest): Promise<PendingInputResult> {
    const input = this.loop.pendingInputs.get(request.id);
    if (!input || input.status !== "pending") {
      throw new SessionError(`Pending input not found: ${request.id}`, "not_found");
    }
    if (request.sessionId && input.sessionId !== request.sessionId) {
      throw new SessionError(`Pending input ${request.id} does not belong to session ${request.sessionId}`, "invalid_state");
    }

    const updated = this.updatePendingInputStatus(input, "dispatched", request.targetRunId);
    const event = this.loop.event("pending-input-dispatched", updated.sessionId, request.targetRunId ?? updated.runId, {
      input: toJsonObject(updated),
      inputId: updated.id,
      ...(request.targetRunId ? { targetRunId: request.targetRunId } : {})
    });
    await this.loop.storeEvent(event);
    this.loop.pendingInputs.set(updated.id, updated);
    this.loop.sessions.get(updated.sessionId)!.updatedAt = updated.updatedAt;
    return { input: updated, event };
  }

  async startRun(request: StartRunRequest): Promise<OrchestratorRunHandle> {
    return this.startRunWithDriver(request as StartGoalRunRequest, "task");
  }

  async startGoalRun(request: StartGoalRunRequest): Promise<OrchestratorRunHandle> {
    return this.startRunWithDriver(request, "goal");
  }

  private async startRunWithDriver(request: StartGoalRunRequest, kind: "task" | "goal"): Promise<OrchestratorRunHandle> {
    const session = await this.resolveSession(request);
    const now = this.loop.now();
    const run = {
      id: request.id ?? this.loop.createId("run"),
      sessionId: session.id,
      cwd: request.cwd,
      status: "queued" as RunStatus,
      createdAt: now,
      updatedAt: now,
      ...(kind !== undefined ? { kind } : {}),
      ...(kind === "goal" ? { goal: createGoalRunState({ goal: request.goal, fallbackVisibleGoal: promptSummary(request.input) }) } : {}),
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    } as OrchestratorRunRecord;
    this.loop.runs.set(run.id, run);

    const queue = new AsyncQueue<OrchestratorEvent>();
    const active: ActiveRun = { run, queue, pendingEmits: new BoundedMap<Promise<void>, true>(MAX_ORCHESTRATOR_EVENTS, undefined), emitChain: Promise.resolve(), engine: undefined };
    this.loop.activeRuns.set(run.id, active);

    this.emitToRun(active, "run-queued", { run: toJsonObject(run) });
    (kind === "goal" ? this.driveGoalRun(active, session, request) : this.driveRun(active, session, request));

    return {
      runId: run.id,
      sessionId: session.id,
      events: queue
    };
  }

  cancelRun(runId: string, reason = "cancelled-by-user"): boolean {
    const active = this.loop.activeRuns.get(runId);
    const run = this.loop.runs.get(runId);
    if (!run || !active) return false;
    if (isTerminalRunStatus(run.status)) return false;

    this.updateRun(run, "cancelling");
    active.engine?.abort(reason);
    this.options.getBackgroundCommandManager?.(run.cwd)?.cancelAllForRun(runId);
    this.emitToRun(active, "run-cancel-requested", { reason });
    return true;
  }

  steerRun(runId: string, text: string): boolean {
    const active = this.loop.activeRuns.get(runId);
    if (!active?.engine) return false;
    if (isTerminalRunStatus(active.run.status)) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    const message = {
      id: this.loop.createId("user"),
      role: "user",
      createdAt: this.loop.now(),
      blocks: [{ type: "text", text: trimmed }],
    } as AgentMessage;
    active.engine.enqueueSteerInput(message);
    return true;
  }

  isRunActive(runId: string): boolean {
    const active = this.loop.activeRuns.get(runId);
    return Boolean(active?.engine && !isTerminalRunStatus(active.run.status));
  }

  private async driveRun(active: ActiveRun, session: OrchestratorSessionRecord, request: StartRunRequest): Promise<void> {
    const run = active.run;
    try {
      const engine = await this.options.createRunEngine({ runId: run.id, session, run });
      active.engine = engine;
      if (active.persistenceFailed) return;
      this.updateRun(run, "running", { startedAt: this.loop.now() });
      this.emitToRun(active, "run-started", { run: toJsonObject(run) });

      for await (const runtimeEvent of engine.run(request.input)) {
        if (active.persistenceFailed) break;
        this.applyRuntimeEventStatus(active, runtimeEvent);
        this.emitToRun(active, "runtime-event", {
          event: toJsonObject(runtimeEvent)
        });
        await this.waitForPendingEmits(active);
      }

      if (!active.persistenceFailed && !isTerminalRunStatus(run.status)) {
        const completion = run.status === "cancelling" ? cancelledCompletion("cancelled") : completedCompletion();
        this.updateRun(run, completion.status, {
          finishedAt: this.loop.now(),
          outcome: completion.outcome,
          reason: completion.reason,
          ...(completion.outcomeDetail !== undefined ? { outcomeDetail: completion.outcomeDetail } : {}),
        });
      }
      if (!active.persistenceFailed) {
        this.emitRunTerminalEvent(active);
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      const completion = run.status === "cancelling" ? cancelledCompletion("cancelled", error) : failedCompletion("run-engine-error", error);
      this.updateRun(run, completion.status, {
        finishedAt: this.loop.now(),
        outcome: completion.outcome,
        reason: completion.reason,
        ...(completion.outcomeDetail !== undefined ? { outcomeDetail: completion.outcomeDetail } : {}),
        ...(completion.error !== undefined ? { error: completion.error } : {}),
      });
      this.emitRunTerminalEvent(active, error);
    } finally {
      await this.waitForPendingEmits(active);
      this.loop.activeRuns.delete(run.id);
      active.queue.close();
    }
  }

  private async driveGoalRun(active: ActiveRun, session: OrchestratorSessionRecord, request: StartGoalRunRequest): Promise<void> {
    const run = active.run;
    const strategy = request.goalLoopStrategy
      ?? this.options.defaultGoalLoopStrategy
      ?? new EventScanGoalStrategy();
    const maxTransientProviderErrors = Math.max(6, Math.ceil((requiredGoal(run).maxRounds) * 0.75));
    const providerBackoffMs = this.options.providerRateLimitBackoffMs ?? 90_000;
    const handleProviderError = strategy.handleProviderError
      ?? createDefaultProviderErrorHandler({ maxTransientErrors: maxTransientProviderErrors, backoffMs: providerBackoffMs });
    let currentPrompt = request.input;
    let consecutiveTransientProviderErrors = 0;

    try {
      this.updateRun(run, "running", { startedAt: this.loop.now() });
      this.updateRunGoal(run, updateGoalState(requiredGoal(run), { status: "running" }));
      this.emitToRun(active, "run-started", { run: toJsonObject(run) });

      while (!isTerminalRunStatus(run.status)) {
        if (active.persistenceFailed) break;
        if (hasRunStatus(run, "cancelling")) break;
        const goal = requiredGoal(run);
        if (goal.completedRounds >= goal.maxRounds) {
          this.completeGoalRun(active, blockedCompletion("goal-max-rounds", `Goal reached the maximum round limit: ${goal.maxRounds}`), {
            status: "blocked",
            stoppedReason: "max-rounds"
          });
          break;
        }

        const roundIndex = goal.completedRounds;
        this.updateRunGoal(
          run,
          updateGoalState(goal, {
            status: "running",
            currentRound: roundIndex
          })
        );
        this.emitToRun(active, "goal-round-started", {
          run: toJsonObject(run),
          round: { index: roundIndex }
        });

        const { events: roundEvents, roundContext } = await this.driveGoalRound(active, session, currentPrompt, strategy);
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
            this.completeGoalRun(active, completion, { status: "failed", stoppedReason: "error" });
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

        this.updateRunGoal(
          run,
          updateGoalState(requiredGoal(run), {
            completedRounds: roundIndex + 1
          })
        );
        this.emitToRun(active, "goal-round-completed", {
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
        this.updateRunGoal(run, nextGoal);
        this.emitToRun(active, "goal-continuation-decided", {
          run: toJsonObject(run),
          decision: toJsonObject(decisionWithSignature),
          assessment: toJsonObject(assessment),
          round: { index: roundIndex }
        });

        const goalCompletion = completionFromGoalDecision(decisionWithSignature, requiredGoal(run));
        if (goalCompletion) {
          this.completeGoalRun(active, goalCompletion.completion, goalCompletion.goalPatch);
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
        this.completeGoalRun(active, completion, {
          status: completion.outcome === "cancelled" ? "cancelled" : "blocked",
          stoppedReason: completion.outcome === "cancelled" ? "cancelled" : "max-rounds"
        });
      } else if (!active.persistenceFailed) {
        this.finalizeGoalFromTerminalRun(run);
      }

      if (!active.persistenceFailed) {
        this.emitRunTerminalEvent(active);
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      const completion = run.status === "cancelling" ? cancelledCompletion("cancelled", error) : failedCompletion("run-engine-error", error);
      this.completeGoalRun(active, completion, {
        status: completion.outcome === "cancelled" ? "cancelled" : "failed",
        stoppedReason: completion.outcome === "cancelled" ? "cancelled" : "error"
      });
      this.emitRunTerminalEvent(active, error);
    } finally {
      await this.waitForPendingEmits(active);
      this.loop.activeRuns.delete(run.id);
      active.queue.close();
    }
  }

  private async driveGoalRound(
    active: ActiveRun,
    session: OrchestratorSessionRecord,
    prompt: StartRunRequest["input"],
    strategy: GoalLoopStrategy
  ): Promise<{ events: AgentEvent[]; roundContext: unknown | undefined }> {
    const run = active.run;
    const engine = await this.options.createRunEngine({ runId: run.id, session, run });
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
        this.applyRuntimeEventStatus(active, runtimeEvent, { agentStopCompletes: false });
        this.emitToRun(active, "runtime-event", {
          event: toJsonObject(runtimeEvent)
        });
        await this.waitForPendingEmits(active);
      }
      return { events, roundContext };
    } finally {
      if (active.engine === engine) {
        active.engine = undefined;
      }
    }
  }

  private async resolveSession(request: StartRunRequest): Promise<OrchestratorSessionRecord> {
    if (request.sessionId) {
      const existing = this.loop.sessions.get(request.sessionId);
      if (existing) {
        existing.updatedAt = this.loop.now();
        existing.cwd = request.cwd;
        existing.metadata = compactJsonObject({
          ...(existing.metadata ?? {}),
          ...sessionMetadataFromRunRequest(request)
        });
        return existing;
      }
    }
    return await this.loop.createSession({
      ...(request.sessionId !== undefined ? { id: request.sessionId } : {}),
      cwd: request.cwd,
      metadata: sessionMetadataFromRunRequest(request)
    } as unknown as CreateSessionRequest);
  }

  private applyRuntimeEventStatus(
    active: ActiveRun,
    runtimeEvent: AgentEvent,
    options: { agentStopCompletes?: boolean } = {}
  ): RunCompletion | undefined {
    const run = active.run;
    if (isTerminalRunStatus(run.status)) return undefined;

    if (runtimeEvent.type === "approval-requested") {
      this.updateRun(run, "awaiting-approval", {
        reason: "awaiting-approval",
        outcomeDetail: toJsonObject(runtimeEvent.request) as JsonObject,
      });
      return undefined;
    }
    if (runtimeEvent.type === "approval-resolved" && run.status === "awaiting-approval") {
      this.updateRun(run, "running", {});
      return undefined;
    }

    if (runtimeEvent.type === "provider-diagnostic" && isProviderFailureDiagnostic(runtimeEvent.diagnostic)) {
      active.lastProviderFailure = toJsonObject(runtimeEvent.diagnostic);
      return undefined;
    }

    const completion = completionFromRuntimeEvent(runtimeEvent, active.lastProviderFailure, {
      agentStopCompletes: options.agentStopCompletes ?? true
    });
    if (completion) {
      this.updateRun(run, completion.status, {
        finishedAt: this.loop.now(),
        outcome: completion.outcome,
        reason: completion.reason,
        ...(completion.outcomeDetail !== undefined ? { outcomeDetail: completion.outcomeDetail } : {}),
        ...(completion.error !== undefined ? { error: completion.error } : {}),
      });
    }
    return completion;
  }

  private updateRun(
    run: OrchestratorRunRecord,
    status: RunStatus,
    extra: Partial<
      Pick<OrchestratorRunRecord, "startedAt" | "finishedAt" | "outcome" | "reason" | "outcomeDetail" | "error">
    > = {}
  ): void {
    run.status = transitionRunStatus(run.status, status);
    run.updatedAt = this.loop.now();
    applyRunPatch(run, extra);
  }

  private updateRunGoal(run: OrchestratorRunRecord, goal: OrchestratorGoalRunState): void {
    run.goal = goal;
    run.updatedAt = this.loop.now();
  }

  private completeGoalRun(
    active: ActiveRun,
    completion: RunCompletion,
    goalPatch: Partial<OrchestratorGoalRunState>
  ): void {
    const run = active.run;
    this.updateRunGoal(run, updateGoalState(requiredGoal(run), goalPatch));
    this.updateRun(run, completion.status, {
      finishedAt: this.loop.now(),
      outcome: completion.outcome,
      reason: completion.reason,
      ...(completion.outcomeDetail !== undefined ? { outcomeDetail: completion.outcomeDetail } : {}),
      ...(completion.error ? { error: completion.error } : {})
    });
  }

  private finalizeGoalFromTerminalRun(run: OrchestratorRunRecord): void {
    if (!run.goal) return;
    if (run.goal.status !== "running" && run.goal.status !== "queued") return;
    if (run.status === "cancelled") {
      this.updateRunGoal(run, updateGoalState(run.goal, { status: "cancelled", stoppedReason: "cancelled" }));
      return;
    }
    if (run.outcome === "blocked") {
      this.updateRunGoal(run, updateGoalState(run.goal, { status: "blocked", stoppedReason: goalStoppedReasonFromRun(run) }));
      return;
    }
    if (run.status === "failed") {
      this.updateRunGoal(run, updateGoalState(run.goal, { status: "failed", stoppedReason: "error" }));
      return;
    }
    if (run.status === "completed") {
      this.updateRunGoal(run, updateGoalState(run.goal, { status: "completed", stoppedReason: "complete" }));
    }
  }

  private emitRunTerminalEvent(active: ActiveRun, error?: string): void {
    const run = active.run;
    if (run.status === "cancelled") {
      this.emitToRun(active, "run-cancelled", terminalPayload(run, error));
      return;
    }
    if (run.status === "failed") {
      this.emitToRun(active, "run-failed", terminalPayload(run, error));
      return;
    }
    if (run.status === "completed") {
      this.emitToRun(active, "run-completed", terminalPayload(run));
      return;
    }
    throw new ProtocolError(`Run ${run.id} ended with non-terminal status ${run.status}`, "INVALID_RUN_STATE");
  }

  private emitToRun(active: ActiveRun, type: OrchestratorEvent["type"], payload: JsonObject): void {
    let event: OrchestratorEvent;
    try {
      event = this.loop.event(type, active.run.sessionId, active.run.id, payload);
    } catch (cause) {
      logger.warn(
        `[Orchestrator] Failed to serialize ${type} event for run ${active.run.id}:`,
        { err: { message: cause instanceof Error ? cause.message : String(cause) } }
      );
      this.loop.pushDiagnostic({
        code: "EVENT_SERIALIZATION_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        severity: "warning",
        detail: { eventType: type, runId: active.run.id },
      });
      return;
    }
    const task = active.emitChain.then(() => this.persistAndBroadcast(active, event));
    active.emitChain = task.catch(() => undefined);
    void task.then(() => {
      active.pendingEmits.delete(task);
    }, () => {
      active.pendingEmits.delete(task);
    });
    active.pendingEmits.set(task, true);
  }

  private async persistAndBroadcast(active: ActiveRun, event: OrchestratorEvent): Promise<void> {
    if (event.type === "runtime-event") {
      const runtimeEvent = event.payload?.event as { type: string } | undefined;
      if (runtimeEvent && isNonDurableRuntimeDelta(runtimeEvent)) {
        active.queue.push(event);
        return;
      }
    }
    try {
      await this.loop.storeEvent(event);
    } catch (cause) {
      this.failRunForPersistenceFailure(active, event, cause);
      return;
    }
    if (active.persistenceFailed && event.type !== "run-failed") {
      return;
    }
    active.run.lastEventId = event.id;
    active.queue.push(event);
  }

  private failRunForPersistenceFailure(active: ActiveRun, failedEvent: OrchestratorEvent, cause: unknown): void {
    const run = active.run;
    if (active.persistenceFailed) return;
    active.persistenceFailed = true;

    const message = eventStoreFailureMessage(cause);
    const detail = eventStoreFailureDetail(failedEvent, cause);
    if (run.goal) {
      this.updateRunGoal(
        run,
        updateGoalState(run.goal, {
          status: "failed",
          stoppedReason: "error"
        })
      );
    }
    if (isTerminalRunStatus(run.status)) {
      run.status = "failed";
      run.updatedAt = this.loop.now();
      applyRunPatch(run, {
        finishedAt: this.loop.now(),
        outcome: "failed",
        reason: "event-store-write-failed",
        outcomeDetail: detail,
        error: message
      });
    } else {
      this.updateRun(run, "failed", {
        finishedAt: this.loop.now(),
        outcome: "failed",
        reason: "event-store-write-failed",
        outcomeDetail: detail,
        error: message
      });
    }
    active.engine?.abort("event-store-write-failed");

    const event = this.loop.event("run-failed", run.sessionId, run.id, terminalPayload(run, message));
    active.run.lastEventId = event.id;
    active.queue.push(event);
  }

  private async waitForPendingEmits(active: ActiveRun): Promise<void> {
    while (active.pendingEmits.size > 0) {
      const first = active.pendingEmits.keys()[0];
      if (first) await first.catch(() => undefined);
    }
  }

  private updatePendingInputStatus(
    input: PendingInputRecord,
    status: Exclude<PendingInputRecord["status"], "pending">,
    runId?: string
  ): PendingInputRecord {
    return {
      ...input,
      ...(runId ? { runId } : {}),
      status,
      updatedAt: this.loop.now()
    };
  }
}

function completedCompletion(): RunCompletion {
  return {
    status: "completed",
    outcome: "completed",
    reason: "completed",
    outcomeDetail: undefined,
    error: undefined
  };
}

function cancelledCompletion(reason: Extract<RunOutcomeReason, "cancelled" | "aborted">, error?: string): RunCompletion {
  return {
    status: "cancelled",
    outcome: "cancelled",
    reason,
    error: error ?? undefined,
    outcomeDetail: undefined
  };
}

function failedCompletion(reason: Extract<RunOutcomeReason, "agent-error" | "provider-error" | "runtime-error" | "max-turns" | "intervention-required" | "run-engine-error" | "event-store-write-failed">, error?: string, outcomeDetail?: JsonObject): RunCompletion {
  return {
    status: "failed",
    outcome: "failed",
    reason,
    error: error ?? undefined,
    outcomeDetail: outcomeDetail ?? undefined
  };
}

function blockedCompletion(
  reason: Extract<RunOutcomeReason, "goal-blocked" | "goal-max-rounds" | "goal-stalled">,
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

function completionFromGoalDecision(
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

function goalDecisionDetail(decision: GoalContinuationDecision): JsonObject {
  return compactJsonObject({
    action: decision.action,
    reason: decision.reason,
    prompt: decision.prompt,
    progressSignature: decision.progressSignature,
    detail: decision.detail
  });
}

function hasRunStatus(run: OrchestratorRunRecord, status: RunStatus): boolean {
  return run.status === status;
}

function goalStoppedReasonFromRun(run: OrchestratorRunRecord): NonNullable<OrchestratorGoalRunState["stoppedReason"]> {
  if (run.reason === "goal-max-rounds") return "max-rounds";
  if (run.reason === "goal-stalled") return "stalled";
  if (run.reason === "cancelled" || run.reason === "aborted") return "cancelled";
  if (run.reason === "goal-completed") return "complete";
  if (run.outcome === "failed") return "error";
  return "blocked";
}

function requiredGoal(run: OrchestratorRunRecord): OrchestratorGoalRunState {
  if (!run.goal) {
    throw new ProtocolError(`Run ${run.id} is not a goal run`, "NOT_A_GOAL_RUN");
  }
  return run.goal;
}

function sessionMetadataFromRunRequest(request: StartRunRequest): JsonObject | undefined {
  const metadata = compactJsonObject({
    workspaceMode: stringMetadata(request.metadata, "workspaceMode"),
    projectRoot: stringMetadata(request.metadata, "projectRoot"),
    workspaceRoot: stringMetadata(request.metadata, "workspaceRoot")
  });
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function stringMetadata(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function promptSummary(input: StartRunRequest["input"]): string {
  if (typeof input === "string") return trimPromptSummary(input);
  const textBlocks = input.blocks
    .filter((block): block is Extract<(typeof input.blocks)[number], { type: "text" | "thought" }> => block.type === "text" || block.type === "thought")
    .map((block) => block.text)
    .join("\n");
  return trimPromptSummary(textBlocks || input.id);
}

function trimPromptSummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Goal";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function applyRunPatch(
  run: OrchestratorRunRecord,
  patch: Partial<Pick<OrchestratorRunRecord, "startedAt" | "finishedAt" | "outcome" | "reason" | "outcomeDetail" | "error">>
): void {
  for (const [key, value] of Object.entries(patch) as Array<[keyof typeof patch, unknown]>) {
    (run as unknown as Record<string, unknown>)[key] = value;
  }
}

function eventStoreFailureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function eventStoreFailureDetail(failedEvent: OrchestratorEvent, cause: unknown): JsonObject {
  return compactJsonObject({
    kind: "event-store-write-failed",
    failedEventId: failedEvent.id,
    failedEventType: failedEvent.type,
    failedSequence: failedEvent.sequence,
    error: eventStoreFailureMessage(cause)
  });
}
