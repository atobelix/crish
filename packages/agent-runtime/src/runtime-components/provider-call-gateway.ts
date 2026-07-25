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

  constructor(options?: ProviderCallGatewayOptions) {
    this.connectionManager = options?.connectionManager;
    this.tokenTracker = options?.tokenTracker;
    // 只有在提供了 ConnectionManager 时才创建 StreamRecovery
    //（两者配合使用）
    this.streamRecovery = this.connectionManager
      ? new StreamRecovery()
      : undefined;
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
    if (request.signal.aborted) {
      return { response: { finishReason: "error", text: "", toolCalls: [], diagnostics: [], error: "aborted" }, streamEvents: [] };
    }

    const streamEvents: ProviderStreamContractEvent[] = [];

    let text = "";
    let thought = "";
    const toolCalls: Array<{ id: string; toolName: string; input: JsonObject }> = [];
    const diagnostics: ProviderDiagnostic[] = [];
    let finishReason: ProviderResponse["finishReason"] = "stop";
    let usage: ProviderResponse["usage"];
    let error: string | undefined;

    let rawStream: AsyncIterable<ProviderStreamEvent> | undefined;
    let contractStream: AsyncGenerator<ProviderStreamContractEvent> | undefined;
    try {
      rawStream = await this.selectStreamSource(provider, request);
      contractStream = normalizeAndCoalesceProviderStreamEvents(rawStream, { coalescing: {} });

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
      this.handleStreamError(err, toolCalls, (r, errorMsg, t, th) => {
        finishReason = r;
        if (errorMsg !== undefined) error = errorMsg;
        if (t !== undefined) text = t;
        if (th !== undefined) thought = th;
      });
      const errorMsg = error ?? (err instanceof Error ? err.message : String(err));
      const errorEvent: ProviderStreamContractEvent = {
        type: "end",
        finishReason: "error",
        error: { kind: "unknown", message: errorMsg, retryable: false },
      } as unknown as ProviderStreamContractEvent;
      streamEvents.push(errorEvent);
      yield errorEvent;
    } finally {
      if (contractStream && typeof (contractStream as any).return === "function") {
        await (contractStream as any).return(undefined).catch(() => undefined);
      }
      if (rawStream && typeof (rawStream as any).return === "function") {
        await (rawStream as any).return(undefined).catch(() => undefined);
      }
    }

    const response: ProviderResponse = {
      finishReason,
      text,
      ...(thought ? { thought } : {}),
      toolCalls,
      diagnostics,
      ...(usage ? { usage } : {}),
      ...(error ? { error } : {}),
    };

    if (usage && this.tokenTracker) {
      this.tokenTracker.record(usage);
    }

    return { response, streamEvents };
  }

  private async selectStreamSource(
    provider: AgentProvider,
    request: AgentProviderRequest
  ): Promise<AsyncIterable<ProviderStreamEvent>> {
    if (this.connectionManager && this.streamRecovery) {
      return this.streamRecovery.streamWithRecovery(this.connectionManager, request);
    }
    return this.retryProviderStream(provider, request);
  }

  private async retryProviderStream(
    provider: AgentProvider,
    request: AgentProviderRequest
  ): Promise<AsyncIterable<ProviderStreamEvent>> {
    const { signal } = request;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      try {
        return await Promise.resolve(provider.stream(request));
      } catch (err) {
        if (attempt >= 3) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!/network|timeout|5\d{2}|econnrefused|econnreset|socket/i.test(msg)) throw err;
        if (signal.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt - 1), 30000)));
      }
    }
    throw new Error("retryProviderStream: unreachable");
  }

  private handleStreamError(
    err: unknown,
    toolCalls: Array<{ id: string; toolName: string; input: JsonObject }>,
    setState: (finishReason: ProviderResponse["finishReason"], error?: string, text?: string, thought?: string) => void
  ): void {
    if (err instanceof StreamRecoveryError) {
      setState("error", err.message, err.accumulator.text, err.accumulator.thought);
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
      if (err.orphans.length > 0) {
        setState(toolCalls.length > 0 ? "tool-call" : "error", err.message);
      }
    } else {
      setState("error", err instanceof Error ? err.message : String(err));
    }
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
