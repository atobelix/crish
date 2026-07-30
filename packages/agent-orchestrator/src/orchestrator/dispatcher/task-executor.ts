import type { JsonObject, AgentEvent, AgentMessage } from "@crish/shared-types";
import { CrishError } from "@crish/shared-types";
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
  OrchestratorEvent,
  OrchestratorGoalRunState,
  OrchestratorRunHandle,
  OrchestratorRunRecord,
  OrchestratorSessionRecord,
  PendingInputRecord,
  PendingInputResult,
  RunOutcomeReason,
  RunStatus,
  StartGoalRunRequest,
  StartRunRequest
} from "../../types";
import { isTerminalRunStatus, transitionRunStatus } from "../../state-machine";
import type { ActiveRun, AgentLoop, RunCompletion } from "../agent-loop";
import {
  AsyncQueue,
  completionFromRuntimeEvent,
  isNonDurableRuntimeDelta,
  isProviderFailureDiagnostic,
  terminalPayload
} from "../agent-loop";
import {
  cancelPendingInput,
  dispatchPendingInput,
  enqueuePendingInput,
  listPendingInputs
} from "./task-queue";
import type { GoalRunDriverContext } from "./goal-executor";
import {
  createGoalRunState,
  driveGoalRun,
  promptSummary
} from "./goal-executor";

const logger = new Logger({ module: "orchestrator", transports: [createConsoleTransport()] });

export class TaskDispatcher {
  private readonly goalCtx: GoalRunDriverContext;

  constructor(
    private readonly loop: AgentLoop,
    private readonly options: AgentOrchestratorOptions
  ) {
    this.goalCtx = {
      loop: this.loop,
      options: this.options,
      updateRun: (run, status, extra) => this.updateRun(run, status, extra),
      updateRunGoal: (run, goal) => this.updateRunGoal(run, goal),
      emitToRun: (active, type, payload) => this.emitToRun(active, type, payload),
      emitRunTerminalEvent: (active, error) => this.emitRunTerminalEvent(active, error),
      applyRuntimeEventStatus: (active, runtimeEvent, options) => this.applyRuntimeEventStatus(active, runtimeEvent, options),
      waitForPendingEmits: (active) => this.waitForPendingEmits(active)
    };
  }

  listPendingInputs(sessionId?: string): PendingInputRecord[] {
    return listPendingInputs(this.loop, sessionId);
  }

  async enqueuePendingInput(request: EnqueuePendingInputRequest): Promise<PendingInputResult> {
    return enqueuePendingInput(this.loop, request);
  }

  async cancelPendingInput(request: CancelPendingInputRequest): Promise<PendingInputResult> {
    return cancelPendingInput(this.loop, request);
  }

  async dispatchPendingInput(request: DispatchPendingInputRequest): Promise<PendingInputResult> {
    return dispatchPendingInput(this.loop, request);
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
    (kind === "goal" ? driveGoalRun(this.goalCtx, active, session, request) : this.driveRun(active, session, request));

    return {
      runId: run.id,
      sessionId: session.id,
      events: queue
    };
  }

  /**
   * 取消 run。
   * - force（默认）：立刻 abort provider + 级联后台任务（L3）
   * - cooperative：优先 ControlBus.requestCooperativeStop，不立刻 hard abort（L2）
   *   若 engine 无注入点则回落 force，保证最终能停
   */
  cancelRun(
    runId: string,
    reason = "cancelled-by-user",
    mode: "cooperative" | "force" = "force"
  ): boolean {
    const active = this.loop.activeRuns.get(runId);
    const run = this.loop.runs.get(runId);
    if (!run || !active) return false;
    if (isTerminalRunStatus(run.status)) return false;

    // L2 协作停：仅入队 ControlBus，让 session-loop 在安全点以 endReason=stop 收尾
    if (
      mode === "cooperative" &&
      typeof active.engine?.requestCooperativeStop === "function"
    ) {
      active.engine.requestCooperativeStop(reason);
      this.emitToRun(active, "run-cancel-requested", {
        reason,
        mode: "cooperative",
      });
      return true;
    }

    // L3 force，或 cooperative 无 ControlBus 时的回落
    this.updateRun(run, "cancelling");
    active.engine?.abort(reason);
    this.options.getBackgroundCommandManager?.(run.cwd)?.cancelAllForRun(runId);
    this.emitToRun(active, "run-cancel-requested", {
      reason,
      mode: mode === "cooperative" ? "cooperative-fallback-force" : "force",
    });
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
    // R6: migrated from ProtocolError "INVALID_RUN_STATE" -> CrishError "run.invalid_state"
    throw new CrishError(
      `Run ${run.id} ended with non-terminal status ${run.status}`,
      "run.invalid_state",
      "protocol",
      false,
      { runId: run.id, status: run.status }
    );
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
        {
          ...run.goal,
          status: "failed",
          stoppedReason: "error"
        }
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

function failedCompletion(
  reason: Extract<RunOutcomeReason, "agent-error" | "provider-error" | "runtime-error" | "max-turns" | "intervention-required" | "run-engine-error" | "event-store-write-failed">,
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
