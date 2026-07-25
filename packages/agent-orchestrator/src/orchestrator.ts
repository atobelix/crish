import type { JsonObject, AgentEvent, AgentMessage, DiagnosticRecord } from "@crish/shared-types";
import { SessionError, ProtocolError } from "@crish/shared-types";
import {
  compactJsonObject, isRecord, BoundedMap, RingBuffer, toJsonObject,
  MAX_ORCHESTRATOR_SESSIONS, MAX_ORCHESTRATOR_RUNS, MAX_ORCHESTRATOR_PENDING_INPUTS, MAX_ORCHESTRATOR_DIAGNOSTICS, MAX_ORCHESTRATOR_EVENTS,
  Logger, createConsoleTransport,
} from "@crish/shared-utils";
import { pluginRegistry } from "@crish/agent-runtime/plugin-registry";
import { asStateSnapshotStore, type OrchestratorStateSnapshot } from "./state-snapshot";
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
  type PendingInputStatus,
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
  updateGoalState
} from "./goal-continuation";
import {
  EventScanGoalStrategy,
  createDefaultProviderErrorHandler
} from "./event-scan-goal-strategy";
import { summarizeOrchestratorSessionEvents } from "./session-summary";

const logger = new Logger({ module: "orchestrator", transports: [createConsoleTransport()] });

export class AgentOrchestrator {
  private readonly sessions = new BoundedMap<string, OrchestratorSessionRecord>(MAX_ORCHESTRATOR_SESSIONS, undefined);
  private readonly runs = new BoundedMap<string, OrchestratorRunRecord>(MAX_ORCHESTRATOR_RUNS, undefined);
  private readonly pendingInputs = new BoundedMap<string, PendingInputRecord>(MAX_ORCHESTRATOR_PENDING_INPUTS, undefined);
  private readonly activeRuns = new BoundedMap<string, ActiveRun>(MAX_ORCHESTRATOR_RUNS, (_key, active) => {
    active.engine?.abort('active-runs-capacity-exceeded');
  });
  private readonly eventStore: OrchestratorEventStore;
  private sequence = 0;

  /**
   * 鎸佷箙鍖栧啓鍏ュけ璐ョ殑璇婃柇璁板綍銆?   *
   * 褰?storeEvent 鍐欏叆澶辫触鏃讹紝閿欒淇℃伅浼氳鎺ㄥ叆姝ゆ暟缁勶紝
   * 澶栭儴鍙€氳繃 diagnostics() 鏌ヨ銆?   */
  private readonly diagnosticsRing: (DiagnosticRecord | undefined)[] = new Array(MAX_ORCHESTRATOR_DIAGNOSTICS);
  private diagCursor = 0;
  private lastRestoreMode: "full-replay" | "snapshot-incremental" | "unknown" = "unknown";

  constructor(private readonly options: AgentOrchestratorOptions) {
    this.eventStore = options.eventStore ?? new InMemoryOrchestratorEventStore();
  }

  async createSession(request: CreateSessionRequest): Promise<OrchestratorSessionRecord> {
    const now = this.now();
    const session = {
      id: request.id ?? this.createId("session"),
      cwd: request.cwd,
      createdAt: now,
      updatedAt: now,
      status: "open",
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    } as OrchestratorSessionRecord;
    await this.storeEvent(
      this.event("session-created", session.id, undefined, {
        session: toJsonObject(session)
      })
    );
    this.sessions.set(session.id, session);
    await this.notifySessionStart(session.id);
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
      throw new SessionError(`Session not found: ${request.sessionId}`, "not_found");
    }

    const text = request.text.trim();
    if (!text) {
      throw new SessionError("Pending input text cannot be empty", "invalid_entry");
    }

