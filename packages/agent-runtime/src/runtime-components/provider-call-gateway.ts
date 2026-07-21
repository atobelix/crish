/**
 * ProviderCallGateway - Provider 调用网关
 *
 * 从 AgentRuntime 中拆分出来的独立组件，负责：
 * 1. Provider 流式调用的编排
 * 2. 流式事件的解析与组装
 * 3. 重试与降级逻辑（通过可选的 ConnectionManager 驱动）
 * 4. 响应汇总
 *
 * 与根目录 provider-gateway.ts 的关系：
 * - provider-gateway.ts 负责路由选择和凭证解析
 * - ProviderCallGateway 负责单次调用的执行和流式事件处理
 *
 * 关键改进：
 * - 流式事件处理与 Runtime 解耦
 * - 可选集成 ConnectionManager（传输选择 + 历史学习）和 StreamRecovery（流中断恢复）
 * - 向后兼容：不传 ConnectionManager 时使用原有裸循环
 */

import type {
  ProviderDiagnostic,
  JsonObject,
} from "@crish/shared-types";
import type {
  AgentProvider,
  AgentProviderRequest,
  ProviderStreamEvent,
  ProviderResponse,
} from "../types";
import {
  normalizeAndCoalesceProviderStreamEvents,
  type ProviderStreamContractEvent,
} from "../provider-stream-contract";
import { createId } from "../session";
import type { ConnectionManager } from "../provider-transport/connection-manager";
import { StreamRecovery, StreamRecoveryError } from "../provider-transport/stream-recovery";
import type { TokenTracker } from "../provider-transport/token-tracker";
import { CircuitBreaker, CircuitBreakerOpenError, retryWithBackoff } from "@crish/shared-utils";

// ─── 调用结果 ─────────────────────────────────────────────

export interface ProviderCallResult {
  /** 组装后的完整响应 */
  response: ProviderResponse;
  /** 流式过程中产生的所有事件 */
  streamEvents: ProviderStreamContractEvent[];
}

// ─── ProviderCallGateway ──────────────────────────────────

export interface ProviderCallGatewayOptions {
  connectionManager?: ConnectionManager;
  tokenTracker?: TokenTracker;
}

export class ProviderCallGateway {
  private readonly connectionManager: ConnectionManager | undefined;
  private readonly streamRecovery: StreamRecovery | undefined;
  private readonly tokenTracker: TokenTracker | undefined;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(options?: ProviderCallGatewayOptions) {
    this.connectionManager = options?.connectionManager;
    this.tokenTracker = options?.tokenTracker;
    // 只有在提供了 ConnectionManager 时才创建 StreamRecovery
    //（两者配合使用）
    this.streamRecovery = this.connectionManager
      ? new StreamRecovery()
      : undefined;
  }

  private getBreaker(providerId: string): CircuitBreaker {
    if (!this.breakers.has(providerId)) {
      this.breakers.set(providerId, new CircuitBreaker(5, 30000, 1));
    }
    return this.breakers.get(providerId)!;
  }

