import type { JsonObject, AgentEvent, AgentMessage, StoredEvent, StoredEventType, StoredEventLogMetadata, StoredEventReadOptions, EventStore } from "@crish/shared-types";
import type { OrchestratorSessionEventSummary } from "@crish/shared-types";
import { STORED_EVENT_PROTOCOL_VERSION, STORED_EVENT_LOG_SCHEMA_VERSION } from "@crish/shared-types";

export const ORCHESTRATOR_PROTOCOL_VERSION = STORED_EVENT_PROTOCOL_VERSION;

export type SessionStatus = "open" | "closed" | "archived";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export type RunOutcome = "completed" | "blocked" | "cancelled" | "failed";

export type RunOutcomeReason =
  | "completed"
  | "cancelled"
  | "aborted"
  | "daemon-restarted"
  | "goal-completed"
  | "goal-blocked"
  | "goal-max-rounds"
  | "goal-stalled"
  | "max-turns"
  | "agent-error"
  | "provider-error"
  | "runtime-error"
  | "intervention-required"
  | "event-store-write-failed"
  | "awaiting-approval"
  | "run-engine-error";

export type OrchestratorRunKind = "task" | "goal";

export type GoalRunStatus = "queued" | "running" | "completed" | "blocked" | "cancelled" | "failed";
export type GoalStoppedReason = "complete" | "blocked" | "max-rounds" | "stalled" | "cancelled" | "error";
export type GoalContinuationAction = "continue" | "complete" | "block";
export type GoalContinuationDecisionSource = "typed-assessment" | "tool-output" | "tool-update" | "message-marker";

export interface GoalContinuationDecision {
  action: GoalContinuationAction;
  reason: string;
  prompt?: string;
  progressSignature?: string;
  detail?: JsonObject;
}

export type GoalRoundAssessmentState =
  | "completed"
  | "cancelled"
  | "failed"
  | "blocked"
  | "needs-continuation"
  | "no-progress";

export interface GoalRoundProgressAssessment {
  signature: string;
  observed: boolean;
  eventCount: number;
  messageCount: number;
  toolCallCount: number;
  toolResultCount: number;
  toolErrorCount: number;
  checkpointCount: number;
}

export interface GoalRoundBudgetAssessment {
  completedRounds: number;
  maxRounds: number;
  maxRoundsReached: boolean;
  stalledRounds: number;
  maxStalledRounds: number;
  stalledLimitReached: boolean;
}

export interface GoalRoundAssessment {
  state: GoalRoundAssessmentState;
  reason: string;
  runStatus: RunStatus;
  runOutcome?: RunOutcome;
  runReason?: RunOutcomeReason;
  latestAgentEndReason?: Extract<AgentEvent, { type: "agent-end" }>["reason"];
  latestError?: string;
  providerFailure?: JsonObject;
  explicitDecision?: GoalContinuationDecision;
  explicitDecisionSource?: GoalContinuationDecisionSource;
  progress: GoalRoundProgressAssessment;
  budget?: GoalRoundBudgetAssessment;
  issues: string[];
}

export interface GoalRunOptions {
  visibleGoal?: string;
  maxRounds?: number;
  maxStalledRounds?: number;
}

export interface OrchestratorGoalRunState {
  status: GoalRunStatus;
  visibleGoal?: string;
  maxRounds: number;
  maxStalledRounds: number;
  currentRound: number;
  completedRounds: number;
  stalledRounds: number;
  stoppedReason?: GoalStoppedReason;
  lastProgressSignature?: string;
  lastDecision?: GoalContinuationDecision;
}

export interface OrchestratorSessionRecord {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  currentLeafId?: string;
  metadata?: JsonObject;
}

export interface MoveSessionLeafRequest {
  sessionId: string;
  targetLeafId: string | null;
  expectedCurrentLeafId?: string | null;
  reason?: string;
  metadata?: JsonObject;
}

export interface MoveSessionLeafResult {
  session: OrchestratorSessionRecord;
  fromLeafId: string | null;
  toLeafId: string | null;
  event?: OrchestratorEvent;
  changed: boolean;
}

export interface RecordConversationRewindAuditRequest {
  sessionId: string;
  payload: JsonObject;
}

export interface RecordConversationRewindAuditResult {
  event: OrchestratorEvent;
}

export type PendingInputMode = "after-current-run" | "steer";
export type PendingInputStatus = "pending" | "cancelled" | "dispatched";

export interface PendingInputRecord {
  id: string;
  sessionId: string;
  runId?: string;
  text: string;
  mode: PendingInputMode;
  status: PendingInputStatus;
  createdAt: string;
  updatedAt: string;
  source?: "workbench" | "daemon" | "automation";
  metadata?: JsonObject;
}

export interface EnqueuePendingInputRequest {
  id?: string;
  sessionId: string;
  runId?: string;
  text: string;
  mode?: PendingInputMode;
  source?: PendingInputRecord["source"];
  metadata?: JsonObject;
}

export interface CancelPendingInputRequest {
  id: string;
  sessionId?: string;
  reason?: string;
}

export interface DispatchPendingInputRequest {
  id: string;
  sessionId?: string;
  targetRunId?: string;
}

export interface PendingInputResult {
  input: PendingInputRecord;
  event: OrchestratorEvent;
}

export interface OrchestratorRunRecord {
  id: string;
  sessionId: string;
  cwd: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  outcome?: RunOutcome;
  reason?: RunOutcomeReason;
  outcomeDetail?: JsonObject;
  error?: string;
  kind?: OrchestratorRunKind;
  goal?: OrchestratorGoalRunState;
  lastEventId?: string;
  metadata?: JsonObject;
}

