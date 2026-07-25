/**
 * StreamRecovery �?流中断恢�? *
 * �?provider 流中断时，根据中断时机采取不同的恢复策略�? *
 * 三种情况�? *  A. 有未完成的工具调�?�?合成孤儿 tool_result（isError: true），�?AI 在下一轮看到并自行处理
 *  B. AI 已输出部分文�?�?不重试（文字已显示给用户，重试会导致模型重复�? *  C. 什么都没收�?�?换通道重试一�? *
 * 参考：
 * - Claude Code �?yieldMissingToolResultBlocks（孤�?tool_use 合成�? * - pi-agent-core 的错误走带内结果哲学�?优雅降级，不抛异�?�? */

import type {
  AgentMessage,
  JsonObject,
  ToolCallBlock,
  ToolOutput,
  ToolResultBlock,
} from "@crish/shared-types";
import { AsyncMutex } from "@crish/shared-utils";
import type { ProviderStreamEvent } from "../types";
import type { ProviderStreamContractEvent } from "../provider-stream-contract";
import {
  ConnectionError,
  ConnectionManager,
  StreamInterruptedError,
  type ProviderTransport,
} from "./connection-manager";

// ─── 流式累积状�?──────────────────────────────────────────

/**
 * 在一次流式调用过程中累积的中间状态�? * 用于在流中断时判断情况（A/B/C）�? */
export interface StreamAccumulator {
  /** 已累积的文本内容 */
  text: string;

  /** 已累积的思考内�?*/
  thought: string;

  /** 已识别但尚未配对的工具调�?*/
  pendingToolCalls: PendingToolCall[];

  /** 已接收到�?provider 诊断 */
  diagnostics: StreamDiagnostic[];

  /** 流开始时间（用于计算延迟�?*/
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
  | { type: "retry"; transport: ProviderTransport; retryAfterMs?: number; resumeToken?: string }
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
 * StreamSession 封装了一次带恢复能力的流式调用�? *
 * 不改�?ProviderCallGateway 的接口——Gateway 仍然�?for-await 消费事件�? * StreamSession �?Gateway 的外层或中间层注入�? */
export class StreamRecovery {
  private accumulator: StreamAccumulator;
  /** Stable counter for tool-call events missing an id (avoids Date.now collisions). */
  private missingToolCallSeq = 0;
  private retryCount = 0;
  private readonly mutex = new AsyncMutex();

  constructor() {
    this.accumulator = this.createAccumulator();
  }

  // ── 公共 API ────────────────────────────────────────────

