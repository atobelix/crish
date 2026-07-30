import type {
  AgentMessage,
  AgentMessageBlock,
  ProviderDiagnostic,
  AgentTool,
  ProviderUsage,
} from '@crish/shared-types';
import type { ProviderStreamContractEvent } from "@crish/agent-model";
import { createId, nowIso } from '@crish/agent-context';

export type AssistantResponse =
  | { type: "message"; message: AgentMessage }
  | { type: "empty-response" }
  | { type: "error"; error: string };

export interface ConsumeResult {
  response: AssistantResponse;
  /** 在流期间收集的 provider-diagnostic 事件，供调用方 emit */
  diagnostics: ProviderDiagnostic[];
}

export type ProviderDeltaSink = (delta: {
  kind: "text" | "thought";
  text: string;
  redacted?: boolean;
}) => void;

export class ProviderResponseConsumer {
  async consume(
    callIterator: AsyncIterable<ProviderStreamContractEvent>,
    tools: AgentTool[],
    signal: AbortSignal,
    onDelta?: ProviderDeltaSink,
  ): Promise<ConsumeResult> {
    const blocks: AgentMessageBlock[] = [];
    const diagnostics: ProviderDiagnostic[] = [];
    let textBuffer = "";
    let thoughtBuffer = "";
    let error: string | undefined;
    let usage: ProviderUsage | undefined;
    let finishReasonFromStream: string | undefined;

    for await (const event of callIterator) {
      // L3 / AbortSignal: keep partial tokens so continue-after-abort can resume context
      // (pi-align: transcript retains what was already streamed).
      if (signal.aborted) {
        return this.finishAfterAbort(blocks, textBuffer, thoughtBuffer, usage, finishReasonFromStream, diagnostics);
      }

      switch (event.type) {
        case "start":
          // 流开始，无内容
          break;

        case "delta": {
          if (event.delta.type === "text") {
            textBuffer += event.delta.text;
            blocks.push({ type: "text", text: event.delta.text });
            try {
              onDelta?.({ kind: "text", text: event.delta.text });
            } catch {
              /* UI sink must not break stream */
            }
          } else if (event.delta.type === "thought") {
            thoughtBuffer += event.delta.text;
            blocks.push({
              type: "thought",
              text: event.delta.text,
              ...(event.delta.redacted !== undefined ? { redacted: event.delta.redacted } : {}),
            });
            try {
              onDelta?.({
                kind: "thought",
                text: event.delta.text,
                ...(event.delta.redacted !== undefined ? { redacted: event.delta.redacted } : {}),
              });
            } catch {
              /* ignore */
            }
          } else if (event.delta.type === "diagnostic") {
            diagnostics.push(event.delta.diagnostic);
          }
          break;
        }

        case "tool-call": {
          // 只在 phase=end 时收集完整的工具调用。
          // 输入 alias 修复留给 AgentSessionLoop（统一发 tool-input-repaired）。
          if (event.phase === "end") {
            const toolCall = event.toolCall;
            const input = toolCall.input ?? {};
            blocks.push({
              type: "tool-call",
              id: toolCall.id ?? createId("call"),
              toolName: toolCall.toolName,
              input,
            });
          }
          break;
        }

        case "error":
          error = event.error.message;
          break;

        case "end": {
          if (event.error) {
            error = event.error.message;
          }
          if (event.usage) {
            usage = event.usage;
          }
          if (event.finishReason) {
            finishReasonFromStream = event.finishReason;
          }
          break;
        }

        case "done":
          // 流结束信号，无额外内容
          break;
      }
    }

    // Stream ended while already aborted — salvage partial content if any
    if (signal.aborted) {
      return this.finishAfterAbort(blocks, textBuffer, thoughtBuffer, usage, finishReasonFromStream, diagnostics, error);
    }

    const response: AssistantResponse =
      blocks.length === 0 && !error
        ? { type: "empty-response" }
        : error && blocks.length === 0
          ? { type: "error", error }
          : { type: "message", message: this.buildMessage(blocks, textBuffer, thoughtBuffer, error, usage, finishReasonFromStream) };

    return { response, diagnostics };
  }

  /**
   * After AbortSignal / L3 force_cancel: prefer a partial assistant message over a bare error
   * so session transcript + UI keep streamed text for continue-after-abort.
   */
  private finishAfterAbort(
    blocks: AgentMessageBlock[],
    textBuffer: string,
    thoughtBuffer: string,
    usage: ProviderUsage | undefined,
    finishReasonFromStream: string | undefined,
    diagnostics: ProviderDiagnostic[],
    error?: string,
  ): ConsumeResult {
    if (blocks.length === 0) {
      return {
        response: { type: "error", error: error === "aborted" || !error ? "aborted" : error },
        diagnostics,
      };
    }
    const message = this.buildMessage(
      blocks,
      textBuffer,
      thoughtBuffer,
      undefined,
      usage,
      finishReasonFromStream ?? "aborted",
    );
    message.metadata = {
      ...(message.metadata ?? {}),
      stopReason: "aborted",
      aborted: true,
      ...(error && error !== "aborted" ? { error } : {}),
    };
    return { response: { type: "message", message }, diagnostics };
  }

  private buildMessage(
    blocks: AgentMessageBlock[],
    textBuffer: string,
    thoughtBuffer: string,
    error: string | undefined,
    usage: ProviderUsage | undefined,
    finishReason?: string,
  ): AgentMessage {
    const stopReason = error
      ? "error"
      : blocks.some((b) => b.type === "tool-call")
        ? ("tool-call" as const)
        : (finishReason ?? ("stop" as const));

    return {
      id: createId("assistant"),
      role: "assistant",
      createdAt: nowIso(),
      blocks,
      metadata: {
        stopReason,
        ...(error ? { error } : {}),
        text: textBuffer,
        ...(thoughtBuffer ? { thought: thoughtBuffer } : {}),
        ...(usage ? { usage: usage as unknown as import("@crish/shared-types").JsonObject } : {}),
        ...(finishReason ? { providerFinishReason: finishReason } : {}),
      },
    };
  }
}
