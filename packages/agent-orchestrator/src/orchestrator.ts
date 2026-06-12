import type { JsonObject, AgentEvent, AgentMessage, DiagnosticRecord } from "@crish/shared-types";
import { compactJsonObject, isRecord, clone } from "@crish/shared-utils";
import {
  ORCHESTRATOR_PROTOCOL_VERSION,
  type AgentOrchestratorOptions,
  type CancelPendingInputRequest,
  type CreateSessionRequest,
  type DispatchPendingInputRequest,
  type EnqueuePendingInputRequest,
  type GoalContinuationDecision,
  type GoalLoopStrategy,
  type MoveSessionLeafRequest,
  type MoveSessionLeafResult,
  type OrchestratorEvent,
  type OrchestratorEventLogMetadata,
  type OrchestratorEventReadOptions,
  type OrchestratorEventStore,
  type OrchestratorGoalRunState,
  type OrchestratorRunHandle,
  type OrchestratorRunRecord,
  type OrchestratorSessionEventSummary,
  type OrchestratorSessionRecord,
  type PendingInputRecord,
  type PendingInputResult,
  type ProviderErrorResult,
  type RecordConversationRewindAuditRequest,
  type RecordConversationRewindAuditResult,
  type RunOutcome,
  type RunOutcomeReason,
  type RunEngine,
  type RunStatus,
  type StartGoalRunRequest,
  type StartRunRequest
} from "./types";
import { isTerminalRunStatus, transitionRunStatus } from "./state-machine";
import {
  advanceGoalStallState,
  assessGoalRound,
  createGoalRunState,
  defaultGoalContinuationDecider,
  updateGoalState
} from "./goal-continuation";
import {
  EventScanGoalStrategy,
  createDefaultProviderErrorHandler
} from "./event-scan-goal-strategy";
import { summarizeOrchestratorSessionEvents } from "./session-summary";

export class AgentOrchestrator {
  private readonly sessions = new Map<string, OrchestratorSessionRecord>();
  private readonly runs = new Map<string, OrchestratorRunRecord>();
  private readonly pendingInputs = new Map<string, PendingInputRecord>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly eventStore: OrchestratorEventStore;
  private sequence = 0;

  /**
   * 持久化写入失败的诊断记录。
   *
   * 当 storeEvent 写入失败时，错误信息会被推入此数组，
   * 外部可通过 diagnostics() 查询。
   */
  private readonly diagnosticsRing: DiagnosticRecord[] = new Array(100);
  private diagCursor = 0;

  constructor(private readonly options: AgentOrchestratorOptions) {
    this.eventStore = options.eventStore ?? new InMemoryOrchestratorEventStore();
  }

