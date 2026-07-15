import { describe, expect, it } from "vitest";
import { projectMessagesForProvider } from "./context-projection";
import type { AgentMessage } from "@crish/shared-types";

describe("context projection", () => {
  it("budgets long tool output for provider context without mutating raw transcript messages", () => {
    const longOutput = `${"a".repeat(40)}${"b".repeat(40)}${"c".repeat(40)}`;
    const raw: AgentMessage[] = [
      {
        id: "tool_1",
        role: "tool",
        createdAt: "2026-01-01T00:00:00.000Z",
        blocks: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "shell",
            isError: false,
            output: { text: longOutput, json: { exitCode: 0 } }
          }
        ]
      }
    ];

    const projected = projectMessagesForProvider(raw, {
      toolOutputBudget: { inlineChars: 32, headRatio: 0.5 }
    });

    const rawBlock = raw[0]!.blocks[0]!;
    const projectedBlock = projected[0]!.blocks[0]!;
    expect(rawBlock).toMatchObject({
      type: "tool-result",
      output: { text: longOutput, json: { exitCode: 0 } }
    });
    expect(projectedBlock).toMatchObject({
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "shell",
      isError: false
    });
    expect(projectedBlock.type === "tool-result" ? projectedBlock.output.text : "").toContain("characters omitted");
    expect(projectedBlock.type === "tool-result" ? projectedBlock.output.text : "").not.toBe(longOutput);
    expect(projectedBlock.type === "tool-result" ? projectedBlock.output.json : undefined).toMatchObject({
      contextBudget: {
        toolName: "shell",
        truncated: true,
        originalChars: longOutput.length
      }
    });
  });
});
