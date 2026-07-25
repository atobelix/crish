/**
 * @deprecated ToolHook 已精简为 3 方法（beforeExecute / onResult / onError），
 * 请直接在 tool-execution.ts 中直接调用 ToolHook[] 数组，不再使用 MiddlewarePipeline 包装。
 * @removeWhen v2.0
 */

import type { JsonObject, ToolOutput } from "@crish/shared-types";
import type {
  ToolHook,
  ToolResult,
} from "./tool-hook-types";

/**
 * @deprecated 使用直接 ToolHook[] 调用替代
 */
export class MiddlewarePipeline {
  constructor(private readonly hooks: ToolHook<JsonObject, ToolOutput>[]) {}

  async beforeExecute(
    input: JsonObject,
    ctx: any
  ): Promise<any> {
    for (const hook of this.hooks) {
      if (hook.beforeExecute) {
        const result = await hook.beforeExecute(input, ctx);
        if (result && typeof result === "object" && "status" in result) {
          if (result.status === "blocked_by_gatekeeper") return result;
          if (result.modifiedInput) input = result.modifiedInput;
        }
      }
    }
    return { status: "approved", modifiedInput: input };
  }

  async onResult(
    result: ToolResult<ToolOutput>,
    ctx: any
  ): Promise<ToolResult<ToolOutput>> {
    let current = result;
    for (const hook of this.hooks) {
      if (hook.onResult) {
        current = await hook.onResult(current, ctx);
      }
    }
    return current;
  }

  async onError(
    error: Error,
    ctx: any
  ): Promise<any> {
    let result: any = { action: "abort" };
    for (const hook of this.hooks) {
      if (hook.onError) {
        result = await hook.onError(error, ctx);
      }
    }
    return result;
  }
}