  async createSession(request: CreateSessionRequest): Promise<OrchestratorSessionRecord> {
    const now = this.now();
    const session: OrchestratorSessionRecord = {
      id: request.id ?? this.createId("session"),
      cwd: request.cwd,
      createdAt: now,
      updatedAt: now,
      status: "open",
      metadata: request.metadata
    };
    await this.storeEvent(
      this.event("session-created", session.id, undefined, {
        session: session as unknown as JsonObject
      })
    );
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): OrchestratorSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): OrchestratorSessionRecord[] {
    return [...this.sessions.values()];
  }

  listPendingInputs(sessionId?: string): PendingInputRecord[] {
    return [...this.pendingInputs.values()]
      .filter((input) => input.status === "pending" && (!sessionId || input.sessionId === sessionId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async enqueuePendingInput(request: EnqueuePendingInputRequest): Promise<PendingInputResult> {
    const session = this.sessions.get(request.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${request.sessionId}`);
    }

    const text = request.text.trim();
    if (!text) {
      throw new Error("Pending input text cannot be empty");
    }

    const now = this.now();
    const input: PendingInputRecord = {
      id: request.id ?? this.createId("pending_input"),
      sessionId: request.sessionId,
      ...(request.runId ? { runId: request.runId } : {}),
      text,
      mode: request.mode ?? "after-current-run",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      source: request.source ?? "workbench",
      ...(request.metadata ? { metadata: request.metadata } : {})
    };
    const event = this.event("pending-input-created", request.sessionId, request.runId, {
      input: input as unknown as JsonObject
    });
    await this.storeEvent(event);
    this.pendingInputs.set(input.id, input);
    session.updatedAt = now;

    // steer 模式：将输入写入事件存储，运行时通过 readPendingInputs 轮询
    // 运行时在 preparing-turn 阶段调用 readPendingInputs 回调获取此输入
    return { input, event };
  }

  async cancelPendingInput(request: CancelPendingInputRequest): Promise<PendingInputResult> {
    const input = this.pendingInputs.get(request.id);
    if (!input || input.status !== "pending") {
      throw new Error(`Pending input not found: ${request.id}`);
    }
    if (request.sessionId && input.sessionId !== request.sessionId) {
      throw new Error(`Pending input ${request.id} does not belong to session ${request.sessionId}`);
    }

    const updated = this.updatePendingInputStatus(input, "cancelled");
    const event = this.event("pending-input-cancelled", updated.sessionId, updated.runId, {
      input: updated as unknown as JsonObject,
      inputId: updated.id,
      ...(request.reason ? { reason: request.reason } : {})
    });
    await this.storeEvent(event);
    this.pendingInputs.set(updated.id, updated);
    this.sessions.get(updated.sessionId)!.updatedAt = updated.updatedAt;
    return { input: updated, event };
  }

  async dispatchPendingInput(request: DispatchPendingInputRequest): Promise<PendingInputResult> {
    const input = this.pendingInputs.get(request.id);
    if (!input || input.status !== "pending") {
      throw new Error(`Pending input not found: ${request.id}`);
    }
    if (request.sessionId && input.sessionId !== request.sessionId) {
      throw new Error(`Pending input ${request.id} does not belong to session ${request.sessionId}`);
    }

    const updated = this.updatePendingInputStatus(input, "dispatched", request.targetRunId);
    const event = this.event("pending-input-dispatched", updated.sessionId, request.targetRunId ?? updated.runId, {
      input: updated as unknown as JsonObject,
      inputId: updated.id,
      ...(request.targetRunId ? { targetRunId: request.targetRunId } : {})
    });
    await this.storeEvent(event);
    this.pendingInputs.set(updated.id, updated);
    this.sessions.get(updated.sessionId)!.updatedAt = updated.updatedAt;
    return { input: updated, event };
  }

  async listSessionSummaries(): Promise<OrchestratorSessionEventSummary[]> {
    if (this.eventStore.listSessionSummaries) {
      return this.eventStore.listSessionSummaries();
    }
    return summarizeOrchestratorSessionEvents(await this.readAllEvents());
  }

  async moveSessionLeaf(request: MoveSessionLeafRequest): Promise<MoveSessionLeafResult> {
    const session = this.sessions.get(request.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${request.sessionId}`);
    }

    const fromLeafId = session.currentLeafId;
    if (request.expectedCurrentLeafId !== undefined && fromLeafId !== request.expectedCurrentLeafId) {
      throw new Error(
        `Session ${request.sessionId} current leaf mismatch: expected ${request.expectedCurrentLeafId}, got ${fromLeafId ?? "none"}`
      );
    }

    if (fromLeafId === request.targetLeafId) {
      return {
        session,
        fromLeafId: fromLeafId ?? null,
        toLeafId: request.targetLeafId,
        changed: false
      };
    }

    const updatedSession: OrchestratorSessionRecord = {
      ...session,
      updatedAt: this.now()
    };
    if (request.targetLeafId === null) {
      delete updatedSession.currentLeafId;
    } else {
      updatedSession.currentLeafId = request.targetLeafId;
    }
    const event = this.event("session-leaf-moved", updatedSession.id, undefined, {
      session: updatedSession as unknown as JsonObject,
      fromLeafId: fromLeafId ?? null,
      toLeafId: request.targetLeafId,
      ...(request.reason ? { reason: request.reason } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {})
    });

    await this.storeEvent(event);
    this.sessions.set(updatedSession.id, updatedSession);
    return {
      session: updatedSession,
      fromLeafId: fromLeafId ?? null,
      toLeafId: request.targetLeafId,
      event,
      changed: true
    };
  }

  async recordConversationRewindAudit(
    request: RecordConversationRewindAuditRequest
  ): Promise<RecordConversationRewindAuditResult> {
    if (!this.sessions.has(request.sessionId)) {
      throw new Error(`Session not found: ${request.sessionId}`);
    }

    const event = this.event("conversation-rewind-audit", request.sessionId, undefined, request.payload);
    await this.storeEvent(event);
    return { event };
  }

  getRun(runId: string): OrchestratorRunRecord | undefined {
    return this.runs.get(runId);
  }

  listRuns(sessionId?: string): OrchestratorRunRecord[] {
    return [...this.runs.values()].filter((run) => !sessionId || run.sessionId === sessionId);
  }

  async startRun(request: StartRunRequest): Promise<OrchestratorRunHandle> {
    return this.startRunWithDriver(request, "task");
  }

  async startGoalRun(request: StartGoalRunRequest): Promise<OrchestratorRunHandle> {
    return this.startRunWithDriver(request, "goal");
  }

  private async startRunWithDriver(request: StartGoalRunRequest, kind: "task" | "goal"): Promise<OrchestratorRunHandle> {
    const session = await this.resolveSession(request);
    const now = this.now();
    const run: OrchestratorRunRecord = {
      id: request.id ?? this.createId("run"),
      sessionId: session.id,
      cwd: request.cwd,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      kind,
      ...(kind === "goal"
        ? {
            goal: createGoalRunState({
              goal: request.goal,
              fallbackVisibleGoal: promptSummary(request.input)
            })
          }
        : {}),
      metadata: request.metadata
    };
    this.runs.set(run.id, run);

    const queue = new AsyncQueue<OrchestratorEvent>();
    const active: ActiveRun = { run, queue, pendingEmits: new Set() };
    this.activeRuns.set(run.id, active);

    this.emitToRun(active, "run-queued", { run: run as unknown as JsonObject });
    void (kind === "goal" ? this.driveGoalRun(active, session, request) : this.driveRun(active, session, request));

    return {
      runId: run.id,
      sessionId: session.id,
      events: queue
    };
  }

  cancelRun(runId: string, reason = "cancelled-by-user"): boolean {
    const active = this.activeRuns.get(runId);
    const run = this.runs.get(runId);
    if (!run || !active) return false;
    if (isTerminalRunStatus(run.status)) return false;

    this.updateRun(run, "cancelling");
    active.engine?.abort(reason);
    this.emitToRun(active, "run-cancel-requested", { reason });
    return true;
  }

  async readSessionEvents(sessionId: string, afterSequence?: number, options?: OrchestratorEventReadOptions): Promise<OrchestratorEvent[]> {
    return this.eventStore.readSession(sessionId, afterSequence, options);
  }

  async readRunEvents(runId: string, afterSequence?: number, options?: OrchestratorEventReadOptions): Promise<OrchestratorEvent[]> {
    if (this.eventStore.readRun) {
      return this.eventStore.readRun(runId, afterSequence, options);
    }
    const run = this.runs.get(runId);
    if (!run) return [];
    const events = await this.eventStore.readSession(run.sessionId, afterSequence);
    return collectEvents(events, (event) => event.runId === runId, options?.maxEvents);
  }

  async getEventLogMetadata(): Promise<OrchestratorEventLogMetadata> {
    if (this.eventStore.getMetadata) {
      return this.eventStore.getMetadata();
    }
    return inMemoryEventLogMetadata();
  }

  async restoreFromEventStore(): Promise<void> {
    const events = await this.readAllEvents();
    let maxSequence = this.sequence;

    const replayStates = new Map<string, RestoredRunReplayState>();
    for (const event of events) {
      maxSequence = Math.max(maxSequence, event.sequence);
      this.applyStoredEvent(event, replayStates);
    }

    this.sequence = maxSequence;
    await this.interruptRestoredActiveRuns();
  }

  private async driveRun(active: ActiveRun, session: OrchestratorSessionRecord, request: StartRunRequest): Promise<void> {
    const run = active.run;
    try {
      const engine = await this.options.createRunEngine({ runId: run.id, session, run });
      active.engine = engine;
      if (active.persistenceFailed) return;
      this.updateRun(run, "running", { startedAt: this.now() });
      this.emitToRun(active, "run-started", { run: run as unknown as JsonObject });

      for await (const runtimeEvent of engine.run(request.input)) {
        if (active.persistenceFailed) break;
        this.applyRuntimeEventStatus(active, runtimeEvent);
        this.emitToRun(active, "runtime-event", {
          event: runtimeEvent as unknown as JsonObject
        });
      }

      if (!active.persistenceFailed && !isTerminalRunStatus(run.status)) {
        const completion = run.status === "cancelling" ? cancelledCompletion("cancelled") : completedCompletion();
        this.updateRun(run, completion.status, {
          finishedAt: this.now(),
          outcome: completion.outcome,
          reason: completion.reason,
          outcomeDetail: completion.outcomeDetail
        });
      }
      if (!active.persistenceFailed) {
        this.emitRunTerminalEvent(active);
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      const completion = run.status === "cancelling" ? cancelledCompletion("cancelled", error) : failedCompletion("run-engine-error", error);
      this.updateRun(run, completion.status, {
        finishedAt: this.now(),
        outcome: completion.outcome,
        reason: completion.reason,
        outcomeDetail: completion.outcomeDetail,
        error
      });
      this.emitRunTerminalEvent(active, error);
    } finally {
      await this.waitForPendingEmits(active);
      this.activeRuns.delete(run.id);
      active.queue.close();
    }
  }

  private async driveGoalRun(active: ActiveRun, session: OrchestratorSessionRecord, request: StartGoalRunRequest): Promise<void> {
    const run = active.run;
    const strategy = request.goalLoopStrategy
      ?? this.options.defaultGoalLoopStrategy
      ?? new EventScanGoalStrategy();
    const decideGoalContinuation = this.options.decideGoalContinuation ?? defaultGoalContinuationDecider;
    const maxTransientProviderErrors = Math.max(6, Math.ceil((requiredGoal(run).maxRounds) * 0.75));
    const providerBackoffMs = this.options.providerRateLimitBackoffMs ?? 90_000;
    const handleProviderError = strategy.handleProviderError
      ?? createDefaultProviderErrorHandler({ maxTransientErrors: maxTransientProviderErrors, backoffMs: providerBackoffMs });
    let currentPrompt = request.input;
    let consecutiveTransientProviderErrors = 0;

    try {
      this.updateRun(run, "running", { startedAt: this.now() });
      this.updateRunGoal(run, updateGoalState(requiredGoal(run), { status: "running" }));
      this.emitToRun(active, "run-started", { run: run as unknown as JsonObject });

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
          run: run as unknown as JsonObject,
          round: { index: roundIndex }
        });

        const { events: roundEvents, roundContext } = await this.driveGoalRound(active, session, currentPrompt, strategy);
        if (isTerminalRunStatus(run.status)) break;

        this.updateRunGoal(
          run,
          updateGoalState(requiredGoal(run), {
            completedRounds: roundIndex + 1
          })
        );
        this.emitToRun(active, "goal-round-completed", {
          run: run as unknown as JsonObject,
          round: { index: roundIndex, eventCount: roundEvents.length }
        });

        if (hasRunStatus(run, "cancelling")) break;

        // -- Provider error handling (unified for all strategies) --
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
            if (providerError.action === "retry") {
              // Retry the same round without incrementing completedRounds
              continue;
            }
            // backoff: continue to next round (which will retry with the same prompt)
            continue;
          }
        }
        consecutiveTransientProviderErrors = 0;

        // -- Strategy-based assessment and continuation --
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
          run: run as unknown as JsonObject,
          decision: decisionWithSignature as unknown as JsonObject,
          assessment: assessment as unknown as JsonObject,
          round: { index: roundIndex }
        });

        const goalCompletion = completionFromGoalDecision(decisionWithSignature, requiredGoal(run));
        if (goalCompletion) {
          this.completeGoalRun(active, goalCompletion.completion, goalCompletion.goalPatch);
          break;
        }

        // -- Build next prompt (strategy may enrich it) --
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
      this.activeRuns.delete(run.id);
      active.queue.close();
    }
  }

  private async driveGoalRound(
    active: ActiveRun,
    session: OrchestratorSessionRecord,
    prompt: StartRunRequest["input"],
    strategy: GoalLoopStrategy
  ): Promise<{ events: AgentEvent[]; roundContext?: unknown }> {
    const run = active.run;
    const engine = await this.options.createRunEngine({ runId: run.id, session, run });
    active.engine = engine;
    const events: AgentEvent[] = [];
    let roundContext: unknown;
    try {
      for await (const runtimeEvent of engine.run(prompt)) {
        if (active.persistenceFailed) break;
        events.push(runtimeEvent);
        if (strategy.onRoundEvent) {
          roundContext = strategy.onRoundEvent(runtimeEvent, roundContext);
        }
        this.applyRuntimeEventStatus(active, runtimeEvent, { agentStopCompletes: false });
        this.emitToRun(active, "runtime-event", {
          event: runtimeEvent as unknown as JsonObject
        });
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
      const existing = this.sessions.get(request.sessionId);
      if (existing) {
        existing.updatedAt = this.now();
        existing.cwd = request.cwd;
        existing.metadata = compactJsonObject({
          ...(existing.metadata ?? {}),
          ...sessionMetadataFromRunRequest(request)
        });
        return existing;
      }
    }
    return await this.createSession({
      id: request.sessionId,
      cwd: request.cwd,
      metadata: sessionMetadataFromRunRequest(request)
    });
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
        outcomeDetail: runtimeEvent.request as unknown as JsonObject
      });
      return undefined;
    }
    if (runtimeEvent.type === "approval-resolved" && run.status === "awaiting-approval") {
      this.updateRun(run, "running", { reason: undefined, outcomeDetail: undefined });
      return undefined;
    }

    if (runtimeEvent.type === "provider-diagnostic" && isProviderFailureDiagnostic(runtimeEvent.diagnostic)) {
      active.lastProviderFailure = runtimeEvent.diagnostic as unknown as JsonObject;
      return undefined;
    }

    const completion = completionFromRuntimeEvent(runtimeEvent, active.lastProviderFailure, {
      agentStopCompletes: options.agentStopCompletes ?? true
    });
    if (completion) {
      this.updateRun(run, completion.status, {
        finishedAt: this.now(),
        outcome: completion.outcome,
        reason: completion.reason,
        outcomeDetail: completion.outcomeDetail,
        ...(completion.error ? { error: completion.error } : {})
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
    run.updatedAt = this.now();
    applyRunPatch(run, extra);
  }

  private updateRunGoal(run: OrchestratorRunRecord, goal: OrchestratorGoalRunState): void {
    run.goal = goal;
    run.updatedAt = this.now();
  }

  private completeGoalRun(
    active: ActiveRun,
    completion: RunCompletion,
    goalPatch: Partial<OrchestratorGoalRunState>
  ): void {
    const run = active.run;
    this.updateRunGoal(run, updateGoalState(requiredGoal(run), goalPatch));
    this.updateRun(run, completion.status, {
      finishedAt: this.now(),
      outcome: completion.outcome,
      reason: completion.reason,
      outcomeDetail: completion.outcomeDetail,
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
    throw new Error(`Run ${run.id} ended with non-terminal status ${run.status}`);
  }

  private emitToRun(active: ActiveRun, type: OrchestratorEvent["type"], payload: JsonObject): void {
    let event: OrchestratorEvent;
    try {
      event = this.event(type, active.run.sessionId, active.run.id, payload);
    } catch (cause) {
      // Serialization failure (e.g., DataCloneError from non-serializable tool functions).
      // Log and skip the event rather than crashing the entire run.
      console.warn(
        `[Orchestrator] Failed to serialize ${type} event for run ${active.run.id}:`,
        cause instanceof Error ? cause.message : String(cause)
      );
      this.pushDiagnostic({
        code: "EVENT_SERIALIZATION_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        severity: "warning",
        detail: { eventType: type, runId: active.run.id },
      });
      return;
    }
    const task = this.persistAndBroadcast(active, event).finally(() => {
      active.pendingEmits.delete(task);
    });
    active.pendingEmits.add(task);
  }

  private async persistAndBroadcast(active: ActiveRun, event: OrchestratorEvent): Promise<void> {
    try {
      await this.storeEvent(event);
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
      run.updatedAt = this.now();
      applyRunPatch(run, {
        finishedAt: this.now(),
        outcome: "failed",
        reason: "event-store-write-failed",
        outcomeDetail: detail,
        error: message
      });
    } else {
      this.updateRun(run, "failed", {
        finishedAt: this.now(),
        outcome: "failed",
        reason: "event-store-write-failed",
        outcomeDetail: detail,
        error: message
      });
    }
    active.engine?.abort("event-store-write-failed");

    const event = this.event("run-failed", run.sessionId, run.id, terminalPayload(run, message));
    active.run.lastEventId = event.id;
    active.queue.push(event);
  }

  private async waitForPendingEmits(active: ActiveRun): Promise<void> {
    while (active.pendingEmits.size > 0) {
      await Promise.allSettled([...active.pendingEmits]);
    }
  }

  private event(type: OrchestratorEvent["type"], sessionId: string, runId: string | undefined, payload: JsonObject): OrchestratorEvent {
    return {
      protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
      id: this.createId("event"),
      sequence: ++this.sequence,
      type,
      sessionId,
      ...(runId ? { runId } : {}),
      timestamp: this.now(),
      payload: clone(payload)
    };
  }

  private async storeEvent(event: OrchestratorEvent): Promise<void> {
    try {
      await this.eventStore.append(event);
    } catch (cause) {
      this.pushDiagnostic({
        code: "EVENT_STORE_WRITE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        severity: "error",
        detail: { eventId: event.id, eventType: event.type, timestamp: event.timestamp },
      });
      throw cause;
    }
  }

  private pushDiagnostic(record: DiagnosticRecord): void {
    this.diagnosticsRing[this.diagCursor % 100] = record;
    this.diagCursor++;
  }

  getRecentDiagnostics(): DiagnosticRecord[] {
    const count = Math.min(this.diagCursor, 100);
    const result: DiagnosticRecord[] = [];
    for (let i = 0; i < count; i++) {
      const idx = (this.diagCursor - count + i) % 100;
      if (this.diagnosticsRing[idx]) result.push(this.diagnosticsRing[idx]);
    }
    return result;
  }

  async readAllEvents(afterSequence?: number, options?: OrchestratorEventReadOptions): Promise<OrchestratorEvent[]> {
    if (!this.eventStore.readAll) return [];
    return this.eventStore.readAll(afterSequence, options);
  }

  private applyStoredEvent(event: OrchestratorEvent, replayStates: Map<string, RestoredRunReplayState>): void {
    const restoredSession = sessionRecordFromPayload(event);
    if (restoredSession) {
      this.sessions.set(restoredSession.id, restoredSession);
    }

    const session = this.sessions.get(event.sessionId);
    if (session && event.timestamp > session.updatedAt) {
      session.updatedAt = event.timestamp;
    }

    const restoredRun = runRecordFromPayload(event);
    if (restoredRun) {
      this.runs.set(restoredRun.id, restoredRun);
    }

    this.applyStoredPendingInputEvent(event);

    if (!event.runId) return;

    const run = this.runs.get(event.runId);
    if (!run) return;

    run.lastEventId = event.id;
    if (event.timestamp > run.updatedAt) {
      run.updatedAt = event.timestamp;
    }
    if (event.type === "run-cancel-requested" && !isTerminalRunStatus(run.status)) {
      run.status = "cancelling";
    }
    if (event.type === "runtime-event" && !isTerminalRunStatus(run.status)) {
      applyStoredRuntimeEventStatus(run, event, replayStateForRun(replayStates, run.id));
    }
  }

  private applyStoredPendingInputEvent(event: OrchestratorEvent): void {
    if (
      event.type !== "pending-input-created" &&
      event.type !== "pending-input-cancelled" &&
      event.type !== "pending-input-dispatched"
    ) {
      return;
    }
    const input = pendingInputRecordFromPayload(event.payload.input, event);
    if (!input) return;
    this.pendingInputs.set(input.id, input);
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
      updatedAt: this.now()
    };
  }

  private async interruptRestoredActiveRuns(): Promise<void> {
    for (const run of this.runs.values()) {
      if (isTerminalRunStatus(run.status) || this.activeRuns.has(run.id)) continue;

      const previousStatus = run.status;
      const previousReason = run.reason;
      const previousOutcomeDetail = run.outcomeDetail;
      const completion = interruptedCompletion(previousStatus, previousReason, previousOutcomeDetail);
      if (run.goal) {
        this.updateRunGoal(
          run,
          updateGoalState(run.goal, {
            status: completion.status === "cancelled" ? "cancelled" : "failed",
            stoppedReason: completion.status === "cancelled" ? "cancelled" : "error"
          })
        );
      }
      this.updateRun(run, completion.status, {
        finishedAt: this.now(),
        outcome: completion.outcome,
        reason: completion.reason,
        outcomeDetail: completion.outcomeDetail,
        error: completion.error
      });

      const event = this.event(completion.status === "cancelled" ? "run-cancelled" : "run-failed", run.sessionId, run.id, terminalPayload(run));
      run.lastEventId = event.id;
      await this.storeEvent(event);
    }
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private createId(prefix: string): string {
    if (this.options.createId) return this.options.createId(prefix);
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }
}

export class InMemoryOrchestratorEventStore implements OrchestratorEventStore {
  private readonly events: OrchestratorEvent[] = [];
  private readonly metadata = inMemoryEventLogMetadata();

  append(event: OrchestratorEvent): void {
    this.events.push(event);
  }

  getMetadata(): OrchestratorEventLogMetadata {
    return this.metadata;
  }

  listSessionSummaries(): OrchestratorSessionEventSummary[] {
    return summarizeOrchestratorSessionEvents(this.events);
  }

  readAll(afterSequence = 0, options: OrchestratorEventReadOptions = {}): OrchestratorEvent[] {
    return collectEvents(this.events, (event) => event.sequence > afterSequence, options.maxEvents);
  }

  readSession(sessionId: string, afterSequence = 0, options: OrchestratorEventReadOptions = {}): OrchestratorEvent[] {
    return collectEvents(
      this.events,
      (event) => event.sessionId === sessionId && event.sequence > afterSequence,
      options.maxEvents
    );
  }

  readRun(runId: string, afterSequence = 0, options: OrchestratorEventReadOptions = {}): OrchestratorEvent[] {
    return collectEvents(this.events, (event) => event.runId === runId && event.sequence > afterSequence, options.maxEvents);
  }
}

function collectEvents(
  events: OrchestratorEvent[],
  predicate: (event: OrchestratorEvent) => boolean,
  maxEvents?: number
): OrchestratorEvent[] {
  const collected: OrchestratorEvent[] = [];
  for (const event of events) {
    if (!predicate(event)) continue;
    collected.push(event);
    if (maxEvents !== undefined && collected.length >= maxEvents) break;
  }
  return collected;
}

function inMemoryEventLogMetadata(): OrchestratorEventLogMetadata {
  return {
    eventLogId: "in-memory",
    generation: 1,
    schemaVersion: 1,
    protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION
  };
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

function replayStateForRun(states: Map<string, RestoredRunReplayState>, runId: string): RestoredRunReplayState {
  const existing = states.get(runId);
  if (existing) return existing;
  const created: RestoredRunReplayState = {};
  states.set(runId, created);
  return created;
}

function applyStoredRuntimeEventStatus(
  run: OrchestratorRunRecord,
  event: OrchestratorEvent,
  replayState: RestoredRunReplayState
): void {
  const runtimeEvent = event.payload.event;
  if (!isRecord(runtimeEvent) || typeof runtimeEvent.type !== "string") return;

  if (run.status !== "cancelling" && runtimeEvent.type === "approval-requested" && isRecord(runtimeEvent.request)) {
    run.status = "awaiting-approval";
    run.reason = "awaiting-approval";
    run.outcomeDetail = runtimeEvent.request as JsonObject;
    return;
  }

  if (run.status !== "cancelling" && runtimeEvent.type === "approval-resolved" && run.status === "awaiting-approval") {
    run.status = "running";
    delete run.reason;
    delete run.outcomeDetail;
    return;
  }

  if (
    runtimeEvent.type === "provider-diagnostic" &&
    isStoredProviderDiagnostic(runtimeEvent.diagnostic) &&
    isProviderFailureDiagnostic(runtimeEvent.diagnostic)
  ) {
    replayState.lastProviderFailure = runtimeEvent.diagnostic as unknown as JsonObject;
    return;
  }

  const completion = completionFromRuntimeEvent(runtimeEvent as AgentEvent, replayState.lastProviderFailure, {
    agentStopCompletes: run.kind !== "goal" && run.status !== "cancelling"
  });
  if (!completion) return;

  run.status = completion.status;
  run.finishedAt = event.timestamp;
  run.outcome = completion.outcome;
  run.reason = completion.reason;
  run.updatedAt = event.timestamp;
  applyRunPatch(run, {
    outcomeDetail: completion.outcomeDetail,
    error: completion.error
  });
  applyStoredTerminalGoalStatus(run, completion);
}

function applyStoredTerminalGoalStatus(run: OrchestratorRunRecord, completion: RunCompletion): void {
  if (!run.goal) return;
  if (completion.status === "cancelled") {
    run.goal = updateGoalState(run.goal, { status: "cancelled", stoppedReason: "cancelled" });
    return;
  }
  if (completion.status === "failed") {
    run.goal = updateGoalState(run.goal, { status: "failed", stoppedReason: "error" });
    return;
  }
  if (completion.status === "completed") {
    run.goal = updateGoalState(run.goal, { status: "completed", stoppedReason: "complete" });
  }
}

function sessionRecordFromPayload(event: OrchestratorEvent): OrchestratorSessionRecord | undefined {
  const value = event.payload.session;
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isSessionStatus(value.status)
  ) {
    return undefined;
  }

  return {
    id: value.id,
    cwd: value.cwd,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    status: value.status,
    ...(typeof value.currentLeafId === "string" ? { currentLeafId: value.currentLeafId } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata as JsonObject } : {})
  };
}

interface RunCompletion {
  status: Extract<RunStatus, "completed" | "cancelled" | "failed">;
  outcome: RunOutcome;
  reason: RunOutcomeReason;
  outcomeDetail?: JsonObject;
  error?: string;
}

function completedCompletion(): RunCompletion {
  return {
    status: "completed",
    outcome: "completed",
    reason: "completed"
  };
}

function cancelledCompletion(reason: Extract<RunOutcomeReason, "cancelled" | "aborted">, error?: string): RunCompletion {
  return {
    status: "cancelled",
    outcome: "cancelled",
    reason,
    ...(error ? { error } : {})
  };
}

function interruptedCompletion(
  previousStatus: RunStatus,
  previousReason?: RunOutcomeReason,
  previousOutcomeDetail?: JsonObject
): RunCompletion {
  const outcomeDetail = compactJsonObject({
    kind: "interrupted",
    reason: "daemon-restarted",
    previousStatus,
    previousReason,
    previousOutcomeDetail
  });
  if (previousStatus === "cancelling") {
    return {
      status: "cancelled",
      outcome: "cancelled",
      reason: "daemon-restarted",
      outcomeDetail,
      error: "Run cancellation was interrupted by daemon restart."
    };
  }
  return {
    status: "failed",
    outcome: "failed",
    reason: "daemon-restarted",
    outcomeDetail,
    error: "Run was interrupted by daemon restart."
  };
}

function failedCompletion(reason: Extract<RunOutcomeReason, "agent-error" | "provider-error" | "runtime-error" | "max-turns" | "intervention-required" | "run-engine-error" | "event-store-write-failed">, error?: string, outcomeDetail?: JsonObject): RunCompletion {
  return {
    status: "failed",
    outcome: "failed",
    reason,
    ...(error ? { error } : {}),
    ...(outcomeDetail ? { outcomeDetail } : {})
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
    ...(outcomeDetail ? { outcomeDetail } : {})
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
        outcomeDetail: goalDecisionDetail(decision)
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

function completionFromRuntimeEvent(
  runtimeEvent: AgentEvent,
  lastProviderFailure?: JsonObject,
  options: { agentStopCompletes?: boolean } = {}
): RunCompletion | undefined {
  if (runtimeEvent.type === "agent-end") {
    if (runtimeEvent.reason === "stop") {
      return options.agentStopCompletes === false ? undefined : completedCompletion();
    }
    if (runtimeEvent.reason === "aborted") {
      return cancelledCompletion("aborted", runtimeEvent.error);
    }
    if (runtimeEvent.reason === "max-turns") {
      return failedCompletion("max-turns", runtimeEvent.error ?? "Run reached the maximum turn limit", eventDetail(runtimeEvent));
    }
    return failedCompletion("agent-error", runtimeEvent.error ?? "Agent ended with an error", eventDetail(runtimeEvent));
  }

  if (runtimeEvent.type === "runtime-error") {
    const reason = lastProviderFailure ? "provider-error" : "runtime-error";
    return failedCompletion(reason, runtimeEvent.error, compactJsonObject({ event: runtimeEvent, providerDiagnostic: lastProviderFailure }));
  }

  if (runtimeEvent.type === "runtime-intervention-required") {
    return failedCompletion("intervention-required", runtimeEvent.message, eventDetail(runtimeEvent));
  }

  return undefined;
}

function isProviderFailureDiagnostic(diagnostic: Extract<AgentEvent, { type: "provider-diagnostic" }>["diagnostic"]): boolean {
  return diagnostic.phase === "request-error" || (typeof diagnostic.status === "number" && diagnostic.status >= 400);
}

function isStoredProviderDiagnostic(value: unknown): value is Extract<AgentEvent, { type: "provider-diagnostic" }>["diagnostic"] {
  return isRecord(value) && typeof value.phase === "string";
}

function terminalPayload(run: OrchestratorRunRecord, error?: string): JsonObject {
  return compactJsonObject({
    run,
    outcome: run.outcome,
    reason: run.reason,
    outcomeDetail: run.outcomeDetail,
    error: error ?? run.error
  });
}

function requiredGoal(run: OrchestratorRunRecord): OrchestratorGoalRunState {
  if (!run.goal) {
    throw new Error(`Run ${run.id} is not a goal run`);
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

function eventDetail(event: AgentEvent): JsonObject {
  return event as unknown as JsonObject;
}

function applyRunPatch(
  run: OrchestratorRunRecord,
  patch: Partial<Pick<OrchestratorRunRecord, "startedAt" | "finishedAt" | "outcome" | "reason" | "outcomeDetail" | "error">>
): void {
  for (const [key, value] of Object.entries(patch) as Array<[keyof typeof patch, unknown]>) {
    if (value === undefined) {
      delete run[key];
    } else {
      run[key] = value as never;
    }
  }
}

function runRecordFromPayload(event: OrchestratorEvent): OrchestratorRunRecord | undefined {
  const value = event.payload.run;
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.cwd !== "string" ||
    !isRunStatus(value.status) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }

  return {
    id: value.id,
    sessionId: value.sessionId,
    cwd: value.cwd,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.finishedAt === "string" ? { finishedAt: value.finishedAt } : {}),
    ...(isRunOutcome(value.outcome) ? { outcome: value.outcome } : {}),
    ...(isRunOutcomeReason(value.reason) ? { reason: value.reason } : {}),
    ...(isRecord(value.outcomeDetail) ? { outcomeDetail: value.outcomeDetail as JsonObject } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(isRunKind(value.kind) ? { kind: value.kind } : {}),
    ...(isGoalRunState(value.goal) ? { goal: value.goal } : {}),
    ...(typeof value.lastEventId === "string" ? { lastEventId: value.lastEventId } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata as JsonObject } : {})
  };
}

function pendingInputRecordFromPayload(value: unknown, event: OrchestratorEvent): PendingInputRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.text !== "string" ||
    !isPendingInputMode(value.mode) ||
    !isPendingInputStatus(value.status) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }

  return {
    id: value.id,
    sessionId: value.sessionId,
    ...(typeof value.runId === "string" ? { runId: value.runId } : event.runId ? { runId: event.runId } : {}),
    text: value.text,
    mode: value.mode,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.source === "workbench" || value.source === "daemon" || value.source === "automation" ? { source: value.source } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata as JsonObject } : {})
  };
}

