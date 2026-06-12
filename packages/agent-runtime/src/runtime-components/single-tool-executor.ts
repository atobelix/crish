import type { ToolCallBlock, ToolExecutionContext, ToolOutput, JsonObject } from "@crish/shared-types";
import { combineAbortSignals } from "@crish/shared-utils";

export interface ToolMiddlewareHook {
  beforeExecute?(toolCall: ToolCallBlock, ctx: ToolExecutionContext): Promise<{ proceed: boolean; reason?: string; modifiedInput?: JsonObject }>;
  afterExecute?(toolCall: ToolCallBlock, ctx: ToolExecutionContext, output: ToolOutput): Promise<ToolOutput>;
}

export class SingleToolExecutor {
  constructor(
    private readonly timeoutMs: number,
    private readonly hooks: ToolMiddlewareHook[],
  ) {}

  async execute(
    toolCall: ToolCallBlock,
    executeFn: (input: JsonObject, ctx: ToolExecutionContext) => Promise<ToolOutput>,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<{ output: ToolOutput; isError: boolean }> {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(new Error(`Timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    const combinedSignal = combineAbortSignals(signal, timeoutController.signal);

    let effectiveInput = toolCall.input;

    for (const hook of this.hooks) {
      if (hook.beforeExecute) {
        const result = await hook.beforeExecute(toolCall, { ...context, signal: combinedSignal });
        if (!result.proceed) return { output: { text: result.reason ?? "Blocked by hook" }, isError: true };
        if (result.modifiedInput) effectiveInput = result.modifiedInput;
      }
    }

    let output: ToolOutput;
    let isError = false;

    try {
      output = await Promise.race([
        executeFn(effectiveInput, { ...context, signal: combinedSignal }),
        new Promise<never>((_, reject) => {
          if (combinedSignal.aborted) {
            reject(new Error(combinedSignal.reason instanceof Error ? combinedSignal.reason.message : "aborted"));
            return;
          }
          combinedSignal.addEventListener("abort", () => {
            reject(new Error(combinedSignal.reason instanceof Error ? combinedSignal.reason.message : "aborted"));
          }, { once: true });
        }),
      ]);
    } catch (cause) {
      const isTimeout = combinedSignal.aborted && cause instanceof Error && cause.message.includes("Timed out");
      const causeText = isTimeout ? "Tool execution timed out" : cause instanceof Error ? cause.message : String(cause);
      output = { text: causeText, json: { timedOut: isTimeout, cancelled: !isTimeout } };
      isError = true;
    } finally {
      clearTimeout(timeoutId);
      timeoutController.abort();
    }

    for (const hook of this.hooks) {
      if (hook.afterExecute) {
        output = await hook.afterExecute(toolCall, context, output);
      }
    }

    return { output, isError };
  }
}
