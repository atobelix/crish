import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, ToolCallBlock } from "@crish/shared-types";
import { ContextManager } from "./context-manager";

function msg(text: string, role: "user" | "assistant" = "user"): AgentMessage {
  return {
    id: `${role}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    role,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "text", text }],
  };
}

describe("ContextManager", () => {
  it("passes through provider projection without secret redactor", () => {
    const cm = new ContextManager({ secretRedactor: false });
    const messages = [msg("hello")];
    const projected = cm.projectForProvider(messages);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.blocks[0]).toMatchObject({ text: "hello" });
  });

  it("returns false for shouldCompress when no compressor is configured", () => {
    const cm = new ContextManager({ secretRedactor: false });
    expect(cm.shouldCompress([])).toBe(false);
  });

  it("returns null for compress when no compressor is configured", async () => {
    const cm = new ContextManager({ secretRedactor: false });
    await expect(cm.compress([])).resolves.toBeNull();
  });

  it("projects system prompt without redaction when disabled", () => {
    const cm = new ContextManager({ secretRedactor: false });
    expect(cm.projectSystemPrompt("hello")).toBe("hello");
    expect(cm.projectSystemPrompt(undefined)).toBeUndefined();
  });

  it("projects prompt context without redaction when disabled", () => {
    const cm = new ContextManager({ secretRedactor: false });
    const result = cm.projectPromptContext({
      stableContext: [{ id: "s1", kind: "custom-stable", label: "stable", content: { key: "value" } }],
      volatileContext: [{ id: "v1", kind: "custom-volatile", content: { key: "value" } }],
    });
    expect(result.stableContext).toHaveLength(1);
    expect(result.volatileContext).toHaveLength(1);
  });

  it("returns empty for projectPromptContext when input is undefined", () => {
    const cm = new ContextManager({ secretRedactor: false });
    expect(cm.projectPromptContext(undefined)).toEqual({});
  });

  it("restores provider tool input passthrough without redactor", () => {
    const cm = new ContextManager({ secretRedactor: false });
    const input = { value: "test" };
    expect(cm.restoreProviderToolInput(input)).toBe(input);
  });

  it("returns compressor when compression is configured", () => {
    const cm = new ContextManager({
      secretRedactor: false,
      compression: {
        contextWindowTokens: 4096,
        thresholdTokens: 1,
        targetRecentTokens: 1,
        minRecentMessages: 1,
        minMessagesToCompress: 1,
        summarizer: { async summarize() { return "summary"; } },
      },
    });
    expect(cm.getCompressor()).toBeDefined();
  });

  it("returns undefined compressor when compression is disabled", () => {
    const cm = new ContextManager({ secretRedactor: false, compression: { enabled: false } as any });
    expect(cm.getCompressor()).toBeUndefined();
  });

  it("maybeCompress does nothing when compressor is absent", async () => {
    const cm = new ContextManager({ secretRedactor: false });
    const onEvent = vi.fn();
    await cm.maybeCompress([], () => {}, onEvent);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("materializeOutput passes through small output unchanged", async () => {
    const cm = new ContextManager({ secretRedactor: false, cwd: "C:/workspace", sessionId: "s_test" });
    const call: ToolCallBlock = { type: "tool-call", id: "c1", toolName: "test", input: {} };
    const output = { text: "small" };
    const result = await cm.materializeOutput(call, output);
    expect(result).toBe(output);
  });

  it("does not materialize non-text output", async () => {
    const cm = new ContextManager({ secretRedactor: false });
    const call: ToolCallBlock = { type: "tool-call", id: "c1", toolName: "test", input: {} };
    const output = { json: { key: "value" } };
    const result = await cm.materializeOutput(call, output as any);
    expect(result).toBe(output);
  });

  it("creates projection cache for repeated messages", () => {
    const cm = new ContextManager({ secretRedactor: false });
    const m = msg("hello");
    const p1 = cm.projectForProvider([m]);
    const p2 = cm.projectForProvider([m]);
    // Same reference returned from cache
    expect(p1[0]).toBe(p2[0]);
  });

  it("redacts secrets in system prompt when redactor is enabled", () => {
    const cm = new ContextManager({ secretRedactor: false });
    const prompt = "API key: sk-test-123";
    const result = cm.projectSystemPrompt(prompt);
    expect(result).toBe(prompt);
  });
});