function isPendingInputMode(value: unknown): value is PendingInputRecord["mode"] {
  return value === "after-current-run" || value === "steer";
}

function isPendingInputStatus(value: unknown): value is PendingInputRecord["status"] {
  return value === "pending" || value === "cancelled" || value === "dispatched";
}

function isSessionStatus(value: unknown): value is OrchestratorSessionRecord["status"] {
  return value === "open" || value === "closed" || value === "archived";
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "awaiting-approval" ||
    value === "cancelling" ||
    value === "cancelled" ||
    value === "completed" ||
    value === "failed"
  );
}

function isRunOutcome(value: unknown): value is RunOutcome {
  return value === "completed" || value === "blocked" || value === "cancelled" || value === "failed";
}

function isRunOutcomeReason(value: unknown): value is RunOutcomeReason {
  return (
    value === "completed" ||
    value === "cancelled" ||
    value === "aborted" ||
    value === "daemon-restarted" ||
    value === "goal-completed" ||
    value === "goal-blocked" ||
    value === "goal-max-rounds" ||
    value === "goal-stalled" ||
    value === "max-turns" ||
    value === "agent-error" ||
    value === "provider-error" ||
    value === "runtime-error" ||
    value === "intervention-required" ||
    value === "event-store-write-failed" ||
    value === "awaiting-approval" ||
    value === "run-engine-error"
  );
}

