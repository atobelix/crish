/**
 * Tool Hook 可观测性 — 自动发射 tool-hook-* 结构化事件
 *
 * 将所有注册的 ToolHook 包装为带有可观测性的版本：
 * 在每个 Hook 点实际调用前后自动产生结构化事件，包含 traceId。
 *
 * 产生的 3 类事件：
 * - tool-hook-before-execute
 * - tool-hook-on-result
 * - tool-hook-on-error
 */

import type { ToolExecutionContext } from "@crish/shared-types";
import { getTraceContext } from "@crish/telemetry";
import type { ToolHook, BeforeExecuteResult, OnErrorResult, ToolResult } from "./tool-hook-types";

// ─── ToolHook 上下文（扩展执行上下文） ──────────────────────────────

export interface ToolHookContext extends ToolExecutionContext {
  toolName?: string;
}

// ─── 结构化事件类型 ────────────────────────────────────────────

export interface ToolHookEventBase {
  traceId: string;
  hookName: string;
  timestamp: string;
  durationMs: number;
  sessionId: string;
}

export interface ToolHookBeforeExecuteEvent extends ToolHookEventBase {
  type: "tool-hook-before-execute";
  payload: Record<string, unknown>;
}

export interface ToolHookOnResultEvent extends ToolHookEventBase {
  type: "tool-hook-on-result";
  payload: Record<string, unknown>;
}

export interface ToolHookOnErrorEvent extends ToolHookEventBase {
  type: "tool-hook-on-error";
  payload: Record<string, unknown>;
}

export type ToolHookObservabilityEvent =
  | ToolHookBeforeExecuteEvent
  | ToolHookOnResultEvent
  | ToolHookOnErrorEvent;

export type ToolHookEventHandler = (event: ToolHookObservabilityEvent) => void;

export const TOOL_HOOK_EVENT_TYPES: readonly string[] = [
  "tool-hook-before-execute",
  "tool-hook-on-result",
  "tool-hook-on-error",
] as const;

// ─── 可观测性包装器 ───────────────────────────────────────────

/**
 * ToolHookObserver — 为 ToolHook 链注入可观测性事件发射。
 *
 * 包装现有的 ToolHook 实现，在每个 Hook 点自动产生对应的
 * tool-hook-* 事件并调用 emit 回调。
 */
export class ToolHookObserver<TInput = unknown, TOutput = unknown> {
  private readonly wrapped: ToolHook<TInput, TOutput>;
  private readonly emit: ToolHookEventHandler;
  private readonly sessionId: string;

  constructor(
    wrapped: ToolHook<TInput, TOutput>,
    emit: ToolHookEventHandler,
    sessionId: string,
  ) {
    this.wrapped = wrapped;
    this.emit = emit;
    this.sessionId = sessionId;
  }

  beforeExecute(input: TInput, ctx: ToolHookContext): BeforeExecuteResult | Promise<BeforeExecuteResult> | undefined {
    const trace = getTraceContext();
    const startedAt = Date.now();
    const result = this.wrapped.beforeExecute?.(input, ctx);
    this.emit({
      type: "tool-hook-before-execute",
      traceId: trace?.traceId ?? ctx.traceId ?? "unknown",
      hookName: "beforeExecute",
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      sessionId: this.sessionId,
      payload: payloadWithToolName(ctx.toolName),
    });
    return result;
  }

  onResult(result: unknown, ctx: ToolHookContext): ToolResult<TOutput> | Promise<ToolResult<TOutput>> | undefined {
    const trace = getTraceContext();
    const startedAt = Date.now();
    const hookResult = this.wrapped.onResult?.(result as ToolResult<TOutput>, ctx);
    this.emit({
      type: "tool-hook-on-result",
      traceId: trace?.traceId ?? ctx.traceId ?? "unknown",
      hookName: "onResult",
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      sessionId: this.sessionId,
      payload: { ...payloadWithToolName(ctx.toolName), hadError: result instanceof Error },
    });
    return hookResult;
  }

  onError(error: Error, ctx: ToolHookContext): OnErrorResult | Promise<OnErrorResult> | undefined {
    const trace = getTraceContext();
    const startedAt = Date.now();
    const hookResult = this.wrapped.onError?.(error, ctx);
    this.emit({
      type: "tool-hook-on-error",
      traceId: trace?.traceId ?? ctx.traceId ?? "unknown",
      hookName: "onError",
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      sessionId: this.sessionId,
      payload: { error: error.message, ...payloadWithToolName(ctx.toolName) },
    });
    return hookResult;
  }
}

// ─── 工厂函数 ────────────────────────────────────────────────

/**
 * 包装 ToolHook 链使其每个 Hook 点产生可观测性事件。
 *
 * @param hook - 原始的 ToolHook 实现
 * @param onEvent - 事件回调（通常调用 emit 将事件注入事件流）
 * @param sessionId - 当前会话 ID
 * @returns 注入可观测性后的 ToolHook
 */
export function observeToolHook<TInput = unknown, TOutput = unknown>(
  hook: ToolHook<TInput, TOutput>,
  onEvent: ToolHookEventHandler,
  sessionId: string,
): ToolHook<TInput, TOutput> {
  const observer = new ToolHookObserver(hook, onEvent, sessionId);

  return {
    beforeExecute: (input: TInput, ctx: ToolExecutionContext): BeforeExecuteResult | Promise<BeforeExecuteResult> => observer.beforeExecute(input, ctx as ToolHookContext) ?? { status: "approved" },
    onResult: (result: ToolResult<TOutput>, ctx: ToolExecutionContext): ToolResult<TOutput> | Promise<ToolResult<TOutput>> => observer.onResult(result, ctx as ToolHookContext) ?? { output: result.output, isError: false, durationMs: 0 },
    onError: (error: Error, ctx: ToolExecutionContext): OnErrorResult | Promise<OnErrorResult> => observer.onError(error, ctx as ToolHookContext) ?? { action: "abort" },
  };
}

// ─── 工具函数 ────────────────────────────────────────────────

type OptionalPayload = Record<string, unknown>;

function payloadWithToolName(toolName: string | undefined): OptionalPayload {
  return toolName !== undefined ? { toolName } : {};
}
