// R6: task-dispatcher.ts
// 原 barrel 仅 re-export TaskDispatcher。R6 升级为带结构化日志的 dispatch 包装层。
// 设计依据：ROUND-06-orchestrator.md §3.2 + §5.3 日志埋点清单
//   - dispatch 失败用 runtime.transition_failed
//   - 埋日志 logger.info("task_dispatcher.dispatch", { taskId, runId })
//
// 系统化设计：不修改 6-C 的 task-executor.ts，而是在此层提供
// wrapTaskDispatcherWithLogging 工厂函数，由 orchestrator.ts 在构造时调用，
// 将 Logger 注入到 dispatch 路径，同时保持 TaskDispatcher 原有接口契约。

import { Logger } from "@crish/logger";
import type { CrishResult } from "@crish/shared-types";
import { fromPromise, ok } from "@crish/shared-types";
import type {
  CancelPendingInputRequest,
  DispatchPendingInputRequest,
  EnqueuePendingInputRequest,
  OrchestratorRunHandle,
  PendingInputRecord,
  PendingInputResult,
  StartGoalRunRequest,
  StartRunRequest
} from "../types";

// 保留原 barrel re-export，使现有 import 路径不中断
export { TaskDispatcher } from "./dispatcher/task-executor";

// 静默 Logger 兜底（不自行 createLogger，仅作为未注入时的 fallback）
const NOOP_LOGGER = new Logger({ level: "error" });

// TaskDispatcher 的结构化接口（与 task-executor.ts 中 TaskDispatcher 类签名对齐）
interface TaskDispatcherLike {
  listPendingInputs(sessionId?: string): PendingInputRecord[];
  enqueuePendingInput(request: EnqueuePendingInputRequest): Promise<PendingInputResult>;
  cancelPendingInput(request: CancelPendingInputRequest): Promise<PendingInputResult>;
  dispatchPendingInput(request: DispatchPendingInputRequest): Promise<PendingInputResult>;
  startRun(request: StartRunRequest): Promise<OrchestratorRunHandle>;
  startGoalRun(request: StartGoalRunRequest): Promise<OrchestratorRunHandle>;
  cancelRun(runId: string, reason?: string, mode?: "cooperative" | "force"): boolean;
  steerRun(runId: string, text: string): boolean;
  isRunActive(runId: string): boolean;
}

/**
 * R6: 带结构化日志的 TaskDispatcher 包装。
 *
 * 包装策略：
 * - 同步方法（listPendingInputs / isRunActive）直接透传
 * - 异步方法返回 Promise<CrishResult<T>>，由 fromPromise 捕获异常
 * - startRun / startGoalRun 入口埋 logger.info("task_dispatcher.dispatch")
 * - 失败路径埋 logger.error，含 errorCode/category/retryable
 *
 * 该包装满足 orchestrator.ts 公共 API 的 CrishResult 返回要求，
 * 同时不修改 6-C 的 task-executor.ts 源文件。
 */
export class LoggingTaskDispatcher<TDispatcher extends TaskDispatcherLike = TaskDispatcherLike> {
  private readonly logger: Logger;

  constructor(
    private readonly inner: TDispatcher,
    logger: Logger | undefined
  ) {
    this.logger = logger ?? NOOP_LOGGER;
  }

  listPendingInputs(sessionId?: string): PendingInputRecord[] {
    return this.inner.listPendingInputs(sessionId);
  }

  isRunActive(runId: string): boolean {
    return this.inner.isRunActive(runId);
  }

  async enqueuePendingInput(request: EnqueuePendingInputRequest): Promise<CrishResult<PendingInputResult>> {
    this.logger.info("task_dispatcher.dispatch", {
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      dispatchedTo: "pending-input-queue"
    });
    return fromPromise(this.inner.enqueuePendingInput(request));
  }

  async cancelPendingInput(request: CancelPendingInputRequest): Promise<CrishResult<PendingInputResult>> {
    this.logger.info("task_dispatcher.dispatch", {
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      dispatchedTo: "cancel-pending-input"
    });
    return fromPromise(this.inner.cancelPendingInput(request));
  }