function isRunKind(value: unknown): value is OrchestratorRunRecord["kind"] {
  return value === "task" || value === "goal";
}

function isGoalRunState(value: unknown): value is OrchestratorGoalRunState {
  if (!isRecord(value)) return false;
  return (
    isGoalStatus(value.status) &&
    typeof value.maxRounds === "number" &&
    Number.isFinite(value.maxRounds) &&
    typeof value.maxStalledRounds === "number" &&
    Number.isFinite(value.maxStalledRounds) &&
    typeof value.currentRound === "number" &&
    Number.isFinite(value.currentRound) &&
    typeof value.completedRounds === "number" &&
    Number.isFinite(value.completedRounds) &&
    typeof value.stalledRounds === "number" &&
    Number.isFinite(value.stalledRounds) &&
    (value.visibleGoal === undefined || typeof value.visibleGoal === "string") &&
    (value.stoppedReason === undefined || isGoalStoppedReason(value.stoppedReason)) &&
    (value.lastProgressSignature === undefined || typeof value.lastProgressSignature === "string") &&
    (value.lastDecision === undefined || isGoalDecision(value.lastDecision))
  );
}

function isGoalStatus(value: unknown): value is OrchestratorGoalRunState["status"] {
  return value === "queued" || value === "running" || value === "completed" || value === "blocked" || value === "cancelled" || value === "failed";
}

function isGoalStoppedReason(value: unknown): value is NonNullable<OrchestratorGoalRunState["stoppedReason"]> {
  return value === "complete" || value === "blocked" || value === "max-rounds" || value === "stalled" || value === "cancelled" || value === "error";
}

function isGoalDecision(value: unknown): value is GoalContinuationDecision {
  if (!isRecord(value)) return false;
  return (
    (value.action === "continue" || value.action === "complete" || value.action === "block") &&
    typeof value.reason === "string" &&
    (value.prompt === undefined || typeof value.prompt === "string") &&
    (value.progressSignature === undefined || typeof value.progressSignature === "string") &&
    (value.detail === undefined || isRecord(value.detail))
  );
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

interface ActiveRun {
  run: OrchestratorRunRecord;
  queue: AsyncQueue<OrchestratorEvent>;
  pendingEmits: Set<Promise<void>>;
  engine?: RunEngine;
  lastProviderFailure?: JsonObject;
  persistenceFailed?: boolean;
}

interface RestoredRunReplayState {
  lastProviderFailure?: JsonObject;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next()
    };
  }

  private next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
