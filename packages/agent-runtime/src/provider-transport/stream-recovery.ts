/**
 * StreamRecovery — 流中断恢复
 *
 * 当 provider 流中断时，根据中断时机采取不同的恢复策略。
 *
 * 三种情况：
 *  A. 有未完成的工具调用 → 合成孤儿 tool_result（isError: true），让 AI 在下一轮看到并自行处理
 *  B. AI 已输出部分文字 → 不重试（文字已显示给用户，重试会导致模型重复）
 *  C. 什么都没收到 → 换通道重试一次
 *
 * 参考：
 * - Claude Code 的 yieldMissingToolResultBlocks（孤儿 tool_use 合成）
 * - pi-agent-core 的错误走带内结果哲学（"优雅降级，不抛异常"）
 */

import type {
  AgentMessage,
  AgentMessageBlock,
  JsonObject,
  ToolCallBlock,
  ToolOutput,
  ToolResultBlock,
} from "@crish/shared-types";
import type { ProviderStreamEvent } from "../types";
import {
  ConnectionManager,
  StreamInterruptedError,
  type ProviderTransport,
} from "./connection-manager";

// ─── 流式累积状态 ──────────────────────────────────────────

/**
 * 在一次流式调用过程中累积的中间状态。
 * 用于在流中断时判断情况（A/B/C）。
 */
export interface StreamAccumulator {
  /** 已累积的文本内容 */
  text: string;

  /** 已累积的思考内容 */
  thought: string;

  /** 已识别但尚未配对的工具调用 */
  pendingToolCalls: PendingToolCall[];

  /** 已接收到的 provider 诊断 */
  diagnostics: StreamDiagnostic[];

  /** 流开始时间（用于计算延迟） */
  startedAt: number;

  /** 是否已收到至少一个非诊断事件 */
  hasContent: boolean;
}

export interface PendingToolCall {
  id: string;
  toolName: string;
  input: JsonObject;
  /** 是否有对应的 tool_result */
  resolved: boolean;
}

export interface StreamDiagnostic {
  phase: string;
  message: string;
  elapsedMs?: number;
}

// ─── 恢复结果 ──────────────────────────────────────────────

export type RecoveryAction =
  | { type: "retry"; transport: ProviderTransport }
  | { type: "synthesize-orphans"; orphans: ToolResultBlock[] }
  | { type: "surface-error"; message: string }
  | { type: "continue"; reason: string };

export interface RecoveryDecision {
  action: RecoveryAction;
  /** 诊断信息（用于调试日志） */
  diagnostic: string;
}

// ─── 流式会话 ──────────────────────────────────────────────

/**
 * StreamSession 封装了一次带恢复能力的流式调用。
 *
 * 不改变 ProviderCallGateway 的接口——Gateway 仍然用 for-await 消费事件。
 * StreamSession 在 Gateway 的外层或中间层注入。
 */
export class StreamRecovery {
  private accumulator: StreamAccumulator;

  constructor() {
    this.accumulator = this.createAccumulator();
  }

  // ── 公共 API ────────────────────────────────────────────

