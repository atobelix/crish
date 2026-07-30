import type { JsonObject, AgentEvent, AgentMessage, StoredEvent, StoredEventType, StoredEventLogMetadata, StoredEventReadOptions, EventStore } from "@crish/shared-types";
import { STORED_EVENT_PROTOCOL_VERSION, STORED_EVENT_LOG_SCHEMA_VERSION } from "@crish/shared-types";
import type { Logger } from "@crish/logger";
import type { BackgroundCommandManager } from "@crish/agent-tools";

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
  visibleGoal: string;
  currentRound: number;
  completedRounds: number;
  maxRounds: number;
  maxStalledRounds: number;
  stalledRounds: number;
  stoppedReason?: GoalStoppedReason;
  lastDecision?: GoalContinuationDecision;
  lastStalledRoundIndex?: number;
  lastProgressSignature?: string;
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
  /** 鍙€夌殑 Goal 寰幆绛栫暐锛涙湭鎻愪緵鏃朵娇鐢?orchestrator 鍐呯疆鐨?EventScanGoalStrategy */
  goalLoopStrategy?: GoalLoopStrategy;
}

/** cancel-run 模式：对齐 desktop L2/L3 */
export type CancelRunMode = "cooperative" | "force";

export interface RunEngine {
  run(input: string | AgentMessage): AsyncIterable<AgentEvent>;
  abort(reason?: string): void;
  /** 将用户输入实时注入到正在运行的 runtime 中（steer 模式） */
  enqueueSteerInput(message: AgentMessage): void;
  /**
   * L2 协作停：通过 ControlBus 请求干净收尾，不立刻 abort provider。
   * 未实现时 cancelRun(mode=cooperative) 回落为 force abort。
   */
  requestCooperativeStop?(reason?: string): void;
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
 * Goal 寰幆绛栫暐鈥斺€斿皢 Goal 缂栨帓鐨勩€岃瘎浼拌疆娆＄粨鏋溿€嶃€屾娴嬪仠婊炪€嶃€屾瀯寤轰笅涓€杞?prompt銆?
 * 鍜屻€孭rovider 瀹归敊銆嶅洓涓彉鍖栫偣鎶借薄涓哄彲鎻掓嫈鎺ュ彛銆?
 *
 * orchestrator 鍐呯疆 EventScanGoalStrategy锛堝熀浜庝簨浠舵祦鎵弿锛夈€?
 * workbench 鍙彁渚?SnapshotAwareGoalStrategy锛堝熀浜?WorkbenchTaskSnapshot 鐨勯鍩熸劅鐭ョ瓥鐣ワ級銆?
 */
export interface GoalLoopStrategy {
  /** 绛栫暐鍚嶇О锛岀敤浜庤瘖鏂棩蹇?*/
  readonly name: string;

  /**
   * 璇勪及鏈疆缁撴灉锛屼骇鍑哄欢缁喅绛栥€?
   * @param roundContext 鏈疆杩愯鏈熼棿鐢辩瓥鐣ヨ嚜韬疮绉殑棰嗗煙涓婁笅鏂囷紙濡?snapshot锛夛紝鍙负 undefined銆?
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
   * 璁＄畻杩涘害绛惧悕锛岀敤浜?stall 妫€娴嬨€?
   * 绛惧悕鐩稿悓鐨勮繛缁疆娆¤涓恒€屾病鏈夋柊杩涘害銆嶃€?
   */
  computeProgressSignature(input: {
    decision: GoalContinuationDecision;
    events: AgentEvent[];
    roundContext?: unknown;
  }): string;

  /**
   * 涓轰笅涓€杞瀯寤?prompt銆傚彲鍦ㄦ娉ㄥ叆瀹¤淇℃伅銆佽鍒掔姸鎬併€侀獙鏀跺噯鍒欑瓑銆?
   * 杩斿洖 undefined 琛ㄧず浣跨敤 decision.prompt 鍘熸牱浼犻€掋€?
   */
  buildNextRoundPrompt?(input: {
    decision: GoalContinuationDecision;
    roundIndex: number;
    goalState: OrchestratorGoalRunState;
    events: AgentEvent[];
    roundContext?: unknown;
  }): string | undefined;

  /**
   * Provider 灞傚閿欑瓥鐣ャ€傚湪姣忚疆缁撴潫鍚庛€佸欢缁喅绛栦箣鍓嶈皟鐢ㄣ€?
   * 杩斿洖 undefined 琛ㄧず鏈疆娌℃湁 Provider 閿欒銆?
   */
  handleProviderError?(input: {
    events: AgentEvent[];
    roundIndex: number;
    consecutiveTransientErrors: number;
  }): ProviderErrorResult | undefined;

  /**
   * 鍙€夌殑鐢熷懡鍛ㄦ湡閽╁瓙锛氬湪姣忚疆浜嬩欢鏀堕泦杩囩▼涓璋冪敤锛?
   * 鍏佽绛栫暐绱Н棰嗗煙涓婁笅鏂囷紙濡備粠浜嬩欢娴佷腑鏋勫缓 snapshot锛夈€?
   * 杩斿洖鍊煎皢浣滀负鍚庣画鏂规硶璋冪敤鐨?roundContext銆?
   */
  onRoundEvent?(event: AgentEvent, previousContext?: unknown): unknown;
}

/** Provider 瀹归敊鍐崇瓥缁撴灉 */
export interface ProviderErrorResult {
  action: "retry" | "backoff" | "fatal";
  reason: string;
  backoffMs?: number;
  /** retry/backoff 涓嶈绠椾负 productive round */
  countAsProductive?: boolean;
}

export type OrchestratorEventStore = EventStore;

export interface AgentOrchestratorOptions {
  createRunEngine: RunEngineFactory;
  decideGoalContinuation?: GoalContinuationDecider;
  /** 榛樿 Goal 寰幆绛栫暐锛涙湭鎻愪緵涓?StartGoalRunRequest 涔熸湭鎸囧畾鏃朵娇鐢?EventScanGoalStrategy */
  defaultGoalLoopStrategy?: GoalLoopStrategy;
  /** Provider 闄愰閫€閬挎椂闂达紙姣锛夛紝榛樿 90000 */
  providerRateLimitBackoffMs?: number;
  eventStore?: OrchestratorEventStore;
  now?: () => string;
  createId?: (prefix: string) => string;
  /** 鏍规嵁 cwd 鑾峰彇 BackgroundCommandManager锛岀敤浜?cancelRun 鏃剁骇鑱斿彇娑堝叧鑱旂殑鍚庡彴浠诲姟銆?*/
  getBackgroundCommandManager?: (cwd: string) => BackgroundCommandManager;
  /**
   * R6: Logger 实例（依赖注入）。不提供时使用静默记录器；不自行 createLogger（设计原则）。
   * daemon（R7）创建 Logger 实例后通过此字段传入，与 orchestrator 共享 transport。
   */
  logger?: Logger;
}

export interface OrchestratorRunHandle {
  runId: string;
  sessionId: string;
  events: AsyncIterable<OrchestratorEvent>;
}