  /**
   * 使用 ConnectionManager 发起带恢复能力的流式调用�?   *
   * 正常路径：直�?yield provider 事件�?   * 中断路径：根据中断时机决定恢复策略�?   *
   * @param connectionManager - 连接管理�?   * @param request - provider 请求
   * @param existingResults - 已存在的 tool_result（来自之前的调用，用于孤儿检测）
   */
  async *streamWithRecovery(
    connectionManager: ConnectionManager,
    request: Parameters<ConnectionManager["stream"]>[0],
    existingResults: ToolResultBlock[] = []
  ): AsyncGenerator<ProviderStreamEvent> {
    const release = await this.mutex.acquire();
    try {
      this.accumulator = this.createAccumulator();
      this.missingToolCallSeq = 0;
      this.retryCount = 0;

      for await (const event of connectionManager.stream(request)) {
        this.accumulate(toContractEvent(event));
        yield event;

        if (request.signal.aborted) {
          // 用户取消：若已有未配�?tool-call，把孤儿结果带出，避免下一轮悬�?tool_use
          const orphans = this.findOrphanToolCalls(existingResults);
          if (orphans.length > 0) {
            throw new StreamRecoveryError(
              "流已取消，合成未完成工具调用的错误结果",
              this.accumulator,
              orphans
            );
          }
          return;
        }
      }

      // 流正常结束但 provider 未配 tool_result：仍合成孤儿，避免会话层挂死
      const orphans = this.findOrphanToolCalls(existingResults);
      if (orphans.length > 0) {
        throw new StreamRecoveryError(
          "流正常结束但仍有未配对工具调用，合成孤儿 tool_result",
          this.accumulator,
          orphans
        );
      }
    } catch (err) {
      // Already a recovery decision with orphans/partial content �?rethrow as-is.
      if (err instanceof StreamRecoveryError) {
        throw err;
      }

      // 分析情况并恢复
      const decision = this.decideRecovery(err, connectionManager, existingResults, request.signal);

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
          // 情况 C：什么都没收�?�?换通道重试（指数退避）
          if (request.signal.aborted) {
            throw new StreamRecoveryError(
              "流恢复取消：备用通道重试前已 abort",
              this.accumulator
            );
          }
          this.retryCount++;
          const delay = decision.action.retryAfterMs ?? Math.min(1000 * 2 ** (this.retryCount - 1), 30000);
          await sleep(delay);
          const retryTransport = decision.action.transport;
          try {
            for await (const event of retryTransport.provider.stream(request)) {
              this.accumulate(toContractEvent(event));
              yield event;
              if (request.signal.aborted) {
                const orphans = this.findOrphanToolCalls(existingResults);
                if (orphans.length > 0) {
                  throw new StreamRecoveryError(
                    "备用通道流已取消，合成未完成工具调用的错误结果",
                    this.accumulator,
                    orphans
                  );
                }
                return;
              }
            }
            const orphansAfterRetry = this.findOrphanToolCalls(existingResults);
            if (orphansAfterRetry.length > 0) {
              throw new StreamRecoveryError(
                "备用通道结束但仍有未配对工具调用，合成孤�?tool_result",
                this.accumulator,
                orphansAfterRetry
              );
            }
          } catch (retryErr) {
            if (retryErr instanceof StreamRecoveryError) throw retryErr;
            // 第二次也失败 — 上报给上层
            throw new StreamRecoveryError(
              `流恢复失败：两个通道均无法完成调用�?{err instanceof Error ? err.message : String(err)}`,
              this.accumulator
            );
          }
          break;
        }

        case "synthesize-orphans": {
          // 情况 A：有未完成的工具调用 — 把孤儿结果挂到错误上交给 Gateway / 会话
          throw new StreamRecoveryError(
            decision.diagnostic,
            this.accumulator,
            decision.action.orphans
          );
        }

        case "surface-error": {
          // 情况 B：部分文字输出 — 不重试，让上层处理
          throw new StreamRecoveryError(
            decision.action.message,
            this.accumulator
          );
        }

        case "continue": {
          // 不应该到达这里，但如果有就继�?          return;
        }
      }
    } finally {
      release();
    }
  }

  /**
   * 获取当前累积状态（只读）�?   */
  getAccumulator(): Readonly<StreamAccumulator> {
    return this.accumulator;
  }

  // ── 内部方法 ────────────────────────────────────────────

  /**
   * 从流事件中累积状态�?   */
  private accumulate(event: ProviderStreamContractEvent): void {
    switch (event.type) {
      case "delta": {
        const delta = event.delta;
        if (delta.type === "text") {
          this.accumulator.text += typeof delta.text === "string" ? delta.text : "";
          this.accumulator.hasContent = true;
        } else if (delta.type === "thought") {
          this.accumulator.thought += typeof delta.text === "string" ? delta.text : "";
          this.accumulator.hasContent = true;
        } else if (delta.type === "diagnostic") {
          this.accumulator.diagnostics.push({
            phase: delta.diagnostic.phase,
            message: delta.diagnostic.reason ?? "provider diagnostic",
            ...(delta.diagnostic.elapsedMs !== undefined ? { elapsedMs: delta.diagnostic.elapsedMs } : {}),
          });
        }
        break;
      }

      case "tool-call": {
        if (event.phase === "end") {
          const tc = event.toolCall;
          const rawId = typeof tc.id === "string" ? tc.id.trim() : "";
          const id =
            rawId.length > 0 ? rawId : `call-missing-${++this.missingToolCallSeq}`;
          const toolName =
            typeof tc.toolName === "string" && tc.toolName.trim().length > 0
              ? tc.toolName.trim()
              : "unknown-tool";
          const input =
            tc.input && typeof tc.input === "object" && !Array.isArray(tc.input)
              ? tc.input
              : {};
          this.accumulator.pendingToolCalls.push({
            id,
            toolName,
            input,
            resolved: false,
          });
          this.accumulator.hasContent = true;
        }
        break;
      }

      case "start":
      case "end":
      case "done":
        // 边界事件标记流阶段，不累积内容
        break;

      case "error":
        // provider 错误事件，不累积内容
        break;
    }
  }

  /**
   * 找出没有配对的工具调用（孤儿）�?   *
   * 孤儿 = pendingToolCalls �?resolved=false 且不�?existingResults 中的调用�?   * 同一 toolCallId 只合成一次�?   */
  private findOrphanToolCalls(
    existingResults: ToolResultBlock[]
  ): ToolResultBlock[] {
    const resolvedIds = new Set(
      existingResults
        .map((r) => r.toolCallId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    );
    const seen = new Set<string>();
    const orphans: ToolResultBlock[] = [];

    for (const pending of this.accumulator.pendingToolCalls) {
      if (pending.resolved) {
        resolvedIds.add(pending.id);
        continue;
      }
      if (!pending.id || resolvedIds.has(pending.id) || seen.has(pending.id)) {
        continue;
      }
      seen.add(pending.id);
      orphans.push({
        type: "tool-result",
        toolCallId: pending.id,
        toolName: pending.toolName,
        output: {
          text: JSON.stringify({
            error: "工具调用因流中断未能完成执行",
            toolName: pending.toolName,
            toolCallId: pending.id,
          }),
        },
        isError: true,
      });
    }

    return orphans;
  }

  /**
   * 根据中断时的累积状态决定恢复策略�?   */
  private decideRecovery(
    error: unknown,
    connectionManager: ConnectionManager,
    existingResults: ToolResultBlock[],
    signal?: AbortSignal
  ): RecoveryDecision {
    const isStreamInterrupted = error instanceof StreamInterruptedError;
    const transportId = isStreamInterrupted
      ? error.transportId
      : "unknown";

    // 情况 A：有未完成的工具调用（优先于文字，避免 tool_use 悬挂）
    const orphans = this.findOrphanToolCalls(existingResults);
    if (orphans.length > 0) {
      const toolNames = orphans.map((o) => o.toolName).join(", ");
      return {
        action: { type: "synthesize-orphans", orphans },
        diagnostic: `流中断时有未完成的工具调�?[${toolNames}]，合成孤�?tool_result (isError: true) �?AI 自行处理`,
      };
    }

    // Transient network errors check — before Case B so ECONNRESET etc get retry with backoff
    const TRANSIENT_ERRORS = ['ECONNRESET', 'socket hang up', 'ETIMEDOUT', 'ECONNREFUSED'];
    const isTransientNetworkError = error && TRANSIENT_ERRORS.some(e =>
      (error as any).message?.includes(e) || (error as any).code === e
    );

    if (isTransientNetworkError) {
      const nextTransport = connectionManager.selectNext(transportId);
      if (nextTransport) {
        return {
          action: {
            type: "retry",
            transport: nextTransport,
            retryAfterMs: Math.min(1000 * 2 ** this.retryCount, 30000),
            resumeToken: this.buildResumeToken(),
          },
          diagnostic: `暂态网络错误 (${error instanceof Error ? error.message : String(error)})，指数退避后重试`,
        };
      }
    }

    // 情况 B：AI 已输出部分文字 — 不重试
    if (this.accumulator.text.length > 0 || this.accumulator.thought.length > 0) {
      const _desc =
        this.accumulator.text.length > 0
          ? `text ${this.accumulator.text.length} chars`
          : `thought ${this.accumulator.thought.length} chars`;
      return {
        action: {
          type: "surface-error",
          message: `Response interrupted after ${_desc}. Check network and retry.`,
        },
        diagnostic: `Stream had content (${_desc}), not retrying to avoid duplication`,
      };
    }

    // ConnectionManager already exhausted every transport �?do not re-pick a failed one.
    if (error instanceof ConnectionError) {
      return {
        action: {
          type: "surface-error",
          message: error.message || "无法连接，请检查网络。所有可用通道均已尝试",
        },
        diagnostic: `所有传输通道已耗尽 (${error.code})，停止恢复`,
      };
    }

    // �?abort：无内容也不再换通道
    if (signal?.aborted) {
      return {
        action: {
          type: "surface-error",
          message: "请求已取消",
        },
        diagnostic: "流中断时 signal �?abort，跳过备用通道",
      };
    }

    // 情况 C：什么都没收到 — 换通道重试一次
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
        message: "无法连接，请检查网络。所有可用通道均已尝试",
      },
      diagnostic: "流中断时未收到任何内容，且没有备用通道可用",
    };
  }

  /**
   * 从当前已收到的文本构建断点标记，用于重试时携带 */
  private buildResumeToken(): string {
    return JSON.stringify({
      textLength: this.accumulator.text.length,
      thoughtLength: this.accumulator.thought.length,
    });
  }

  /**
   * 创建新的累积器实例 */
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

