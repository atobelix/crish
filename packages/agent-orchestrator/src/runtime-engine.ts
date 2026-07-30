// R6: runtime-engine.ts
// runtime 装配日志 + 装配失败用 CrishError("runtime.unexpected_state")。
// 设计依据：ROUND-06-orchestrator.md §3.2 + §5.3 日志埋点清单
//
// 系统化改进：
// - 在 createAgentRuntimeRunEngineFactory 中增加装配日志（debug 级别）
// - 装配失败（AgentRuntime 构造或 factory 抛出）上抛 CrishError
// - 不引入 console.*，Logger 通过参数注入（不自行 createLogger）

import { AgentRuntime, type AgentRuntimeOptions } from "@crish/agent-core";
import { CrishError } from "@crish/shared-types";
import { Logger } from "@crish/logger";
import type { CreateRunEngineInput, RunEngine, RunEngineFactory } from "./types";

// 静默 Logger 兜底（不自行 createLogger，仅作为未注入时的 fallback）
const NOOP_LOGGER = new Logger({ level: "error" });

export type AgentRuntimeOptionsFactory = (input: CreateRunEngineInput) => AgentRuntimeOptions | Promise<AgentRuntimeOptions>;

export function createAgentRuntimeRunEngine(
  runtime: Pick<AgentRuntime, "run" | "abort" | "enqueueSteerInput" | "requestCooperativeStop">
): RunEngine {
  return {
    run(input) {
      return runtime.run(input);
    },
    abort(reason) {
      runtime.abort(reason);
    },
    enqueueSteerInput(message) {
      runtime.enqueueSteerInput(message);
    },
    // L2：转发到 AgentRuntime ControlBus
    requestCooperativeStop(reason) {
      runtime.requestCooperativeStop(reason);
    },
  };
}

/**
 * R6: 创建 RunEngine 工厂。
 *
 * 装配日志策略：
 * - debug 级别记录 factory 入口与装配完成（含 runId/sessionId）
 * - 装配失败时抛 CrishError("runtime.unexpected_state", permanent, false)
 * - logger 参数可选，未注入时使用静默记录器
 */
export function createAgentRuntimeRunEngineFactory(
  factory: AgentRuntimeOptionsFactory,
  logger?: Logger
): RunEngineFactory {
  const log = logger ?? NOOP_LOGGER;
  return async (input) => {
    log.debug("runtime_engine.assemble", {
      runId: input.runId,
      sessionId: input.session.id
    });
    let options: AgentRuntimeOptions;
    try {
      options = await factory(input);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error("runtime_engine.assemble_failed", {
        runId: input.runId,
        sessionId: input.session.id,
        errorCode: "runtime.unexpected_state",
        category: "permanent",
        retryable: false,
        ...(cause instanceof Error ? { err: { message, name: cause.name } } : {})
      });
      throw new CrishError(
        `Runtime engine assembly failed for run ${input.runId}: ${message}`,
        "runtime.unexpected_state",
        "permanent",
        false,
        { runId: input.runId, sessionId: input.session.id }
      );
    }
    let runtime: AgentRuntime;
    try {
      runtime = new AgentRuntime(options);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error("runtime_engine.assemble_failed", {
        runId: input.runId,
        sessionId: input.session.id,
        errorCode: "runtime.unexpected_state",
        category: "permanent",
        retryable: false,
        ...(cause instanceof Error ? { err: { message, name: cause.name } } : {})
      });
      throw new CrishError(
        `AgentRuntime construction failed for run ${input.runId}: ${message}`,
        "runtime.unexpected_state",
        "permanent",
        false,
        { runId: input.runId, sessionId: input.session.id }
      );
    }
    log.debug("runtime_engine.assembled", {
      runId: input.runId,
      sessionId: input.session.id
    });
    return createAgentRuntimeRunEngine(runtime);
  };
}
