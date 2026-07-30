// R6: orchestrator.ts
// 公共 API 返回 CrishResult<T> + 结构化日志埋点。
// 设计依据：ROUND-06-orchestrator.md §3.2 + §5.3 日志埋点清单
//
// 迁移策略（系统性改进，非补丁式）：
// - 公共异步 API Promise<T> → Promise<CrishResult<T>>，由 fromPromise 捕获异常
// - 同步 API 保持原签名（入参校验类 throw 由调用方处理）
// - 通过 LoggingTaskDispatcher 注入日志，不修改 6-C 的 task-executor.ts
// - Logger 通过 AgentOrchestratorOptions.logger 注入，不自行 createLogger

import { Logger } from "@crish/logger";
import type { CrishResult } from "@crish/shared-types";
import { fromPromise } from "@crish/shared-types";
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
import { TaskDispatcher, LoggingTaskDispatcher } from "./orchestrator/task-dispatcher";
import { setSessionSummaryLogger } from "./session-summary";
import { setProtocolLogger } from "./protocol";

export { InMemoryOrchestratorEventStore, isNonDurableRuntimeDelta } from "./orchestrator/agent-loop";

// 静默 Logger 兜底（不自行 createLogger，仅作为未注入时的 fallback）
const NOOP_LOGGER = new Logger({ level: "error" });

export class AgentOrchestrator {
  private readonly loop: AgentLoop;
  private readonly dispatcher: TaskDispatcher;
  private readonly loggingDispatcher: LoggingTaskDispatcher;
  private readonly logger: Logger;

  constructor(options: AgentOrchestratorOptions) {
    this.loop = new AgentLoop(options);
    this.dispatcher = new TaskDispatcher(this.loop, options);
    this.logger = options.logger ?? NOOP_LOGGER;
    this.loggingDispatcher = new LoggingTaskDispatcher(this.dispatcher, this.logger);
    // R6: 将 Logger 注入到 session-summary 纯函数模块
    setSessionSummaryLogger(this.logger);
    // R6: 将 Logger 注入到 protocol 纯函数模块
    setProtocolLogger(this.logger);
  }

  // ─── 同步 API（保持原签名） ────────────────────────────────────────────

  createSession(request: CreateSessionRequest) {
    this.logger.info("orchestrator.session_created", {
      ...(request.id !== undefined ? { sessionId: request.id } : {})
    });
    return this.loop.createSession(request);
  }

  getSession(sessionId: string) {
    return this.loop.getSession(sessionId);
  }

  listSessions() {
    return this.loop.listSessions();
  }

  listPendingInputs(sessionId?: string) {
    return this.loggingDispatcher.listPendingInputs(sessionId);
  }

  listSessionSummaries() {
    return this.loop.listSessionSummaries();
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

  isRunActive(runId: string) {
    return this.loggingDispatcher.isRunActive(runId);
  }

  getLastRestoreMode() {
    return this.loop.getLastRestoreMode();
  }

  getRecentDiagnostics() {
    return this.loop.getRecentDiagnostics();
  }

  getEventLogMetadata() {
    return this.loop.getEventLogMetadata();
  }

  // ─── R6: CrishResult 公共异步 API ──────────────────────────────────────
  // 公共边界返回 CrishResult<T>，调用方按 result.ok 分支处理。
  // 设计依据：ROUND-06-orchestrator.md §3.2 CrishResult 迁移规则

  enqueuePendingInput(request: EnqueuePendingInputRequest): Promise<CrishResult<import("./types").PendingInputResult>> {
    return this.loggingDispatcher.enqueuePendingInput(request);
  }

  cancelPendingInput(request: CancelPendingInputRequest): Promise<CrishResult<import("./types").PendingInputResult>> {
    return this.loggingDispatcher.cancelPendingInput(request);
  }

  dispatchPendingInput(request: DispatchPendingInputRequest): Promise<CrishResult<import("./types").PendingInputResult>> {
    return this.loggingDispatcher.dispatchPendingInput(request);
  }

  moveSessionLeaf(request: MoveSessionLeafRequest): Promise<CrishResult<MoveSessionLeafResult>> {
    return fromPromise(this.loop.moveSessionLeaf(request));
  }

  recordConversationRewindAudit(request: RecordConversationRewindAuditRequest): Promise<CrishResult<RecordConversationRewindAuditResult>> {
    return fromPromise(this.loop.recordConversationRewindAudit(request));
  }

  startRun(request: StartRunRequest): Promise<CrishResult<OrchestratorRunHandle>> {
    return this.loggingDispatcher.startRun(request);
  }

  startGoalRun(request: StartGoalRunRequest): Promise<CrishResult<OrchestratorRunHandle>> {
    return this.loggingDispatcher.startGoalRun(request);
  }

  cancelRun(
    runId: string,
    reason?: string,
    mode?: "cooperative" | "force"
  ): Promise<CrishResult<void>> {
    return this.loggingDispatcher.cancelRun(runId, reason, mode);
  }

  steerRun(runId: string, text: string): Promise<CrishResult<void>> {
    return this.loggingDispatcher.steerRun(runId, text);
  }

  readSessionEvents(sessionId: string, afterSequence?: number, options?: OrchestratorEventReadOptions): Promise<CrishResult<import("./types").OrchestratorEvent[]>> {
    return fromPromise(this.loop.readSessionEvents(sessionId, afterSequence, options));
  }

  readRunEvents(runId: string, afterSequence?: number, options?: OrchestratorEventReadOptions): Promise<CrishResult<import("./types").OrchestratorEvent[]>> {
    return fromPromise(this.loop.readRunEvents(runId, afterSequence, options));
  }

  persistStateSnapshot(): Promise<CrishResult<void>> {
    return fromPromise(this.loop.persistStateSnapshot());
  }

  restoreFromEventStore(): Promise<CrishResult<void>> {
    return fromPromise(this.loop.restoreFromEventStore());
  }
}
