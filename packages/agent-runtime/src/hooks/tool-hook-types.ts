import type {
  JsonObject,
  ToolExecutionContext,
} from "@crish/shared-types";

export type BeforeExecuteStatus = "approved" | "blocked_by_gatekeeper" | "pending_approval";

export interface BeforeExecuteResult {
  status: BeforeExecuteStatus;
  modifiedInput?: JsonObject;
  reason?: string;
}

export interface ToolResult<TOutput = unknown> {
  output: TOutput;
  isError: boolean;
  durationMs: number;
}

export interface OnErrorResult {
  action: "retry" | "skip" | "abort";
  reason?: string;
}

export interface ToolHook<TInput = unknown, TOutput = unknown> {
  beforeExecute?(input: TInput, ctx: ToolExecutionContext): BeforeExecuteResult | Promise<BeforeExecuteResult>;
  onResult?(
    result: ToolResult<TOutput>,
    ctx: ToolExecutionContext
  ): ToolResult<TOutput> | Promise<ToolResult<TOutput>>;
  onError?(error: Error, ctx: ToolExecutionContext): OnErrorResult | Promise<OnErrorResult>;
}
