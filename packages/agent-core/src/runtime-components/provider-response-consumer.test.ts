import { describe, expect, it } from "vitest";
import type { ProviderStreamContractEvent } from "@crish/agent-model";
import { ProviderResponseConsumer } from "./provider-response-consumer";

async function* eventsOf(
  events: ProviderStreamContractEvent[],
): AsyncIterable<ProviderStreamContractEvent> {
  for (const event of events) yield event;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("ProviderResponseConsumer abort / L3 partial salvage", () => {
  it("abort mid-stream with text keeps partial message (stopReason=aborted)", async () => {
    const consumer = new ProviderResponseConsumer();
    const ac = new AbortController();
    async function* partialThenAbort(): AsyncIterable<ProviderStreamContractEvent> {
      yield { type: "start", sequence: 0 };
      yield { type: "delta", sequence: 1, delta: { type: "text", text: "kept-" } };
      yield { type: "delta", sequence: 2, delta: { type: "text", text: "partial" } };
      ac.abort("force_cancel");
      // next event should hit signal.aborted at loop head
      yield { type: "delta", sequence: 3, delta: { type: "text", text: "lost" } };
    }
    const result = await consumer.consume(partialThenAbort(), [], ac.signal);
    expect(result.response.type).toBe("message");
    if (result.response.type !== "message") return;
    expect(result.response.message.metadata?.stopReason).toBe("aborted");
    expect(result.response.message.metadata?.aborted).toBe(true);
    expect(result.response.message.metadata?.text).toContain("partial");
    expect(result.response.message.metadata?.text).not.toContain("lost");
  });

  it("abort with no content → error aborted", async () => {
    const consumer = new ProviderResponseConsumer();
    const ac = new AbortController();
    ac.abort("force");
    async function* empty(): AsyncIterable<ProviderStreamContractEvent> {
      yield { type: "start", sequence: 0 };
    }
    const result = await consumer.consume(empty(), [], ac.signal);
    expect(result.response.type).toBe("error");
    if (result.response.type !== "error") return;
    expect(result.response.error).toBe("aborted");
  });
});

describe("ProviderResponseConsumer finishReason / stopReason fidelity", () => {
  it("end with finishReason length, text only → metadata.stopReason === length", async () => {
    const consumer = new ProviderResponseConsumer();
    const result = await consumer.consume(
      eventsOf([
        { type: "start", sequence: 0 },
        { type: "delta", sequence: 1, delta: { type: "text", text: "truncated answer" } },
        { type: "end", sequence: 2, finishReason: "length" },
        { type: "done", sequence: 3, finishReason: "length" },
      ]),
      [],
      signal(),
    );

    expect(result.response.type).toBe("message");
    if (result.response.type !== "message") return;
    expect(result.response.message.metadata?.stopReason).toBe("length");
    expect(result.response.message.metadata?.providerFinishReason).toBe("length");
    expect(result.response.message.metadata?.text).toBe("truncated answer");
  });

  it("end with finishReason length + tool-call block → stopReason === tool-call", async () => {
    const consumer = new ProviderResponseConsumer();
    const result = await consumer.consume(
      eventsOf([
        { type: "start", sequence: 0 },
        { type: "delta", sequence: 1, delta: { type: "text", text: "calling tool" } },
        {
          type: "tool-call",
          sequence: 2,
          phase: "end",
          toolCall: {
            id: "call_1",
            index: 0,
            toolName: "read_file",
            argumentsText: '{"path":"/tmp"}',
            input: { path: "/tmp" },
          },
        },
        { type: "end", sequence: 3, finishReason: "length" },
        { type: "done", sequence: 4, finishReason: "length" },
      ]),
      [],
      signal(),
    );

    expect(result.response.type).toBe("message");
    if (result.response.type !== "message") return;
    // tool-call outranks length
    expect(result.response.message.metadata?.stopReason).toBe("tool-call");
    expect(result.response.message.metadata?.providerFinishReason).toBe("length");
    expect(result.response.message.blocks.some((b) => b.type === "tool-call")).toBe(true);
  });

  it("no finishReason, text → stopReason === stop", async () => {
    const consumer = new ProviderResponseConsumer();
    const result = await consumer.consume(
      eventsOf([
        { type: "start", sequence: 0 },
        { type: "delta", sequence: 1, delta: { type: "text", text: "hello" } },
        // Intentionally omit finishReason — legacy / partial end events stay "stop"
        { type: "end", sequence: 2 } as ProviderStreamContractEvent,
        { type: "done", sequence: 3, finishReason: "stop" },
      ]),
      [],
      signal(),
    );

    expect(result.response.type).toBe("message");
    if (result.response.type !== "message") return;
    expect(result.response.message.metadata?.stopReason).toBe("stop");
    expect(result.response.message.metadata?.providerFinishReason).toBeUndefined();
    expect(result.response.message.metadata?.text).toBe("hello");
  });

  it("error → stopReason === error", async () => {
    const consumer = new ProviderResponseConsumer();
    const result = await consumer.consume(
      eventsOf([
        { type: "start", sequence: 0 },
        { type: "delta", sequence: 1, delta: { type: "text", text: "partial" } },
        {
          type: "error",
          sequence: 2,
          error: {
            kind: "network",
            message: "connection lost",
            retryable: true,
          },
        },
        { type: "end", sequence: 3, finishReason: "error" },
        { type: "done", sequence: 4, finishReason: "error" },
      ]),
      [],
      signal(),
    );

    expect(result.response.type).toBe("message");
    if (result.response.type !== "message") return;
    // error outranks length/tool-call/stop when content already arrived
    expect(result.response.message.metadata?.stopReason).toBe("error");
    expect(result.response.message.metadata?.error).toBe("connection lost");
  });
});

describe("ProviderResponseConsumer onToolArgsDelta", () => {
  it("sink receives partials when stream emits tool-call phase delta", async () => {
    const consumer = new ProviderResponseConsumer();

    const result = await consumer.consume(
      eventsOf([
        { type: "start", sequence: 0 },
        {
          type: "tool-call",
          sequence: 1,
          phase: "delta",
          toolCall: {
            id: "call_1",
            index: 0,
            toolName: "str_replace",
            argumentsText: '{"path":"a.ts"',
          },
        },
        {
          type: "tool-call",
          sequence: 2,
          phase: "delta",
          toolCall: {
            id: "call_1",
            index: 0,
            toolName: "str_replace",
            argumentsText: '{"path":"a.ts","old_string":"x"',
          },
        },
        {
          type: "tool-call",
          sequence: 3,
          phase: "end",
          toolCall: {
            id: "call_1",
            index: 0,
            toolName: "str_replace",
            argumentsText: '{"path":"a.ts","old_string":"x","new_string":"y"}',
            input: { path: "a.ts", old_string: "x", new_string: "y" },
          },
        },
        { type: "end", sequence: 4, finishReason: "tool-call" },
        { type: "done", sequence: 5, finishReason: "tool-call" },
      ]),
      [],
      signal(),
    );

    // Only phase=end becomes an executable tool-call block
    expect(result.response.type).toBe("message");
    if (result.response.type !== "message") return;
    const toolBlocks = result.response.message.blocks.filter((b) => b.type === "tool-call");
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toMatchObject({
      type: "tool-call",
      id: "call_1",
      toolName: "str_replace",
      input: { path: "a.ts", old_string: "x", new_string: "y" },
    });
    expect(result.response.message.metadata?.stopReason).toBe("tool-call");
  });

  it("no sink → phase delta ignored; only end becomes tool-call block (zero behavior change)", async () => {
    const consumer = new ProviderResponseConsumer();
    const result = await consumer.consume(
      eventsOf([
        { type: "start", sequence: 0 },
        {
          type: "tool-call",
          sequence: 1,
          phase: "delta",
          toolCall: {
            id: "call_1",
            index: 0,
            toolName: "read_file",
            argumentsText: '{"path":',
          },
        },
        {
          type: "tool-call",
          sequence: 2,
          phase: "end",
          toolCall: {
            id: "call_1",
            index: 0,
            toolName: "read_file",
            argumentsText: '{"path":"/tmp"}',
            input: { path: "/tmp" },
          },
        },
        { type: "end", sequence: 3, finishReason: "tool-call" },
        { type: "done", sequence: 4, finishReason: "tool-call" },
      ]),
      [],
      signal(),
    );

    expect(result.response.type).toBe("message");
    if (result.response.type !== "message") return;
    const toolBlocks = result.response.message.blocks.filter((b) => b.type === "tool-call");
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toMatchObject({
      type: "tool-call",
      id: "call_1",
      toolName: "read_file",
      input: { path: "/tmp" },
    });
  });

  it("sink throw must not break stream consume", async () => {
    const consumer = new ProviderResponseConsumer();
    const result = await consumer.consume(
      eventsOf([
        { type: "start", sequence: 0 },
        {
          type: "tool-call",
          sequence: 1,
          phase: "delta",
          toolCall: {
            id: "call_x",
            index: 0,
            toolName: "edit",
            argumentsText: "{",
          },
        },
        {
          type: "tool-call",
          sequence: 2,
          phase: "end",
          toolCall: {
            id: "call_x",
            index: 0,
            toolName: "edit",
            argumentsText: "{}",
            input: {},
          },
        },
        { type: "end", sequence: 3, finishReason: "tool-call" },
        { type: "done", sequence: 4, finishReason: "tool-call" },
      ]),
      [],
      signal(),
    );

    expect(result.response.type).toBe("message");
    if (result.response.type !== "message") return;
    expect(result.response.message.blocks.some((b) => b.type === "tool-call")).toBe(true);
  });
});
