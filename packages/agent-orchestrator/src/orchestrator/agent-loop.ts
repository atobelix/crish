import type { JsonObject, AgentEvent, DiagnosticRecord } from "@crish/shared-types";
import { SessionError, ProtocolError } from "@crish/shared-types";
import {
  compactJsonObject, isRecord, BoundedMap, RingBuffer, toJsonObject,
  MAX_ORCHESTRATOR_SESSIONS, MAX_ORCHESTRATOR_RUNS, MAX_ORCHESTRATOR_PENDING_INPUTS, MAX_ORCHESTRATOR_DIAGNOSTICS, MAX_ORCHESTRATOR_EVENTS,
  Logger, createConsoleTransport,
} from "@crish/shared-utils";
import { pluginRegistry } from "@crish/agent-runtime/plugin-registry";
import { asStateSnapshotStore, type OrchestratorStateSnapshot } from "../state-snapshot";
import {
  ORCHESTRATOR_PROTOCOL_VERSION,
  type AgentOrchestratorOptions,
  type CreateSessionRequest,
  type MoveSessionLeafRequest,
  type MoveSessionLeafResult,
  type OrchestratorEvent,
  type OrchestratorEventLogMetadata,
  type OrchestratorEventReadOptions,
  type OrchestratorEventStore,
  type OrchestratorGoalRunState,
  type OrchestratorRunRecord,
  type OrchestratorSessionEventSummary,
  type OrchestratorSessionRecord,
  type PendingInputRecord,
  type RecordConversationRewindAuditRequest,
  type RecordConversationRewindAuditResult,
  type RunEngine,
  type RunOutcome,
  type RunOutcomeReason,
  type RunStatus,
} from "../types";
import { isTerminalRunStatus } from "../state-machine";
import { updateGoalState } from "../goal-continuation";
import { summarizeOrchestratorSessionEvents } from "../session-summary";

const logger = new Logger({ module: "orchestrator", transports: [createConsoleTransport()] });

/** Non-durable runtime event types that can skip event-store persistence. */
const NON_DURABLE_DELTA_TYPES = new Set(["message-delta", "thought-delta"]);

export function isNonDurableRuntimeDelta(event: { type: string }): boolean {
  return NON_DURABLE_DELTA_TYPES.has(event.type);
}

export interface ActiveRun {
  run: OrchestratorRunRecord;
  queue: AsyncQueue<OrchestratorEvent>;
  pendingEmits: BoundedMap<Promise<void>, true>;
  emitChain: Promise<void>;
  engine: RunEngine | undefined;
  lastProviderFailure?: JsonObject;
  persistenceFailed?: boolean;
}

export interface RestoredRunReplayState {
  lastProviderFailure: JsonObject | undefined;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
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

export class AgentLoop {
  readonly sessions = new BoundedMap<string, OrchestratorSessionRecord>(MAX_ORCHESTRATOR_SESSIONS, undefined);
  readonly runs = new BoundedMap<string, OrchestratorRunRecord>(MAX_ORCHESTRATOR_RUNS, undefined);
  readonly pendingInputs = new BoundedMap<string, PendingInputRecord>(MAX_ORCHESTRATOR_PENDING_INPUTS, undefined);
  readonly activeRuns = new BoundedMap<string, ActiveRun>(MAX_ORCHESTRATOR_RUNS, (_key, active) => {
    active.engine?.abort('active-runs-capacity-exceeded');
  });
  readonly eventStore: OrchestratorEventStore;
  sequence = 0;

  private readonly diagnosticsRing: (DiagnosticRecord | undefined)[] = new Array(MAX_ORCHESTRATOR_DIAGNOSTICS);
  private diagCursor = 0;
  private lastRestoreMode: "full-replay" | "snapshot-incremental" | "unknown" = "unknown";

  constructor(readonly options: AgentOrchestratorOptions) {
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

  countActiveRuns(sessionId?: string): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (isTerminalRunStatus(run.status)) continue;
      if (sessionId && run.sessionId !== sessionId) continue;
      count++;
    }
    return count;
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

