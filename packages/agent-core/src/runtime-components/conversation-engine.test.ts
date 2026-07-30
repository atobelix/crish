import { describe, expect, it } from "vitest";
import { ConversationEngine } from "./conversation-engine";
import type { ToolResultBlock, AgentMessage } from "@crish/shared-types";

function createEngine(overrides: Partial<{ maxTurns: number; systemPrompt: string; cwd: string }> = {}): ConversationEngine {
  return new ConversationEngine({
    sessionId: "s_test",
    maxTurns: overrides.maxTurns ?? 10,
    modelId: "test-model",
    systemPrompt: overrides.systemPrompt ?? "You are a test assistant.",
    cwd: overrides.cwd ?? "C:/workspace",
  });
}

describe("ConversationEngine", () => {
  it("initializes with a system message", () => {
    const engine = createEngine({ systemPrompt: "Be concise." });
    engine.initialize();
    const messages = engine.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.blocks[0]).toMatchObject({ type: "text", text: "Be concise." });
  });

  it("does not re-initialize when messages already exist", () => {
    const engine = createEngine();
    engine.initialize();
    engine.initialize();
    expect(engine.getMessages()).toHaveLength(1);
  });

  it("appends user messages with correct role and text", () => {
    const engine = createEngine();
    engine.initialize();
    const msg = engine.appendUserMessage("hello world");

    expect(msg.role).toBe("user");
    expect(msg.blocks).toHaveLength(1);
    expect(msg.blocks[0]).toMatchObject({ type: "text", text: "hello world" });
    expect(engine.getMessages()).toHaveLength(2);
  });

  it("appends assistant messages with given blocks", () => {
    const engine = createEngine();
    const msg = engine.appendAssistantMessage([
      { type: "text", text: "Hello!" },
      { type: "tool-call", id: "call_1", toolName: "read", input: { path: "/tmp" } },
    ]);

    expect(msg.role).toBe("assistant");
    expect(msg.blocks).toHaveLength(2);
    expect(engine.getMessages()).toHaveLength(1);
  });

  it("appends tool results as a single batched message", () => {
    const engine = createEngine();
    const results: ToolResultBlock[] = [
      { type: "tool-result", toolCallId: "call_1", toolName: "read", output: { text: "content" }, isError: false },
    ];
    const messages = engine.appendToolResults(results);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("tool");
    expect(messages[0]!.blocks).toHaveLength(1);
    expect(engine.getMessages()).toHaveLength(1);
  });

  it("returns empty array when appending zero tool results", () => {
    const engine = createEngine();
    expect(engine.appendToolResults([])).toEqual([]);
  });

  it("builds provider request with messages and tools", () => {
    const engine = createEngine();
    engine.initialize();
    engine.appendUserMessage("hello");
    const signal = new AbortController().signal;
    const request = engine.buildProviderRequest([], signal);

    expect(request.messages).toHaveLength(2);
    expect(request.signal).toBe(signal);
  });

  it("processes a text-only provider response into a turn result", () => {
    const engine = createEngine();
    const result = engine.processProviderResponse({
      finishReason: "stop",
      text: "Sure, here's the answer.",
      toolCalls: [],
      diagnostics: [],
    });

    expect(result.toolCalls).toHaveLength(0);
    expect(result.shouldContinue).toBe(false);
    expect(result.endReason).toBe("stop");
    expect(result.assistantMessage.blocks[0]).toMatchObject({ type: "text", text: "Sure, here's the answer." });
  });

  it("processes a tool-call provider response with tool_calls", () => {
    const engine = createEngine();
    const result = engine.processProviderResponse({
      finishReason: "tool-call",
      text: "Let me check that.",
      toolCalls: [{ id: "call_fs", toolName: "read_file", input: { path: "/tmp/x" } }],
      diagnostics: [],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.toolName).toBe("read_file");
    expect(result.shouldContinue).toBe(true);
    expect(result.endReason).toBeUndefined();
  });

  it("stops when max turns is reached with tool calls remaining", () => {
    const engine = createEngine({ maxTurns: 1 });
    engine.processProviderResponse({
      finishReason: "tool-call",
      text: "",
      toolCalls: [{ id: "call_1", toolName: "test", input: {} }],
      diagnostics: [],
    });
    const result = engine.processProviderResponse({
      finishReason: "tool-call",
      text: "",
      toolCalls: [{ id: "call_2", toolName: "test", input: {} }],
      diagnostics: [],
    });

    expect(result.shouldContinue).toBe(false);
    expect(result.endReason).toBe("max-turns");
  });

  it("tracks turn count", () => {
    const engine = createEngine();
    expect(engine.getTurnCount()).toBe(0);
    engine.processProviderResponse({ finishReason: "stop", text: "first", toolCalls: [], diagnostics: [] });
    expect(engine.getTurnCount()).toBe(1);
    engine.processProviderResponse({ finishReason: "stop", text: "second", toolCalls: [], diagnostics: [] });
    expect(engine.getTurnCount()).toBe(2);
  });

  it("detects max turns reached", () => {
    const engine = createEngine({ maxTurns: 2 });
    expect(engine.isMaxTurnsReached()).toBe(false);
    engine.processProviderResponse({ finishReason: "stop", text: "a", toolCalls: [], diagnostics: [] });
    expect(engine.isMaxTurnsReached()).toBe(false);
    engine.processProviderResponse({ finishReason: "stop", text: "b", toolCalls: [], diagnostics: [] });
    expect(engine.isMaxTurnsReached()).toBe(true);
  });

  it("creates a snapshot and restores from it", () => {
    const engine = createEngine();
    engine.initialize();
    engine.appendUserMessage("hello");
    const snapshot = engine.getSnapshot();
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.turnCount).toBe(0);

    const engine2 = createEngine();
    engine2.restoreFromSnapshot(snapshot);
    expect(engine2.getMessages()).toHaveLength(2);
    expect(engine2.getTurnCount()).toBe(0);
  });

  it("appends arbitrary messages via appendMessage", () => {
    const engine = createEngine();
    const msg: AgentMessage = {
      id: "custom_1",
      role: "system",
      createdAt: new Date().toISOString(),
      blocks: [{ type: "text", text: "steer" }],
    };
    engine.appendMessage(msg);
    expect(engine.getMessages()).toHaveLength(1);
    expect(engine.getMessages()[0]!.id).toBe("custom_1");
  });

  it("replaces messages via replaceMessages", () => {
    const engine = createEngine();
    engine.initialize();
    engine.replaceMessages([{ id: "new", role: "user", createdAt: "", blocks: [{ type: "text", text: "replaced" }] }]);
    expect(engine.getMessages()).toHaveLength(1);
    expect(engine.getMessages()[0]!.blocks[0]).toMatchObject({ text: "replaced" });
  });

  it("returns a mutable reference from getMessagesMutable", () => {
    const engine = createEngine();
    engine.initialize();
    const mutable = engine.getMessagesMutable();
    mutable.push({ id: "extra", role: "user", createdAt: "", blocks: [] });
    expect(engine.getMessages()).toHaveLength(2);
  });

  it("preserves frozen view aliasing after replacement", () => {
    const engine = createEngine();
    engine.initialize();
    const beforeReplace = engine.getMessages();
    engine.replaceMessages([{ id: "new", role: "user", createdAt: "", blocks: [] }]);
    expect(beforeReplace).not.toBe(engine.getMessages());
  });

  it("does not detect recovery need on normal messages", () => {
    const engine = createEngine();
    engine.appendAssistantMessage([{ type: "text", text: "all good" }]);
    expect(engine.detectRecoveryNeed()).toBeNull();
  });

  it("returns steering message when steering count is under budget", () => {
    const engine = createEngine();
    const result = engine.applySteering("tool-errors", 0, 3);
    expect(result.shouldIntervene).toBe(false);
    expect(result.newCount).toBe(1);
    expect(result.message.blocks[0]).toMatchObject({ type: "text" });
  });

  it("intervenes when steering count exceeds budget", () => {
    const engine = createEngine();
    const result = engine.applySteering("tool-errors", 3, 3);
    expect(result.shouldIntervene).toBe(true);
    expect(result.newCount).toBe(3);
  });
});