export type OrchestratorEventType = StoredEventType;
export type OrchestratorEvent<TPayload extends JsonObject = JsonObject> = StoredEvent<TPayload>;
export const ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION = STORED_EVENT_LOG_SCHEMA_VERSION;
export type OrchestratorEventLogMetadata = StoredEventLogMetadata;
export type OrchestratorEventReadOptions = StoredEventReadOptions;
export { type OrchestratorSessionEventSummary } from "@crish/shared-types";

export interface CreateSessionRequest {
  id?: string;
  cwd: string;
  metadata?: JsonObject;
}

export interface StartRunRequest {
  id?: string;
  sessionId?: string;
  cwd: string;
  input: string | AgentMessage;
  metadata?: JsonObject;
}

export interface StartGoalRunRequest extends StartRunRequest {
  goal?: GoalRunOptions;
  /** 可选的 Goal 循环策略；未提供时使用 orchestrator 内置的 EventScanGoalStrategy */
  goalLoopStrategy?: GoalLoopStrategy;
}

export interface RunEngine {
  run(input: string | AgentMessage): AsyncIterable<AgentEvent>;
  abort(reason?: string): void;
  /** 将用户输入实时注入到正在运行的 runtime 中（steer 模式） */
  enqueueSteerInput(message: AgentMessage): void;
}

export interface CreateRunEngineInput {
  runId: string;
  session: OrchestratorSessionRecord;
  run: OrchestratorRunRecord;
}

export type RunEngineFactory = (input: CreateRunEngineInput) => RunEngine | Promise<RunEngine>;

export interface GoalContinuationDeciderInput {
  run: OrchestratorRunRecord;
  session: OrchestratorSessionRecord;
  roundIndex: number;
  prompt: string | AgentMessage;
  events: AgentEvent[];
  assessment: GoalRoundAssessment;
}

export type GoalContinuationDecider = (input: GoalContinuationDeciderInput) => GoalContinuationDecision | Promise<GoalContinuationDecision>;

/**
 * Goal 循环策略——将 Goal 编排的「评估轮次结果」「检测停滞」「构建下一轮 prompt」
 * 和「Provider 容错」四个变化点抽象为可插拔接口。
 *
 * orchestrator 内置 EventScanGoalStrategy（基于事件流扫描）。
 * workbench 可提供 SnapshotAwareGoalStrategy（基于 WorkbenchTaskSnapshot 的领域感知策略）。
 */
export interface GoalLoopStrategy {
  /** 策略名称，用于诊断日志 */
  readonly name: string;

  /**
   * 评估本轮结果，产出延续决策。
   * @param roundContext 本轮运行期间由策略自身累积的领域上下文（如 snapshot），可为 undefined。
   */
  assessRound(input: {
    run: OrchestratorRunRecord;
    session: OrchestratorSessionRecord;
    roundIndex: number;
    prompt: string | AgentMessage;
    events: AgentEvent[];
    roundContext?: unknown;
  }): GoalContinuationDecision | Promise<GoalContinuationDecision>;

  /**
   * 计算进度签名，用于 stall 检测。
   * 签名相同的连续轮次视为「没有新进度」。
   */
  computeProgressSignature(input: {
    decision: GoalContinuationDecision;
    events: AgentEvent[];
    roundContext?: unknown;
  }): string;

  /**
   * 为下一轮构建 prompt。可在此注入审计信息、计划状态、验收准则等。
   * 返回 undefined 表示使用 decision.prompt 原样传递。
   */
  buildNextRoundPrompt?(input: {
    decision: GoalContinuationDecision;
    roundIndex: number;
    goalState: OrchestratorGoalRunState;
    events: AgentEvent[];
    roundContext?: unknown;
  }): string | undefined;

  /**
   * Provider 层容错策略。在每轮结束后、延续决策之前调用。
   * 返回 undefined 表示本轮没有 Provider 错误。
   */
  handleProviderError?(input: {
    events: AgentEvent[];
    roundIndex: number;
    consecutiveTransientErrors: number;
  }): ProviderErrorResult | undefined;

  /**
   * 可选的生命周期钩子：在每轮事件收集过程中被调用，
   * 允许策略累积领域上下文（如从事件流中构建 snapshot）。
   * 返回值将作为后续方法调用的 roundContext。
   */
  onRoundEvent?(event: AgentEvent, previousContext?: unknown): unknown;
}

/** Provider 容错决策结果 */
export interface ProviderErrorResult {
  action: "retry" | "backoff" | "fatal";
  reason: string;
  backoffMs?: number;
  /** retry/backoff 不计算为 productive round */
  countAsProductive?: boolean;
}

export type OrchestratorEventStore = EventStore;

export interface AgentOrchestratorOptions {
  createRunEngine: RunEngineFactory;
  decideGoalContinuation?: GoalContinuationDecider;
  /** 默认 Goal 循环策略；未提供且 StartGoalRunRequest 也未指定时使用 EventScanGoalStrategy */
  defaultGoalLoopStrategy?: GoalLoopStrategy;
  /** Provider 限频退避时间（毫秒），默认 90000 */
  providerRateLimitBackoffMs?: number;
  eventStore?: OrchestratorEventStore;
  now?: () => string;
  createId?: (prefix: string) => string;
}

export interface OrchestratorRunHandle {
  runId: string;
  sessionId: string;
  events: AsyncIterable<OrchestratorEvent>;
}