  async notifySessionStart(sessionId: string): Promise<void> {
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

  event(type: OrchestratorEvent["type"], sessionId: string, runId: string | undefined, payload: JsonObject): OrchestratorEvent {
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

  async storeEvent(event: OrchestratorEvent): Promise<void> {
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

  pushDiagnostic(record: DiagnosticRecord): void {
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

  private async interruptRestoredActiveRuns(): Promise<void> {
    for (const run of this.runs.values()) {
      if (isTerminalRunStatus(run.status) || this.activeRuns.has(run.id)) continue;

      const previousStatus = run.status;
      const previousReason = run.reason;
      const previousOutcomeDetail = run.outcomeDetail;
      const completion = interruptedCompletion(previousStatus, previousReason, previousOutcomeDetail);
      if (run.goal) {
        run.goal = updateGoalState(run.goal, {
          status: completion.status === "cancelled" ? "cancelled" : "failed",
          stoppedReason: completion.status === "cancelled" ? "cancelled" : "error"
        });
      }
      run.status = completion.status;
      run.updatedAt = this.now();
      run.finishedAt = this.now();
      run.outcome = completion.outcome;
      run.reason = completion.reason;
      if (completion.outcomeDetail !== undefined) run.outcomeDetail = completion.outcomeDetail;
      if (completion.error !== undefined) run.error = completion.error;

      const event = this.event(completion.status === "cancelled" ? "run-cancelled" : "run-failed", run.sessionId, run.id, terminalPayload(run));
      run.lastEventId = event.id;
      await this.storeEvent(event);
    }
  }

  now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  createId(prefix: string): string {
    if (this.options.createId) return this.options.createId(prefix);
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }
}

export function collectEvents(
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
  if (completion.outcomeDetail !== undefined) run.outcomeDetail = completion.outcomeDetail;
  if (completion.error !== undefined) run.error = completion.error;
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

export interface RunCompletion {
  status: Extract<RunStatus, "completed" | "cancelled" | "failed">;
  outcome: RunOutcome;
  reason: RunOutcomeReason;
  outcomeDetail: JsonObject | undefined;
  error: string | undefined;
}

export function interruptedCompletion(
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

export function completionFromRuntimeEvent(
  runtimeEvent: AgentEvent,
  lastProviderFailure?: JsonObject,
  options: { agentStopCompletes?: boolean } = {}
): RunCompletion | undefined {
  if (runtimeEvent.type === "agent-end") {
    if (runtimeEvent.reason === "stop") {
      return options.agentStopCompletes === false ? undefined : { status: "completed", outcome: "completed", reason: "completed", outcomeDetail: undefined, error: undefined };
    }
    if (runtimeEvent.reason === "aborted") {
      return { status: "cancelled", outcome: "cancelled", reason: "aborted", error: runtimeEvent.error ?? undefined, outcomeDetail: undefined };
    }
    if (runtimeEvent.reason === "max-turns") {
      return { status: "failed", outcome: "failed", reason: "max-turns", error: runtimeEvent.error ?? "Run reached the maximum turn limit", outcomeDetail: toJsonObject(runtimeEvent) };
    }
    return { status: "failed", outcome: "failed", reason: "agent-error", error: runtimeEvent.error ?? "Agent ended with an error", outcomeDetail: toJsonObject(runtimeEvent) };
  }

  if (runtimeEvent.type === "runtime-error") {
    const reason = lastProviderFailure ? "provider-error" : "runtime-error";
    return { status: "failed", outcome: "failed", reason, error: runtimeEvent.error, outcomeDetail: compactJsonObject({ event: runtimeEvent, providerDiagnostic: lastProviderFailure }) };
  }

  if (runtimeEvent.type === "runtime-intervention-required") {
    return { status: "failed", outcome: "failed", reason: "intervention-required", error: runtimeEvent.message, outcomeDetail: toJsonObject(runtimeEvent) };
  }

  return undefined;
}

export function isProviderFailureDiagnostic(diagnostic: Extract<AgentEvent, { type: "provider-diagnostic" }>["diagnostic"]): boolean {
  return diagnostic.phase === "request-error" || (typeof diagnostic.status === "number" && diagnostic.status >= 400);
}

export function isStoredProviderDiagnostic(value: unknown): value is Extract<AgentEvent, { type: "provider-diagnostic" }>["diagnostic"] {
  return isRecord(value) && typeof value.phase === "string";
}

export function terminalPayload(run: OrchestratorRunRecord, error?: string): JsonObject {
  return compactJsonObject({
    run,
    outcome: run.outcome,
    reason: run.reason,
    outcomeDetail: run.outcomeDetail,
    error: error ?? run.error
  });
}

export function sessionRecordFromPayload(event: OrchestratorEvent): OrchestratorSessionRecord | undefined {
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

export function runRecordFromPayload(event: OrchestratorEvent): OrchestratorRunRecord | undefined {
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

export function pendingInputRecordFromPayload(value: unknown, event: OrchestratorEvent): PendingInputRecord | undefined {
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

export function isPendingInputMode(value: unknown): value is PendingInputRecord["mode"] {
  return value === "after-current-run" || value === "steer";
}

export function isPendingInputStatus(value: unknown): value is PendingInputRecord["status"] {
  return value === "pending" || value === "cancelled" || value === "dispatched";
}

export function isSessionStatus(value: unknown): value is OrchestratorSessionRecord["status"] {
  return value === "open" || value === "closed" || value === "archived";
}

export function isRunStatus(value: unknown): value is RunStatus {
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

export function isRunOutcome(value: unknown): value is RunOutcome {
  return value === "completed" || value === "blocked" || value === "cancelled" || value === "failed";
}

export function isRunOutcomeReason(value: unknown): value is RunOutcomeReason {
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

export function isRunKind(value: unknown): value is OrchestratorRunRecord["kind"] {
  return value === "task" || value === "goal";
}

export function isGoalRunState(value: unknown): value is OrchestratorGoalRunState {
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

export function isGoalStatus(value: unknown): value is OrchestratorGoalRunState["status"] {
  return value === "queued" || value === "running" || value === "completed" || value === "blocked" || value === "cancelled" || value === "failed";
}

export function isGoalStoppedReason(value: unknown): value is NonNullable<OrchestratorGoalRunState["stoppedReason"]> {
  return value === "complete" || value === "blocked" || value === "max-rounds" || value === "stalled" || value === "cancelled" || value === "error";
}

export function isGoalDecision(value: unknown): value is NonNullable<OrchestratorGoalRunState["lastDecision"]> {
  if (!isRecord(value)) return false;
  return (
    (value.action === "continue" || value.action === "complete" || value.action === "block") &&
    typeof value.reason === "string" &&
    (value.prompt === undefined || typeof value.prompt === "string") &&
    (value.progressSignature === undefined || typeof value.progressSignature === "string") &&
    (value.detail === undefined || isRecord(value.detail))
  );
}
