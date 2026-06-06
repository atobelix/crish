import { describe, expect, it } from "vitest";
import {
  ContextCompressor,
  extractRecentTerminalCommandFacts,
  findFirstKeptMessageIndex,
  serializeMessagesForSummary
} from "./context-compression";
import { createTextMessage, nowIso } from "./session";
import type { AgentMessage, ContextSummaryRequest } from "./types";

function assistantWithToolCall(): AgentMessage {
  return {
    id: "assistant_tool",
    role: "assistant",
    createdAt: nowIso(),
    blocks: [
      { type: "thought", text: "private chain of thought" },
      { type: "text", text: "I will inspect the repo." },
      { type: "tool-call", id: "call_status", toolName: "shell_command", input: { command: "git status --short", cwd: "C:/repo" } }
    ]
  };
}

function toolResult(): AgentMessage {
  return {
    id: "tool_status",
    role: "tool",
    createdAt: nowIso(),
    blocks: [
      {
        type: "tool-result",
        toolCallId: "call_status",
        toolName: "shell_command",
        isError: false,
        output: {
          text: "Exit code: 0\nWall time: 0.1 seconds\nOutput:\n M src/runtime.ts",
          json: { exitCode: 0 }
        }
      }
    ]
  };
}

describe("context compression", () => {
  it("serializes model-visible history without thought blocks", () => {
    const serialized = serializeMessagesForSummary([assistantWithToolCall(), toolResult()]);

    expect(serialized).toContain("I will inspect the repo.");
    expect(serialized).toContain("shell_command");
    expect(serialized).toContain("Exit code: 0");
    expect(serialized).not.toContain("private chain of thought");
  });

  it("extracts recent terminal command evidence", () => {
    const facts = extractRecentTerminalCommandFacts([assistantWithToolCall(), toolResult()]);

    expect(facts.successful).toEqual([
      "$ git status --short | cwd=C:/repo | exit=0 | result=Exit code: 0"
    ]);
    expect(facts.failed).toEqual([]);
  });

  it("keeps tool call messages when their tool results are retained", () => {
    const messages = [createTextMessage("user", "old"), assistantWithToolCall(), toolResult(), createTextMessage("user", "latest")];

    expect(findFirstKeptMessageIndex(messages, 20, 1)).toBe(1);
  });

  it("always keeps the latest user message even when many assistant messages follow it", () => {
    const messages = [
      createTextMessage("user", "old"),
      createTextMessage("assistant", "old answer"),
      createTextMessage("user", "latest user request"),
      createTextMessage("assistant", "step 1 ".repeat(40)),
      createTextMessage("assistant", "step 2 ".repeat(40)),
      createTextMessage("assistant", "step 3 ".repeat(40))
    ];

    expect(findFirstKeptMessageIndex(messages, 10, 1)).toBe(2);
  });

  it("builds a summary message and passes bounded evidence to the summarizer", async () => {
    let request: ContextSummaryRequest | undefined;
    const messages = [
      createTextMessage("user", "old request"),
      assistantWithToolCall(),
      toolResult(),
      createTextMessage("assistant", "I checked the repo."),
      createTextMessage("user", "continue from here")
    ];
    const compressor = new ContextCompressor({
      contextWindowTokens: 128,
      thresholdTokens: 1,
      targetRecentTokens: 1,
      minRecentMessages: 1,
      minMessagesToCompress: 1,
      summarizer: {
        async summarize(input) {
          request = input;
          return "Repo status was checked; continue with the latest user request.";
        }
      }
    });

    const result = await compressor.maybeCompress(messages);

    expect(result).not.toBeNull();
    expect(request?.serializedConversation).not.toContain("private chain of thought");
    expect(request?.recentSuccessfulCommands[0]).toContain("git status --short");
    expect(result?.messages[0]?.blocks[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("<context_checkpoint>")
    });
    expect(result?.messages.at(-1)?.blocks[0]).toMatchObject({ type: "text", text: "continue from here" });
  });
});
