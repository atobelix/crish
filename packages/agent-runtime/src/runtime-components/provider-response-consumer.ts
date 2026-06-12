import type { AgentMessage, AgentMessageBlock, JsonObject, ToolCallBlock } from "@crish/shared-types";
import type { AgentTool, ProviderStreamEvent } from "../types";
import { createId, nowIso } from "../session";
import { repairToolInput } from "../tools";

export type AssistantResponse =
  | { type: "message"; message: AgentMessage }
  | { type: "empty-response" }
  | { type: "error"; error: string };

export class ProviderResponseConsumer {
  async consume(
    callIterator: AsyncIterable<ProviderStreamEvent>,
    tools: AgentTool[],
    signal: AbortSignal,
  ): Promise<AssistantResponse> {
    const blocks: AgentMessageBlock[] = [];
    let textBuffer = "";
    let thoughtBuffer = "";
    let error: string | undefined;
    // Track if we've received any blocks from the provider
    let hasContent = false;

    for await (const event of callIterator) {
      if (signal.aborted) return { type: "error", error: "aborted" };

      hasContent = true;

      switch (event.type) {
        case "text-delta":
          textBuffer += event.text;
          blocks.push({ type: "text", text: event.text });
          break;

        case "thought-delta":
          thoughtBuffer += event.text;
          blocks.push({
            type: "thought",
            text: event.text,
            ...(event.redacted !== undefined ? { redacted: event.redacted } : {}),
          });
          break;

        case "tool-call": {
          const tool = tools.find((c) => c.name === event.toolName);
          const input = event.input ?? {};
          const repaired = tool ? repairToolInput(tool, input) : { input, repaired: false, notes: [] };
          blocks.push({
            type: "tool-call",
            id: event.id ?? createId("call"),
            toolName: event.toolName,
            input: repaired.input,
          });
          break;
        }

        case "provider-diagnostic":
          // informational, not message content
          break;

        case "stop":
          error = event.error;
          break;
      }
    }

    if (blocks.length === 0 && !error) {
      return { type: "empty-response" };
    }

    if (error && blocks.length === 0) {
      return { type: "error", error };
    }

    const stopReason = error ? "error" : blocks.some(b => b.type === "tool-call") ? "tool-call" as const : "stop" as const;

    const message: AgentMessage = {
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

    return { type: "message", message };
  }
}