  async dispatchPendingInput(request: DispatchPendingInputRequest): Promise<CrishResult<PendingInputResult>> {
    this.logger.info("task_dispatcher.dispatch", {
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.targetRunId !== undefined ? { runId: request.targetRunId } : {}),
      dispatchedTo: "pending-input-dispatch"
    });
    return fromPromise(this.inner.dispatchPendingInput(request));
  }

  async startRun(request: StartRunRequest): Promise<CrishResult<OrchestratorRunHandle>> {
    const sessionId = typeof request.sessionId === "string" ? request.sessionId : undefined;
    this.logger.info("task_dispatcher.dispatch", {
      ...(sessionId !== undefined ? { sessionId } : {}),
      dispatchedTo: "start-run"
    });
    const result = await fromPromise(this.inner.startRun(request));
    if (result.ok) {
      this.logger.info("orchestrator.run_started", {
        runId: result.value.runId,
        sessionId: result.value.sessionId
      });
    } else {
      this.logger.error("task_dispatcher.dispatch_failed", {
        ...(sessionId !== undefined ? { sessionId } : {}),
        errorCode: result.error.code,
        category: result.error.category,
        retryable: result.error.retryable
      });
    }
    return result;
  }

  async startGoalRun(request: StartGoalRunRequest): Promise<CrishResult<OrchestratorRunHandle>> {
    const sessionId = typeof request.sessionId === "string" ? request.sessionId : undefined;
    this.logger.info("task_dispatcher.dispatch", {
      ...(sessionId !== undefined ? { sessionId } : {}),
      dispatchedTo: "start-goal-run"
    });
    const result = await fromPromise(this.inner.startGoalRun(request));
    if (result.ok) {
      this.logger.info("orchestrator.run_started", {
        runId: result.value.runId,
        sessionId: result.value.sessionId
      });
    } else {
      this.logger.error("task_dispatcher.dispatch_failed", {
        ...(sessionId !== undefined ? { sessionId } : {}),
        errorCode: result.error.code,
        category: result.error.category,
        retryable: result.error.retryable
      });
    }
    return result;
  }

  async cancelRun(runId: string, reason?: string, mode?: "cooperative" | "force"): Promise<CrishResult<void>> {
    this.logger.info("task_dispatcher.dispatch", {
      runId,
      dispatchedTo: "cancel-run",
      ...(reason !== undefined ? { reason } : {}),
      ...(mode !== undefined ? { mode } : {})
    });
    // cancelRun 在 task-executor 中是同步的，返回 boolean 表示是否实际生效
    const applied = this.inner.cancelRun(runId, reason, mode);
    if (!applied) {
      this.logger.warn("task_dispatcher.dispatch_noop", {
        runId,
        dispatchedTo: "cancel-run",
        reason: "run_not_active_or_terminal"
      });
    }
    return ok();
  }

  async steerRun(runId: string, text: string): Promise<CrishResult<void>> {
    this.logger.info("task_dispatcher.dispatch", {
      runId,
      dispatchedTo: "steer-run"
    });
    // steerRun 在 task-executor 中是同步的，返回 boolean 表示是否实际生效
    const applied = this.inner.steerRun(runId, text);
    if (!applied) {
      this.logger.warn("task_dispatcher.dispatch_noop", {
        runId,
        dispatchedTo: "steer-run",
        reason: "run_not_active_or_terminal"
      });
    }
    return ok();
  }
}

/**
 * R6: 工厂函数，用 LoggingTaskDispatcher 包装原 TaskDispatcher。
 * 保留 TaskDispatcher 原有接口契约的同时注入日志。
 */
export function wrapTaskDispatcherWithLogging<TDispatcher extends TaskDispatcherLike>(
  dispatcher: TDispatcher,
  logger: Logger | undefined
): LoggingTaskDispatcher<TDispatcher> {
  return new LoggingTaskDispatcher(dispatcher, logger);
}