  /**
   * 使用 ConnectionManager 发起带恢复能力的流式调用。
   *
   * 正常路径：直接 yield provider 事件。
   * 中断路径：根据中断时机决定恢复策略。
   *
   * @param connectionManager - 连接管理器
   * @param request - provider 请求
   * @param existingResults - 已存在的 tool_result（来自之前的调用，用于孤儿检测）
   */
  async *streamWithRecovery(
    connectionManager: ConnectionManager,
    request: Parameters<ConnectionManager["stream"]>[0],
    existingResults: ToolResultBlock[] = []
  ): AsyncGenerator<ProviderStreamEvent> {
    this.accumulator = this.createAccumulator();

    try {
      for await (const event of connectionManager.stream(request)) {
        this.accumulate(event);
        yield event;

        if (request.signal.aborted) {
          // 用户主动取消 → 检查是否有孤儿工具调用
          const orphans = this.findOrphanToolCalls(existingResults);
          if (orphans.length > 0) {
            // 在取消的情况下也合入孤儿结果（不 yield，直接返回）
            // 上层 ConversationEngine 会在下一轮检查这些
          }
          return;
        }
      }

      // 流正常结束 → 检查是否有孤儿工具调用
      const orphans = this.findOrphanToolCalls(existingResults);
      if (orphans.length > 0) {
        // 孤儿结果在下一轮 ConversationEngine 中通过 synthesizeOrphanedToolResults 处理
        // 这里标记流正常结束即可
      }
    } catch (err) {
      // 流中断 → 分析情况并恢复
      const decision = this.decideRecovery(err, connectionManager, existingResults);

      // 记录诊断
      if (this.accumulator.diagnostics.length === 0) {
        this.accumulator.diagnostics.push({
          phase: "stream-recovery",
          message: decision.diagnostic,
        });
      }

      // 执行恢复动作
      switch (decision.action.type) {
        case "retry": {
          // 情况 C：什么都没收到 → 换通道重试
          // 递归调用，但传入新的 transport
          const retryTransport = decision.action.transport;
          try {
            for await (const event of retryTransport.provider.stream(request)) {
              this.accumulate(event);
              yield event;
            }
          } catch (retryErr) {
            // 第二次也失败 → 上报给上层
            throw new StreamRecoveryError(
              `流恢复失败：两个通道均无法完成调用。${err instanceof Error ? err.message : String(err)}`,
              this.accumulator
            );
          }
          break;
        }

        case "synthesize-orphans": {
          // 情况 A：有未完成的工具调用 → 合成孤儿 tool_result
          // 标记流为 tool-call 结束（让 ConversationEngine 处理孤儿合成）
          yield {
            type: "stop",
            reason: "tool-call" as const,
            usage: undefined,
          };
          return;
        }

        case "surface-error": {
          // 情况 B：部分文字输出 → 不重试，让上层处理
          throw new StreamRecoveryError(
            decision.action.message,
            this.accumulator
          );
        }

        case "continue": {
          // 不应该到达这里，但如果有就继续
          return;
        }
      }
    }
  }

  /**
   * 获取当前累积状态（只读）。
   */
  getAccumulator(): Readonly<StreamAccumulator> {
    return this.accumulator;
  }

  // ── 内部方法 ────────────────────────────────────────────

  /**
   * 从流事件中累积状态。
   */
  private accumulate(event: ProviderStreamEvent): void {
    switch (event.type) {
      case "text-delta":
        this.accumulator.text += event.text;
        this.accumulator.hasContent = true;
        break;

      case "thought-delta":
        this.accumulator.thought += event.text;
        this.accumulator.hasContent = true;
        break;

      case "tool-call":
        this.accumulator.pendingToolCalls.push({
          id: event.id ?? `call-${Date.now()}`,
          toolName: event.toolName,
          input: event.input,
          resolved: false,
        });
        this.accumulator.hasContent = true;
        break;

      case "provider-diagnostic":
        this.accumulator.diagnostics.push({
          phase: event.diagnostic.phase,
          message: event.diagnostic.reason ?? "provider diagnostic",
          elapsedMs: event.diagnostic.elapsedMs,
        });
        break;

      case "stop":
        // stop 事件标记流结束，不累积内容
        break;
    }
  }

  /**
   * 找出没有配对的工具调用（孤儿）。
   *
   * 孤儿 = pendingToolCalls 中 resolved=false 且不在 existingResults 中的调用。
   */
  private findOrphanToolCalls(
    existingResults: ToolResultBlock[]
  ): ToolResultBlock[] {
    const resolvedIds = new Set(existingResults.map((r) => r.toolCallId));
    const orphans: ToolResultBlock[] = [];

    for (const pending of this.accumulator.pendingToolCalls) {
      if (!resolvedIds.has(pending.id)) {
        orphans.push({
          type: "tool-result",
          toolCallId: pending.id,
          toolName: pending.toolName,
          output: {
            text: JSON.stringify({
              error: "工具调用因流中断未能完成执行",
              toolName: pending.toolName,
            }),
          },
          isError: true,
        });
      }
    }

    return orphans;
  }