  /**
   * 执行一次 Provider 调用，汇总流式事件为完整响应。
   *
   * 当 ConnectionManager 可用时：
   * - 自动选择最佳传输通道
   * - 传输失败时自动切换到备用通道（每条通道最多尝试一次）
   * - 流中断时根据中断时机恢复或优雅降级（通过 StreamRecovery）
   *
   * 当 ConnectionManager 不可用时（向后兼容）：
   * - 直接使用传入的 provider 进行裸流式调用
   * - 无自动恢复
   */
  async *call(
    provider: AgentProvider,
    request: AgentProviderRequest
  ): AsyncGenerator<ProviderStreamContractEvent, ProviderCallResult> {
    const breaker = this.getBreaker(provider.id);
    if (!breaker.allowRequest()) {
      throw new CircuitBreakerOpenError(provider.id);
    }

    const streamEvents: ProviderStreamContractEvent[] = [];

    let text = "";
    let thought = "";
    const toolCalls: Array<{ id: string; toolName: string; input: JsonObject }> = [];
    const diagnostics: ProviderDiagnostic[] = [];
    let finishReason: ProviderResponse["finishReason"] = "stop";
    let usage: ProviderResponse["usage"];
    let error: string | undefined;

    // ── 选择流源 ──────────────────────────────────────────

    let rawStream: AsyncIterable<ProviderStreamEvent>;

    if (this.connectionManager && this.streamRecovery) {
      // 使用 StreamRecovery 驱动的流式调用：
      // - ConnectionManager 自动传输选择
      // - StreamRecovery 通道切换重试 + 流中断恢复
      rawStream = this.streamRecovery.streamWithRecovery(
        this.connectionManager,
        request
      );
    } else {
      // 向后兼容：直接使用 provider 的裸流
      rawStream = await retryWithBackoff(
        () => Promise.resolve(provider.stream(request)),
        {
          maxAttempts: 3,
          baseMs: 1000,
          shouldRetry: (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            return /network|timeout|5\d{2}|econnrefused|econnreset|socket/i.test(msg);
          },
        }
      );
    }

    const contractStream = normalizeAndCoalesceProviderStreamEvents(rawStream, {
      coalescing: {}
    });

    // ── 消费流事件 ────────────────────────────────────────

    try {
      for await (const event of contractStream) {
        streamEvents.push(event);
        yield event;

        if (request.signal.aborted) {
          finishReason = "error";
          error = "aborted";
          break;
        }

        if (event.type === "delta" && event.delta.type === "text") {
          text += event.delta.text;
        } else if (event.type === "delta" && event.delta.type === "thought") {
          thought += event.delta.text;
        } else if (event.type === "delta" && event.delta.type === "diagnostic") {
          diagnostics.push(event.delta.diagnostic);
        } else if (event.type === "tool-call" && event.phase === "end") {
          toolCalls.push({
            id: event.toolCall.id ?? createId("call"),
            toolName: event.toolCall.toolName,
            input: event.toolCall.input ?? {}
          });
        } else if (event.type === "end") {
          finishReason = mapFinishReason(event.finishReason);
          usage = event.usage;
          if (event.error) error = event.error.message;
        }
      }
    } catch (err) {
      // StreamRecovery 在所有恢复尝试均失败后抛出 StreamRecoveryError
      if (err instanceof StreamRecoveryError) {
        // 将部分输出作为响应返回（上层可以看到已输出的文字 / 未完成工具调用）
        finishReason = "error";
        error = err.message;
        text = err.accumulator.text || text;
        thought = err.accumulator.thought || thought;
        // Promote pending tool calls so the session loop can pair error tool-results
        // instead of leaving orphan tool_use blocks without results.
        if (err.accumulator.pendingToolCalls.length > 0) {
          const seen = new Set(toolCalls.map((call) => call.id));
          for (const pending of err.accumulator.pendingToolCalls) {
            if (seen.has(pending.id)) continue;
            seen.add(pending.id);
            toolCalls.push({
              id: pending.id,
              toolName: pending.toolName,
              input: pending.input,
            });
          }
        }
        if (err.orphans.length > 0 && finishReason === "error") {
          // Signal that tool-side recovery is preferred over a hard empty error.
          finishReason = toolCalls.length > 0 ? "tool-call" : "error";
        }
      } else {
        // 其他未知错误
        finishReason = "error";
        error = err instanceof Error ? err.message : String(err);
      }
    }

    // 记录断路器结果
    if (finishReason === "error" || error) {
      breaker.onFailure();
    } else {
      breaker.onSuccess();
    }

    const response: ProviderResponse = {
      finishReason,
      text,
      thought: thought || undefined,
      toolCalls,
      diagnostics,
      usage,
      error
    };

    // 将 usage 数据传给 TokenTracker（如果有的话）
    if (usage && this.tokenTracker) {
      this.tokenTracker.record(usage);
    }

    return { response, streamEvents };
  }

  /**
   * 获取关联的 ConnectionManager（如果有）。
   * 用于在外部访问传输统计（持久化、诊断）。
   */
  getConnectionManager(): ConnectionManager | undefined {
    return this.connectionManager;
  }

  /**
   * 获取关联的 TokenTracker（如果有）。
   */
  getTokenTracker(): TokenTracker | undefined {
    return this.tokenTracker;
  }
}

// ─── 内部工具 ─────────────────────────────────────────────

function mapFinishReason(
  reason: string
): ProviderResponse["finishReason"] {
  if (reason === "tool-call" || reason === "length" || reason === "error") return reason;
  if (reason === "cancelled") return "error";
  return "stop";
}
