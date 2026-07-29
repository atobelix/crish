import type {
  AgentOrchestratorOptions,
  CancelPendingInputRequest,
  CreateSessionRequest,
  DispatchPendingInputRequest,
  EnqueuePendingInputRequest,
  MoveSessionLeafRequest,
  MoveSessionLeafResult,
  OrchestratorEventReadOptions,
  OrchestratorRunHandle,
  RecordConversationRewindAuditRequest,
  RecordConversationRewindAuditResult,
  StartGoalRunRequest,
  StartRunRequest
} from "./types";
import { AgentLoop } from "./orchestrator/agent-loop";
import { TaskDispatcher } from "./orchestrator/task-dispatcher";

export { InMemoryOrchestratorEventStore, isNonDurableRuntimeDelta } from "./orchestrator/agent-loop";

export class AgentOrchestrator {
  private readonly loop: AgentLoop;
  private readonly dispatcher: TaskDispatcher;

  constructor(options: AgentOrchestratorOptions) {
    this.loop = new AgentLoop(options);
    this.dispatcher = new TaskDispatcher(this.loop, options);
  }

  createSession(request: CreateSessionRequest) {
    return this.loop.createSession(request);
  }

  getSession(sessionId: string) {
    return this.loop.getSession(sessionId);
  }

  listSessions() {
    return this.loop.listSessions();
  }

  listPendingInputs(sessionId?: string) {
    return this.dispatcher.listPendingInputs(sessionId);
  }

  enqueuePendingInput(request: EnqueuePendingInputRequest) {
    return this.dispatcher.enqueuePendingInput(request);
  }

  cancelPendingInput(request: CancelPendingInputRequest) {
    return this.dispatcher.cancelPendingInput(request);
  }

  dispatchPendingInput(request: DispatchPendingInputRequest) {
    return this.dispatcher.dispatchPendingInput(request);
  }

  listSessionSummaries() {
    return this.loop.listSessionSummaries();
  }

  moveSessionLeaf(request: MoveSessionLeafRequest): Promise<MoveSessionLeafResult> {
    return this.loop.moveSessionLeaf(request);
  }

  recordConversationRewindAudit(request: RecordConversationRewindAuditRequest): Promise<RecordConversationRewindAuditResult> {
    return this.loop.recordConversationRewindAudit(request);
  }

  getRun(runId: string) {
    return this.loop.getRun(runId);
  }

  listRuns(sessionId?: string) {
    return this.loop.listRuns(sessionId);
  }

  countActiveRuns(sessionId?: string) {
    return this.loop.countActiveRuns(sessionId);
  }

  startRun(request: StartRunRequest): Promise<OrchestratorRunHandle> {
    return this.dispatcher.startRun(request);
  }

  startGoalRun(request: StartGoalRunRequest): Promise<OrchestratorRunHandle> {
    return this.dispatcher.startGoalRun(request);
  }

  cancelRun(
    runId: string,
    reason?: string,
    mode?: "cooperative" | "force"
  ) {
    return this.dispatcher.cancelRun(runId, reason, mode);
  }

  steerRun(runId: string, text: string) {
    return this.dispatcher.steerRun(runId, text);
  }

  isRunActive(runId: string) {
    return this.dispatcher.isRunActive(runId);
  }

  readSessionEvents(sessionId: string, afterSequence?: number, options?: OrchestratorEventReadOptions) {
    return this.loop.readSessionEvents(sessionId, afterSequence, options);
  }

  readRunEvents(runId: string, afterSequence?: number, options?: OrchestratorEventReadOptions) {
    return this.loop.readRunEvents(runId, afterSequence, options);
  }

  getLastRestoreMode() {
    return this.loop.getLastRestoreMode();
  }

  persistStateSnapshot() {
    return this.loop.persistStateSnapshot();
  }

  getEventLogMetadata() {
    return this.loop.getEventLogMetadata();
  }

  restoreFromEventStore() {
    return this.loop.restoreFromEventStore();
  }

  getRecentDiagnostics() {
    return this.loop.getRecentDiagnostics();
  }
}