/**
 * 将旧的 ProviderStreamEvent 映射为新的 ProviderStreamContractEvent
 * 用于过渡期：ConnectionManager 尚输出旧事件类型
 */
function toContractEvent(event: ProviderStreamEvent): ProviderStreamContractEvent {
  switch (event.type) {
    case "text-delta":
      return {
        type: "delta",
        sequence: 0,
        delta: { type: "text", text: event.text },
      } as ProviderStreamContractEvent;
    case "thought-delta":
      return {
        type: "delta",
        sequence: 0,
        delta: {
          type: "thought",
          text: event.text,
          ...(event.redacted !== undefined ? { redacted: event.redacted } : {}),
        },
      } as ProviderStreamContractEvent;
    case "tool-call":
      return {
        type: "tool-call",
        sequence: 0,
        phase: "end",
        toolCall: {
          ...(event.id !== undefined ? { id: event.id } : {}),
          toolName: event.toolName,
          argumentsText: JSON.stringify(event.input),
          input: event.input,
        },
      } as unknown as ProviderStreamContractEvent;
    case "provider-diagnostic":
      return {
        type: "delta",
        sequence: 0,
        delta: { type: "diagnostic", diagnostic: event.diagnostic },
      } as ProviderStreamContractEvent;
    case "stop":
      if (event.reason === "error") {
        return {
          type: "error",
          sequence: 0,
          error: {
            kind: "unknown",
            message: event.error ?? "Provider stream stopped with error",
            retryable: false,
          },
        } as ProviderStreamContractEvent;
      }
      return {
        type: "end",
        sequence: 0,
        finishReason: event.reason === "tool-call" ? "tool-call" : event.reason === "length" ? "length" : "stop",
        ...(event.usage !== undefined ? { usage: event.usage } : {}),
        ...(event.error !== undefined ? { error: { kind: "unknown", message: event.error, retryable: false } } : {}),
      } as ProviderStreamContractEvent;
  }
}

