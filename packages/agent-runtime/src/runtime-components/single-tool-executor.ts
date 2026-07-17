import type { ToolCallBlock, ToolExecutionContext, ToolOutput, JsonObject } from "@crish/shared-types";
import { combineAbortSignals } from "@crish/shared-utils";

export interface ToolMiddlewareHook {
  beforeExecute?(toolCall: ToolCallBlock, ctx: ToolExecutionContext): Promise<{ proceed: boolean; reason?: string; modifiedInput?: JsonObject }>;
  afterExecute?(toolCall: ToolCallBlock, ctx: ToolExecutionContext, output: ToolOutput): Promise<ToolOutput>;
}

/** Structured result of a single tool invocation (timeout / cancel / error metadata in output.json). */
export interface SingleToolExecutionResult {
  output: ToolOutput;
  isError: boolean;
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
  ): Promise<SingleToolExecutionResult> {
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
      const causeMessage = cause instanceof Error ? cause.message : String(cause);
      const timedOutByMessage = /timed out/i.test(causeMessage);
      const timedOutByController = timeoutController.signal.aborted && timedOutByMessage;
      const isTimeout = timedOutByController || (combinedSignal.aborted && timedOutByMessage);
      // Parent/batch abort (cancel-siblings) without timeout wording → cancelled
      const isCancelled = !isTimeout && (signal.aborted || combinedSignal.aborted || /abort|cancel/i.test(causeMessage));
      const causeText = isTimeout
        ? "Tool execution timed out"
        : isCancelled
          ? "Tool execution cancelled"
          : causeMessage;
      output = {
        text: causeText,
        json: {
          timedOut: isTimeout,
          cancelled: isCancelled && !isTimeout,
          runtimeToolExecution: isTimeout
            ? { status: "timeout", timedOut: true, timeoutMs: this.timeoutMs }
            : isCancelled
              ? { status: "cancelled", cancelled: true }
              : { status: "error" },
        },
      };
      isError = true;
    } finally {
      // Clear timer only — do NOT abort timeoutController after success.
      // Aborting combinedSignal post-success falsely fires tool abort listeners.
      clearTimeout(timeoutId);
    }

    for (const hook of this.hooks) {
      if (hook.afterExecute) {
        output = await hook.afterExecute(toolCall, context, output);
      }
    }

    return { output, isError };
  }
}