    const now = this.now();
    const input = {
      id: request.id ?? this.createId("pending_input"),
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
    const event = this.event("pending-input-created", request.sessionId, request.runId, {
      input: toJsonObject(input)
    });
    await this.storeEvent(event);
    this.pendingInputs.set(input.id, input);
    session.updatedAt = now;

    // steer 妯″紡锛氬皢杈撳叆鍐欏叆浜嬩欢瀛樺偍锛岃繍琛屾椂閫氳繃 readPendingInputs 杞
    // 杩愯鏃跺湪 preparing-turn 闃舵璋冪敤 readPendingInputs 鍥炶皟鑾峰彇姝よ緭鍏?
    return { input, event };
  }

  async cancelPendingInput(request: CancelPendingInputRequest): Promise<PendingInputResult> {
    const input = this.pendingInputs.get(request.id);
    if (!input || input.status !== "pending") {
      throw new SessionError(`Pending input not found: ${request.id}`, "not_found");
    }
    if (request.sessionId && input.sessionId !== request.sessionId) {
      throw new SessionError(`Pending input ${request.id} does not belong to session ${request.sessionId}`, "invalid_state");
    }

    const updated = this.updatePendingInputStatus(input, "cancelled");
    const event = this.event("pending-input-cancelled", updated.sessionId, updated.runId, {
      input: toJsonObject(updated),
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
      throw new SessionError(`Pending input not found: ${request.id}`, "not_found");
    }
    if (request.sessionId && input.sessionId !== request.sessionId) {
      throw new SessionError(`Pending input ${request.id} does not belong to session ${request.sessionId}`, "invalid_state");
    }

    const updated = this.updatePendingInputStatus(input, "dispatched", request.targetRunId);
    const event = this.event("pending-input-dispatched", updated.sessionId, request.targetRunId ?? updated.runId, {
      input: toJsonObject(updated),
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
      throw new SessionError(`Session not found: ${request.sessionId}`, "not_found");
    }

    const fromLeafId = session.currentLeafId;
    if (request.expectedCurrentLeafId !== undefined && fromLeafId !== request.expectedCurrentLeafId) {
      throw new ProtocolError(
        `Session ${request.sessionId} current leaf mismatch: expected ${request.expectedCurrentLeafId}, got ${fromLeafId ?? "none"}`,
        "LEAF_MISMATCH"
      );
    }

    if (fromLeafId === request.targetLeafId) {
      return {
        session,
        fromLeafId: fromLeafId ?? null,
        toLeafId: request.targetLeafId,
        changed: false,
      } as MoveSessionLeafResult;
    }

    const updatedSession: OrchestratorSessionRecord = {
      ...session,
      updatedAt: this.now()
    };
    if (request.targetLeafId != null) updatedSession.currentLeafId = request.targetLeafId;
    const event = this.event("session-leaf-moved", updatedSession.id, undefined, {
      session: toJsonObject(updatedSession),
      fromLeafId: fromLeafId as string,
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
      ...(event !== undefined ? { event } : {}),
      changed: true
    } as MoveSessionLeafResult;
  }

  async recordConversationRewindAudit(
    request: RecordConversationRewindAuditRequest
  ): Promise<RecordConversationRewindAuditResult> {
    if (!this.sessions.has(request.sessionId)) {
      throw new SessionError(`Session not found: ${request.sessionId}`, "not_found");
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

  /**
   * 杩斿洖闈炵粓鎬侊紙queued / running / awaiting-approval / cancelling锛塺un 鐨勬暟閲忋€?   *
   * 渚涜疆璇㈠満鏅紙濡?waitForActiveRunsToSettle銆乨aemon 鐩戞帶锛夐伩鍏?listRuns()
   * 鍒涘缓鏁扮粍鍓湰鍐?filter 鐨勫紑閿€銆侭oundedMap.values() 浠嶆槸鏁扮粍鎷疯礉锛屼絾璺宠繃浜?   * 璋冪敤鏂圭殑浜屾杩囨护鍒嗛厤銆俿essionId 鍙€夛紝鐢ㄤ簬闄愬畾浣滅敤鍩熴€?   */
  countActiveRuns(sessionId?: string): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (isTerminalRunStatus(run.status)) continue;
      if (sessionId && run.sessionId !== sessionId) continue;
      count++;
    }
    return count;
  }

  async startRun(request: StartRunRequest): Promise<OrchestratorRunHandle> {
    return this.startRunWithDriver(request as StartGoalRunRequest, "task");
  }

  async startGoalRun(request: StartGoalRunRequest): Promise<OrchestratorRunHandle> {
    return this.startRunWithDriver(request, "goal");
  }

  private async startRunWithDriver(request: StartGoalRunRequest, kind: "task" | "goal"): Promise<OrchestratorRunHandle> {
    const session = await this.resolveSession(request);
    const now = this.now();
    const run = {
      id: request.id ?? this.createId("run"),
      sessionId: session.id,
      cwd: request.cwd,
      status: "queued" as RunStatus,
      createdAt: now,
      updatedAt: now,
      ...(kind !== undefined ? { kind } : {}),
      ...(kind === "goal" ? { goal: createGoalRunState({ goal: request.goal, fallbackVisibleGoal: promptSummary(request.input) }) } : {}),
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    } as OrchestratorRunRecord;
    this.runs.set(run.id, run);

    const queue = new AsyncQueue<OrchestratorEvent>();
    const active: ActiveRun = { run, queue, pendingEmits: new BoundedMap<Promise<void>, true>(MAX_ORCHESTRATOR_EVENTS, undefined), emitChain: Promise.resolve(), engine: undefined };
    this.activeRuns.set(run.id, active);

    this.emitToRun(active, "run-queued", { run: toJsonObject(run) });
    (kind === "goal" ? this.driveGoalRun(active, session, request) : this.driveRun(active, session, request));

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
    this.options.getBackgroundCommandManager?.(run.cwd)?.cancelAllForRun(runId);
    this.emitToRun(active, "run-cancel-requested", { reason });
    return true;
  }

  /**
   * 鍚戞鍦ㄨ繍琛岀殑 run 娉ㄥ叆鐢ㄦ埛娑堟伅锛坰teer锛夈€?   * 渚涘瓙 agent 缁亰锛歴end-to-subagent 鈫?姝ゅ enqueueSteerInput銆?   */
  steerRun(runId: string, text: string): boolean {
    const active = this.activeRuns.get(runId);
    if (!active?.engine) return false;
    if (isTerminalRunStatus(active.run.status)) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    const message = {
      id: this.createId("user"),
      role: "user",
      createdAt: this.now(),
      blocks: [{ type: "text", text: trimmed }],
    } as AgentMessage;
    active.engine.enqueueSteerInput(message);
    return true;
  }

  /** 娲昏穬 run 鏄惁瀛樺湪锛堝惈 engine锛?*/
  isRunActive(runId: string): boolean {
    const active = this.activeRuns.get(runId);
    return Boolean(active?.engine && !isTerminalRunStatus(active.run.status));
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

  getLastRestoreMode(): string {
    return this.lastRestoreMode;
  }

  async persistStateSnapshot(): Promise<void> {
    const snapshotStore = asStateSnapshotStore(this.eventStore);
    if (!snapshotStore) {
      throw new Error("Event store does not support state snapshots");
    }
    const metadata = await this.getEventLogMetadata();
    const snapshot: OrchestratorStateSnapshot = {
      type: "orchestrator-state-snapshot",
      schemaVersion: 1,
      eventLogId: metadata.eventLogId,
      generation: metadata.generation,
      lastSequence: this.sequence,
      writtenAt: this.now(),
      sessions: this.listSessions(),
      runs: this.listRuns(),
      pendingInputs: [...this.pendingInputs.values()],
    };
    await snapshotStore.writeStateSnapshot(snapshot);
  }

  async getEventLogMetadata(): Promise<OrchestratorEventLogMetadata> {
    if (this.eventStore.getMetadata) {
      return this.eventStore.getMetadata();
    }
    return inMemoryEventLogMetadata();
  }

  async restoreFromEventStore(): Promise<void> {
    let afterSequence = 0;
    let snapshot: OrchestratorStateSnapshot | null = null;
    const snapshotStore = asStateSnapshotStore(this.eventStore);
    if (snapshotStore) {
      snapshot = await snapshotStore.loadStateSnapshot();
    }
    if (snapshot) {
      for (const session of snapshot.sessions) {
        this.sessions.set(session.id, session);
      }
      for (const run of snapshot.runs) {
        this.runs.set(run.id, run);
      }
      for (const input of snapshot.pendingInputs) {
        this.pendingInputs.set(input.id, input);
      }
      afterSequence = snapshot.lastSequence;
      this.sequence = snapshot.lastSequence;
      this.lastRestoreMode = "snapshot-incremental";
    } else {
      this.lastRestoreMode = "full-replay";
    }

    const replayStates = new BoundedMap<string, RestoredRunReplayState>(MAX_ORCHESTRATOR_SESSIONS, undefined);
    const stream = streamingEventIterable(this.eventStore, afterSequence);
    if (stream) {
      for await (const event of stream) {
        this.sequence = Math.max(this.sequence, event.sequence);
        this.applyStoredEvent(event, replayStates);
      }
    } else {
      const events = await this.readAllEvents();
      for (const event of events) {
        if (event.sequence <= afterSequence) continue;
        this.sequence = Math.max(this.sequence, event.sequence);
        this.applyStoredEvent(event, replayStates);
      }
    }

    await this.interruptRestoredActiveRuns();
  }

  private async driveRun(active: ActiveRun, session: OrchestratorSessionRecord, request: StartRunRequest): Promise<void> {
    const run = active.run;
    try {
      const engine = await this.options.createRunEngine({ runId: run.id, session, run });
      active.engine = engine;
      if (active.persistenceFailed) return;
      this.updateRun(run, "running", { startedAt: this.now() });
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
          finishedAt: this.now(),
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
        finishedAt: this.now(),
        outcome: completion.outcome,
        reason: completion.reason,
        ...(completion.outcomeDetail !== undefined ? { outcomeDetail: completion.outcomeDetail } : {}),
        ...(completion.error !== undefined ? { error: completion.error } : {}),
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
    const maxTransientProviderErrors = Math.max(6, Math.ceil((requiredGoal(run).maxRounds) * 0.75));
    const providerBackoffMs = this.options.providerRateLimitBackoffMs ?? 90_000;
    const handleProviderError = strategy.handleProviderError
      ?? createDefaultProviderErrorHandler({ maxTransientErrors: maxTransientProviderErrors, backoffMs: providerBackoffMs });
    let currentPrompt = request.input;
    let consecutiveTransientProviderErrors = 0;

    try {
      this.updateRun(run, "running", { startedAt: this.now() });
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
            continue;
          }
        }
        consecutiveTransientProviderErrors = 0;

        // Productive round: emit completion event
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

  private async notifySessionStart(sessionId: string): Promise<void> {
    for (const plugin of pluginRegistry.list()) {
      const api = pluginRegistry.get(plugin.name);
      if (api?.onSessionStart) {
        try {
          await api.onSessionStart(sessionId);
        } catch (e) {
          logger.error(`[Plugin] ${plugin.name}.onSessionStart error:`, { err: { message: e instanceof Error ? e.message : String(e) } });
        }
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
        finishedAt: this.now(),
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
      event = this.event(type, active.run.sessionId, active.run.id, payload);
    } catch (cause) {
      // Serialization failure (e.g., DataCloneError from non-serializable tool functions).
      // Log and skip the event rather than crashing the entire run.
      logger.warn(
        `[Orchestrator] Failed to serialize ${type} event for run ${active.run.id}:`,
        { err: { message: cause instanceof Error ? cause.message : String(cause) } }
      );
      this.pushDiagnostic({
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
    // Non-durable runtime deltas skip event-store persistence.
    if (event.type === "runtime-event") {
      const runtimeEvent = event.payload?.event as { type: string } | undefined;
      if (runtimeEvent && isNonDurableRuntimeDelta(runtimeEvent)) {
        active.queue.push(event);
        return;
      }
    }
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
      const first = active.pendingEmits.keys()[0];
      if (first) await first.catch(() => undefined);
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
      payload: {
        ...payload,
        ...(payload.run && typeof payload.run === "object" ? { run: { ...payload.run } } : {})
      }
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
    this.diagnosticsRing[this.diagCursor % MAX_ORCHESTRATOR_DIAGNOSTICS] = record;
    this.diagCursor++;
  }

  getRecentDiagnostics(): DiagnosticRecord[] {
    const count = Math.min(this.diagCursor, MAX_ORCHESTRATOR_DIAGNOSTICS);
    const result: DiagnosticRecord[] = [];
    for (let i = 0; i < count; i++) {
      const idx = (this.diagCursor - count + i) % MAX_ORCHESTRATOR_DIAGNOSTICS;
      if (this.diagnosticsRing[idx]) result.push(this.diagnosticsRing[idx]);
    }
    return result;
  }

  async readAllEvents(afterSequence?: number, options?: OrchestratorEventReadOptions): Promise<OrchestratorEvent[]> {
    if (!this.eventStore.readAll) return [];
    return this.eventStore.readAll(afterSequence, options);
  }

  private applyStoredEvent(event: OrchestratorEvent, replayStates: BoundedMap<string, RestoredRunReplayState>): void {
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
        ...(completion.outcomeDetail !== undefined ? { outcomeDetail: completion.outcomeDetail } : {}),
        ...(completion.error !== undefined ? { error: completion.error } : {}),
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
    if (this.events.length >= MAX_ORCHESTRATOR_EVENTS) {
      this.events.shift();
    }
    this.events.push(event);
  }

  getMetadata(): OrchestratorEventLogMetadata {
    return this.metadata;
  }

  listSessionSummaries(): OrchestratorSessionEventSummary[] {
    return summarizeOrchestratorSessionEvents(this.events);
  }

  readAll(afterSequence = 0, options: OrchestratorEventReadOptions = { maxEvents: undefined }): OrchestratorEvent[] {
    return collectEvents(this.events, (event) => event.sequence > afterSequence, options.maxEvents);
  }

  readSession(sessionId: string, afterSequence = 0, options: OrchestratorEventReadOptions = { maxEvents: undefined }): OrchestratorEvent[] {
    return collectEvents(
      this.events,
      (event) => event.sessionId === sessionId && event.sequence > afterSequence,
      options.maxEvents
    );
  }

  readRun(runId: string, afterSequence = 0, options: OrchestratorEventReadOptions = { maxEvents: undefined }): OrchestratorEvent[] {
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

/**
 * 鎺㈡祴 event store 鏄惁鏀寔娴佸紡璇诲彇銆? *
 * OrchestratorEventStore 鍏叡鎺ュ彛涓嶅寘鍚?readAllStreaming锛堜粎 FileOrchestratorEventStore
 * 绛夊熀浜庢枃浠剁殑瀹炵幇鎻愪緵锛夈€傞€氳繃缁撴瀯鎬ф鏌ユ毚闇茶鏂规硶锛屼娇 restoreFromEventStore 鑳? * 浼樺厛娴佸紡鍥炴斁锛岃€?InMemoryOrchestratorEventStore 绛夊唴瀛樺疄鐜板垯鍥為€€鍒?readAll銆? */
/** Non-durable runtime event types that can skip event-store persistence. */
const NON_DURABLE_DELTA_TYPES = new Set(["message-delta", "thought-delta"]);

export function isNonDurableRuntimeDelta(event: { type: string }): boolean {
  return NON_DURABLE_DELTA_TYPES.has(event.type);
}

function streamingEventIterable(
  store: OrchestratorEventStore,
  afterSequence = 0
): AsyncIterable<OrchestratorEvent> | undefined {
  const candidate = store as { readAllStreaming?: unknown };
  if (typeof candidate.readAllStreaming !== "function") return undefined;
  const invoke = candidate.readAllStreaming as (afterSequence?: number) => AsyncIterable<OrchestratorEvent>;
  return invoke.call(store, afterSequence);
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

function replayStateForRun(states: BoundedMap<string, RestoredRunReplayState>, runId: string): RestoredRunReplayState {
  const existing = states.get(runId);
  if (existing) return existing;
  const created: RestoredRunReplayState = { lastProviderFailure: undefined };
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
    delete (run as unknown as Record<string, unknown>).reason;
    delete (run as unknown as Record<string, unknown>).outcomeDetail;
    return;
  }

  if (
    runtimeEvent.type === "provider-diagnostic" &&
    isStoredProviderDiagnostic(runtimeEvent.diagnostic) &&
    isProviderFailureDiagnostic(runtimeEvent.diagnostic)
  ) {
    replayState.lastProviderFailure = toJsonObject(runtimeEvent.diagnostic);
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
    ...(completion.outcomeDetail !== undefined ? { outcomeDetail: completion.outcomeDetail } : {}),
    ...(completion.error !== undefined ? { error: completion.error } : {}),
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
    ...(isRecord(value.metadata) ? { metadata: value.metadata as JsonObject } : {}),
  };
}

interface RunCompletion {
  status: Extract<RunStatus, "completed" | "cancelled" | "failed">;
  outcome: RunOutcome;
  reason: RunOutcomeReason;
  outcomeDetail: JsonObject | undefined;
  error: string | undefined;
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

function eventDetail(event: AgentEvent): JsonObject {
  return toJsonObject(event);
}

function applyRunPatch(
  run: OrchestratorRunRecord,
  patch: Partial<Pick<OrchestratorRunRecord, "startedAt" | "finishedAt" | "outcome" | "reason" | "outcomeDetail" | "error">>
): void {
  for (const [key, value] of Object.entries(patch) as Array<[keyof typeof patch, unknown]>) {
    (run as unknown as Record<string, unknown>)[key] = value;
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
    ...(isRecord(value.metadata) ? { metadata: value.metadata as JsonObject } : {}),
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
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    text: value.text,
    mode: value.mode,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.source === "workbench" || value.source === "daemon" || value.source === "automation" ? { source: value.source } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata as JsonObject } : {}),
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
  pendingEmits: BoundedMap<Promise<void>, true>;
  emitChain: Promise<void>;
  engine: RunEngine | undefined;
  lastProviderFailure?: JsonObject;
  persistenceFailed?: boolean;
}

interface RestoredRunReplayState {
  lastProviderFailure: JsonObject | undefined;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  // 鍐呴儴浣跨敤 RingBuffer 瀹炵幇 O(1) shift锛堟浛浠?Array.shift 鐨?O(n) 閲嶆帓锛夈€?
  // 闃熷垪鏃犱笂鐣岋細RingBuffer 婊℃椂鑷姩鎵╁锛堜袱鍊嶅閲忥級锛屼繚璇佷笉涓簨浠躲€?
  private buffer = new RingBuffer<T>(256);
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    if (!this.buffer.push(item)) {
      const grown = new RingBuffer<T>(this.buffer.maxCapacity * 2);
      this.buffer.forEach((v) => grown.push(v));
      grown.push(item);
      this.buffer = grown;
    }
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
    const item = this.buffer.shift();
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