  /**
   * 根据中断时的累积状态决定恢复策略。
   */
  private decideRecovery(
    error: unknown,
    connectionManager: ConnectionManager,
    existingResults: ToolResultBlock[]
  ): RecoveryDecision {
    const isStreamInterrupted = error instanceof StreamInterruptedError;
    const transportId = isStreamInterrupted
      ? error.transportId
      : "unknown";

    // 情况 A：有未完成的工具调用
    const orphans = this.findOrphanToolCalls(existingResults);
    if (orphans.length > 0) {
      const toolNames = orphans.map((o) => o.toolName).join(", ");
      return {
        action: { type: "synthesize-orphans", orphans },
        diagnostic: `流中断时有未完成的工具调用 [${toolNames}]，合成孤儿 tool_result (isError: true) 让 AI 自行处理`,
      };
    }

    // 情况 B：AI 已输出部分文字 → 不重试
    if (this.accumulator.text.length > 0 || this.accumulator.thought.length > 0) {
      const contentDesc =
        this.accumulator.text.length > 0
          ? `文本 ${this.accumulator.text.length} 字符`
          : `思考内容 ${this.accumulator.thought.length} 字符`;
      return {
        action: {
          type: "surface-error",
          message: `响应被中断（已输出${contentDesc}）。请检查网络后重试。`,
        },
        diagnostic: `流中断时已有内容输出（${contentDesc}），不重试以避免模型重复`,
      };
    }

    // 情况 C：什么都没收到 → 换通道重试一次
    const nextTransport = connectionManager.selectNext(transportId);
    if (nextTransport) {
      return {
        action: { type: "retry", transport: nextTransport },
        diagnostic: `流中断时未收到任何内容，切换到备用通道 "${nextTransport.id}" (${nextTransport.kind})`,
      };
    }

    // 没有备用通道
    return {
      action: {
        type: "surface-error",
        message: "无法连接，请检查网络。所有可用通道均已尝试。",
      },
      diagnostic: "流中断时未收到任何内容，且没有备用通道可用",
    };
  }

  /**
   * 创建新的累积器实例。
   */
  private createAccumulator(): StreamAccumulator {
    return {
      text: "",
      thought: "",
      pendingToolCalls: [],
      diagnostics: [],
      startedAt: Date.now(),
      hasContent: false,
    };
  }
}

// ─── 孤儿 tool_use 合成工具函数 ────────────────────────────

/**
 * 从 assistant message 中找出没有配对的 tool-call，合成为 tool-result。
 *
 * 这是 StreamRecovery 的核心工具函数之一，
 * 被 ConversationEngine 和 runtime.ts 的异常退出路径共同使用。
 *
 * 参考 Claude Code 的 yieldMissingToolResultBlocks 模式。
 */
export function synthesizeOrphanedToolResults(
  assistantMessage: AgentMessage,
  existingResults: ToolResultBlock[]
): ToolResultBlock[] {
  const toolCalls = assistantMessage.blocks.filter(
    (b): b is ToolCallBlock => b.type === "tool-call"
  );
  const resolvedIds = new Set(existingResults.map((r) => r.toolCallId));

  return toolCalls
    .filter((tc) => !resolvedIds.has(tc.id))
    .map((tc) => ({
      type: "tool-result" as const,
      toolCallId: tc.id,
      toolName: tc.toolName,
      output: {
        text: JSON.stringify({
          error: `工具 "${tc.toolName}" 因流中断未能完成执行`,
          toolCallId: tc.id,
        }),
      } as ToolOutput,
      isError: true,
    }));
}

/**
 * 从已累积的 pendingToolCalls 中合成孤儿 tool_result。
 * 用于流中断场景（情况 A）。
 */
export function synthesizeOrphansFromPending(
  pendingToolCalls: PendingToolCall[],
  existingResults: ToolResultBlock[]
): ToolResultBlock[] {
  const resolvedIds = new Set(existingResults.map((r) => r.toolCallId));

  return pendingToolCalls
    .filter((tc) => !resolvedIds.has(tc.id))
    .map((tc) => ({
      type: "tool-result" as const,
      toolCallId: tc.id,
      toolName: tc.toolName,
      output: {
        text: JSON.stringify({
          error: "工具调用因流中断未能完成执行",
          toolName: tc.toolName,
          toolCallId: tc.id,
        }),
      } as ToolOutput,
      isError: true,
    }));
}

// ─── 错误类型 ──────────────────────────────────────────────

/**
 * 流恢复错误：经过所有恢复尝试后仍然失败。
 * 包含累积状态以便上层做最终处理（如显示部分输出给用户）。
 */
export class StreamRecoveryError extends Error {
  public readonly accumulator: StreamAccumulator;

  constructor(message: string, accumulator: StreamAccumulator) {
    super(message);
    this.name = "StreamRecoveryError";
    this.accumulator = accumulator;
  }
}