// ─── 孤儿 tool_use 合成工具函数 ────────────────────────────

/**
 * �?assistant message 中找出没有配对的 tool-call，合成为 tool-result�? *
 * 这是 StreamRecovery 的核心工具函数之一�? * �?ConversationEngine �?runtime.ts 的异常退出路径共同使用�? *
 * 参�?Claude Code �?yieldMissingToolResultBlocks 模式�? */
export function synthesizeOrphanedToolResults(
  assistantMessage: AgentMessage,
  existingResults: ToolResultBlock[]
): ToolResultBlock[] {
  const toolCalls = (assistantMessage.blocks ?? []).filter(
    (b): b is ToolCallBlock => b.type === "tool-call"
  );
  const resolvedIds = new Set(
    existingResults
      .map((r) => r.toolCallId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );
  const seen = new Set<string>();

  return toolCalls
    .filter((tc) => {
      const id = typeof tc.id === "string" ? tc.id : "";
      if (!id || resolvedIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((tc) => ({
      type: "tool-result" as const,
      toolCallId: tc.id,
      toolName:
        typeof tc.toolName === "string" && tc.toolName.trim().length > 0
          ? tc.toolName
          : "unknown-tool",
      output: {
        text: JSON.stringify({
          error: `工具 "${tc.toolName || "unknown-tool"}" 因流中断未能完成执行`,
          toolCallId: tc.id,
        }),
      } as ToolOutput,
      isError: true,
    }));
}

/**
 * 从已累积�?pendingToolCalls 中合成孤�?tool_result�? * 用于流中断场景（情况 A）�? */
export function synthesizeOrphansFromPending(
  pendingToolCalls: PendingToolCall[],
  existingResults: ToolResultBlock[]
): ToolResultBlock[] {
  const resolvedIds = new Set(
    existingResults
      .map((r) => r.toolCallId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );
  const seen = new Set<string>();

  return pendingToolCalls
    .filter((tc) => {
      if (tc.resolved) return false;
      if (!tc.id || resolvedIds.has(tc.id) || seen.has(tc.id)) return false;
      seen.add(tc.id);
      return true;
    })
    .map((tc) => ({
      type: "tool-result" as const,
      toolCallId: tc.id,
      toolName: tc.toolName || "unknown-tool",
      output: {
        text: JSON.stringify({
          error: "工具调用因流中断未能完成执行",
          toolName: tc.toolName || "unknown-tool",
          toolCallId: tc.id,
        }),
      } as ToolOutput,
      isError: true,
    }));
}

// ─── 工具函数 ──────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── 全局统计 ──────────────────────────────────────────────

export interface StreamRecoveryGlobalStats {
  activeRecoveries: number;
  totalRecoveries: number;
  totalRetries: number;
  totalSynthesizedOrphans: number;
}

export class StreamRecoveryGlobalRegistry {
  private static instance: StreamRecoveryGlobalRegistry;
  private activeRecoveries = 0;
  private totalRecoveries = 0;
  private totalRetries = 0;
  private totalSynthesizedOrphans = 0;

  private constructor() {}

  static getInstance(): StreamRecoveryGlobalRegistry {
    if (!StreamRecoveryGlobalRegistry.instance) {
      StreamRecoveryGlobalRegistry.instance = new StreamRecoveryGlobalRegistry();
    }
    return StreamRecoveryGlobalRegistry.instance;
  }

  recordRecovery(hasRetry: boolean, orphanCount: number): void {
    this.activeRecoveries++;
    this.totalRecoveries++;
    if (hasRetry) this.totalRetries++;
    this.totalSynthesizedOrphans += orphanCount;
  }

  completeRecovery(): void {
    this.activeRecoveries = Math.max(0, this.activeRecoveries - 1);
  }

  getGlobalStatsSync(): StreamRecoveryGlobalStats {
    return {
      activeRecoveries: this.activeRecoveries,
      totalRecoveries: this.totalRecoveries,
      totalRetries: this.totalRetries,
      totalSynthesizedOrphans: this.totalSynthesizedOrphans,
    };
  }
}

// ─── 错误类型 ──────────────────────────────────────────────

/**
 * 流恢复错误：经过所有恢复尝试后仍然失败�? * 包含累积状态以便上层做最终处理（如显示部分输出给用户）�? */
export class StreamRecoveryError extends Error {
  public readonly accumulator: StreamAccumulator;
  /** Orphan tool-results synthesized for incomplete tool_use (case A). */
  public readonly orphans: ToolResultBlock[];

  constructor(
    message: string,
    accumulator: StreamAccumulator,
    orphans: ToolResultBlock[] = []
  ) {
    super(message);
    this.name = "StreamRecoveryError";
    this.accumulator = accumulator;
    this.orphans = orphans;
  }
}
