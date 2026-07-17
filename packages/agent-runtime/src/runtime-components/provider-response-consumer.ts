import type { AgentMessage, AgentMessageBlock, ProviderDiagnostic, ToolCallBlock } from "@crish/shared-types";
import type { AgentTool } from "../types";
import type { ProviderStreamContractEvent } from "../provider-stream-contract";
import { createId, nowIso } from "../session";

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
    let sawContent = false;

    for await (const event of callIterator) {
      if (signal.aborted) return { response: { type: "error", error: "aborted" }, diagnostics };

      switch (event.type) {
        case "start":
          // 流开始，无内容
          break;

        case "delta": {
          if (event.delta.type === "text") {
            sawContent = true;
            textBuffer += event.delta.text;
            blocks.push({ type: "text", text: event.delta.text });
            try {
              onDelta?.({ kind: "text", text: event.delta.text });
            } catch {
              /* UI sink must not break stream */
            }
          } else if (event.delta.type === "thought") {
            sawContent = true;
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
            sawContent = true;
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
          break;
        }

        case "done":
          // 流结束信号，无额外内容
          break;
      }
    }

    const response: AssistantResponse =
      blocks.length === 0 && !error
        ? { type: "empty-response" }
        : error && blocks.length === 0
          ? { type: "error", error }
          : { type: "message", message: this.buildMessage(blocks, textBuffer, thoughtBuffer, error) };

    return { response, diagnostics };
  }

  private buildMessage(
    blocks: AgentMessageBlock[],
    textBuffer: string,
    thoughtBuffer: string,
    error: string | undefined,
  ): AgentMessage {
    const stopReason = error
      ? "error"
      : blocks.some((b) => b.type === "tool-call")
        ? ("tool-call" as const)
        : ("stop" as const);

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
      },
    };
  }
}
