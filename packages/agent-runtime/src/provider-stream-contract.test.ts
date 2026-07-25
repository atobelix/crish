import { describe, expect, it } from "vitest";
import {
  classifyProviderStreamError,
  coalesceProviderStreamContractEventStream,
  coalesceProviderStreamContractEvents,
  createProviderStreamDeltaCoalescer,
  createProviderStreamSequencer,
  createProviderToolCallEventFromAccumulator,
  normalizeAndCoalesceProviderStreamEvents,
  normalizeProviderStreamEvent,
  normalizeProviderStreamEvents,
  ProviderToolCallJsonAccumulator,
  repairToolCallJsonArguments
} from "./provider-stream-contract";
import type { ProviderStreamContractEvent, ProviderStreamDeltaEvent } from "./provider-stream-contract";
import type { ProviderStreamEvent } from "./types";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function textDelta(
  sequence: number,
  text: string,
  identity: { providerId?: string; streamId?: string } = {}
): ProviderStreamContractEvent {
  return { type: "delta", sequence, ...identity, delta: { type: "text", text } };
}

function thoughtDelta(
  sequence: number,
  text: string,
  redacted?: boolean,
  identity: { providerId?: string; streamId?: string } = {}
): ProviderStreamContractEvent {
  return {
    type: "delta",
    sequence,
    ...identity,
    delta: {
      type: "thought",
      text,
      ...(redacted !== undefined ? { redacted } : {})
    }
  };
}

function textFor(events: ProviderStreamContractEvent[], providerId: string, streamId: string): string | undefined {
  const event = events.find(
    (candidate): candidate is ProviderStreamDeltaEvent =>
      candidate.type === "delta" &&
      candidate.delta.type === "text" &&
      candidate.providerId === providerId &&
      candidate.streamId === streamId
  );
  return event?.delta.type === "text" ? event.delta.text : undefined;
}

describe("provider stream contract", () => {
  it("normalizes legacy provider events into sequenced contract envelopes", async () => {
    const legacyEvents: ProviderStreamEvent[] = [
      { type: "text-delta", text: "Run " },
      { type: "thought-delta", text: "checking", redacted: true },
      { type: "tool-call", id: "call_1", toolName: "shell_command", input: { command: "pwd" } },
      {
        type: "provider-diagnostic",
        diagnostic: {
          phase: "stream-end",
          providerId: "flowbit",
          chunks: 3
        }
      },
      {
        type: "stop",
        reason: "tool-call",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
      }
    ];

    const events = await collect(
      normalizeProviderStreamEvents(legacyEvents, {
        streamId: "stream_1",
        providerId: "flowbit",
        model: "mimo-test"
      })
    );

    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "tool-call", "delta", "end", "done"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.every((event) => event.streamId === "stream_1" && event.providerId === "flowbit")).toBe(true);
    expect(events[0]).toMatchObject({ type: "start", model: "mimo-test" });
    expect(events[1]).toMatchObject({ type: "delta", delta: { type: "text", text: "Run " } });
    expect(events[2]).toMatchObject({ type: "delta", delta: { type: "thought", text: "checking", redacted: true } });
    expect(events[3]).toMatchObject({
      type: "tool-call",
      phase: "end",
      toolCall: {
        id: "call_1",
        toolName: "shell_command",
        argumentsText: "{\"command\":\"pwd\"}",
        input: { command: "pwd" }
      }
    });
    expect(events[4]).toMatchObject({ type: "delta", delta: { type: "diagnostic", diagnostic: { phase: "stream-end", chunks: 3 } } });
    expect(events[5]).toMatchObject({
      type: "end",
      finishReason: "tool-call",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    });
    expect(events[6]).toMatchObject({
      type: "done",
      finishReason: "tool-call",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    });
  });

  it("accumulates fragmented tool-call JSON and emits repair metadata", () => {
    const accumulator = new ProviderToolCallJsonAccumulator({ index: 0 });
    expect(accumulator.append({ id: "call_1", toolName: "shell_command", argumentsDelta: "{\"command\":" })).toMatchObject({
      id: "call_1",
      index: 0,
      toolName: "shell_command",
      argumentsText: "{\"command\":",
      done: false
    });
    accumulator.append({ argumentsDelta: "\"pwd\"", done: true });

    const eventInput = createProviderToolCallEventFromAccumulator(accumulator);

    expect(eventInput).toMatchObject({
      type: "tool-call",
      phase: "end",
      toolCall: {
        id: "call_1",
        index: 0,
        toolName: "shell_command",
        argumentsText: "{\"command\":\"pwd\"",
        input: { command: "pwd" }
      },
      repair: {
        status: "repaired",
        raw: "{\"command\":\"pwd\"",
        repairedText: "{\"command\":\"pwd\"}",
        input: { command: "pwd" }
      }
    });

    const sequenced = createProviderStreamSequencer({ initialSequence: 10 }).next(eventInput);
    expect(sequenced).toMatchObject({ type: "tool-call", sequence: 11 });
  });

  it("preserves invalid tool-call JSON as a structured fallback", () => {
    const repair = repairToolCallJsonArguments("{\"command\": ");

    expect(repair).toMatchObject({
      status: "invalid",
      raw: "{\"command\": ",
      input: {
        __rawArguments: "{\"command\": "
      }
    });
    expect(repair.error).toBeTypeOf("string");
    expect(repair.notes.join(" ")).toContain("fallback");
  });

  it("classifies provider stream errors with stable typed kinds", () => {
    expect(classifyProviderStreamError({ status: 429, message: "Too many requests" })).toMatchObject({
      kind: "rate-limit",
      retryable: true,
      status: 429
    });
    expect(
      classifyProviderStreamError({
        status: 403,
        message: "Just a moment, enable JavaScript and cookies",
        headers: { server: "cloudflare", "cf-mitigated": "challenge" }
      })
    ).toMatchObject({
      kind: "gateway-challenge",
      retryable: false,
      status: 403
    });
    expect(classifyProviderStreamError(new Error("stream idle timed out after 5ms"))).toMatchObject({
      kind: "timeout",
      retryable: true
    });
    expect(classifyProviderStreamError(new DOMException("The operation was aborted", "AbortError"))).toMatchObject({
      kind: "cancelled",
      retryable: false,
      code: "AbortError"
    });
  });

  it("maps legacy terminal provider errors to end and done envelopes", () => {
    const events = normalizeProviderStreamEvent(
      { type: "stop", reason: "error", error: "Too many requests" },
      { initialSequence: 4, includeDone: true }
    );

    expect(events.map((event) => event.type)).toEqual(["end", "done"]);
    expect(events.map((event) => event.sequence)).toEqual([5, 6]);
    expect(events[0]).toMatchObject({ type: "end", finishReason: "error", error: { kind: "rate-limit", message: "Too many requests" } });
    expect(events[1]).toMatchObject({ type: "done", finishReason: "error" });
  });

  it("emits an end and done envelope when a legacy stream closes without stop", async () => {
    async function* source(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: "text-delta", text: "partial" };
    }

    const events: ProviderStreamContractEvent[] = await collect(normalizeProviderStreamEvents(source()));

    expect(events.map((event) => event.type)).toEqual(["start", "delta"]);
  });

  it("propagates late provider cleanup failure", async () => {
    async function* source(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: "stop", reason: "stop" };
      throw new Error("late provider cleanup failed");
    }

    await expect(() => collect(normalizeProviderStreamEvents(source()))).rejects.toThrow("late provider cleanup failed");
  });

  it("coalesces text deltas and flushes at character limits", () => {
    const identity = { providerId: "flowbit", streamId: "stream_text" };
    const events = coalesceProviderStreamContractEvents(
      [
        { type: "start", sequence: 1, ...identity },
        textDelta(2, "ab", identity),
        textDelta(3, "cd", identity),
        textDelta(4, "ef", identity)
      ],
      { maxDelayMs: 1000, maxChars: 4 }
    );

    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 3, 4]);
    expect(events[1]).toMatchObject({ type: "delta", delta: { type: "text", text: "abcd" } });
    expect(events[2]).toMatchObject({ type: "delta", delta: { type: "text", text: "ef" } });
  });

  it("coalesces thought deltas without losing redaction state", () => {
    const identity = { providerId: "flowbit", streamId: "stream_thought" };
    const events = coalesceProviderStreamContractEvents(
      [thoughtDelta(1, "check", true, identity), thoughtDelta(2, "ing", true, identity)],
      { maxDelayMs: 1000 }
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "delta",
      sequence: 2,
      providerId: "flowbit",
      streamId: "stream_thought",
      delta: { type: "thought", text: "checking", redacted: true }
    });
  });

  it("flushes pending deltas before tool-call, provider diagnostic, end, and error events", () => {
    const identity = { providerId: "flowbit", streamId: "stream_boundary" };
    const boundaries: ProviderStreamContractEvent[] = [
      {
        type: "tool-call",
        sequence: 3,
        ...identity,
        phase: "start",
        toolCall: { id: "call-1", index: 0, toolName: "shell_command", argumentsText: "" }
      },
      {
        type: "delta",
        sequence: 3,
        ...identity,
        delta: {
          type: "diagnostic",
          diagnostic: { phase: "sse-first-byte", providerId: "flowbit", elapsedMs: 12 }
        }
      },
      { type: "end", sequence: 3, ...identity, finishReason: "stop" },
      {
        type: "error",
        sequence: 3,
        ...identity,
        error: { kind: "unknown", message: "failed", retryable: false }
      }
    ];

    for (const boundary of boundaries) {
      const events = coalesceProviderStreamContractEvents(
        [textDelta(1, "to", identity), textDelta(2, "ken", identity), boundary],
        { maxDelayMs: 1000 }
      );

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "delta", sequence: 2, delta: { type: "text", text: "token" } });
      expect(events[1]).toEqual(boundary);
    }
  });

  it("keeps sequences monotonic after maxEvents flushes", () => {
    const identity = { providerId: "flowbit", streamId: "stream_sequence" };
    const events = coalesceProviderStreamContractEvents(
      [
        { type: "start", sequence: 1, ...identity },
        textDelta(2, "a", identity),
        textDelta(3, "b", identity),
        textDelta(4, "c", identity),
        textDelta(5, "d", identity),
        { type: "done", sequence: 6, ...identity, finishReason: "stop" }
      ],
      { maxDelayMs: 1000, maxEvents: 2 }
    );

    expect(events.map((event) => event.sequence)).toEqual([1, 3, 5, 6]);
    expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true);
    expect(events[1]).toMatchObject({ type: "delta", delta: { type: "text", text: "ab" } });
    expect(events[2]).toMatchObject({ type: "delta", delta: { type: "text", text: "cd" } });
  });

  it("does not coalesce deltas across provider or stream identities", () => {
    const events = coalesceProviderStreamContractEvents(
      [
        textDelta(1, "p1-", { providerId: "p1", streamId: "same" }),
        textDelta(2, "p2-", { providerId: "p2", streamId: "same" }),
        textDelta(3, "s2-", { providerId: "p1", streamId: "other" }),
        textDelta(4, "done", { providerId: "p1", streamId: "same" }),
        textDelta(5, "done", { providerId: "p2", streamId: "same" }),
        textDelta(6, "done", { providerId: "p1", streamId: "other" })
      ],
      { maxDelayMs: 1000 }
    );

    expect(events).toHaveLength(3);
    expect(textFor(events, "p1", "same")).toBe("p1-done");
    expect(textFor(events, "p2", "same")).toBe("p2-done");
    expect(textFor(events, "p1", "other")).toBe("s2-done");
  });

  it("flushes expired coalesced deltas using maxDelayMs", () => {
    let now = 0;
    const coalescer = createProviderStreamDeltaCoalescer({
      maxDelayMs: 5,
      now: () => now
    });

    expect(coalescer.push(textDelta(1, "a"))).toEqual([]);
    now = 6;

    const delayed = coalescer.push(textDelta(2, "b"));
    expect(delayed).toHaveLength(1);
    expect(delayed[0]).toMatchObject({ type: "delta", sequence: 1, delta: { type: "text", text: "a" } });
    expect(coalescer.flush()).toMatchObject([{ type: "delta", sequence: 2, delta: { type: "text", text: "b" } }]);
  });

  it("normalizes and coalesces legacy provider streams as a single reusable adapter", async () => {
    const diagnostic = {
      phase: "sse-first-byte" as const,
      providerId: "flowbit",
      elapsedMs: 8,
      chunks: 2
    };
    const events = await collect(
      normalizeAndCoalesceProviderStreamEvents(
        [
          { type: "text-delta", text: "hel" },
          { type: "text-delta", text: "lo" },
          { type: "provider-diagnostic", diagnostic },
          { type: "text-delta", text: "!" },
          { type: "stop", reason: "stop" }
        ],
        {
          streamId: "stream_adapter",
          providerId: "flowbit",
          model: "mimo-test",
          coalescing: { maxDelayMs: 1000 }
        }
      )
    );

    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "delta", "end", "done"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 3, 4, 5, 6, 7]);
    expect(events[1]).toMatchObject({ type: "delta", delta: { type: "text", text: "hello" } });
    expect(events[2]).toMatchObject({ type: "delta", delta: { type: "diagnostic", diagnostic } });
    expect(events[3]).toMatchObject({ type: "delta", delta: { type: "text", text: "!" } });
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
  });

  it("flushes pending text before normalized provider errors and re-throws", async () => {
    async function* source(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: "text-delta", text: "part" };
      yield { type: "text-delta", text: "ial" };
      throw new Error("provider socket closed");
    }

    await expect(
      collect(normalizeAndCoalesceProviderStreamEvents(source(), {
        streamId: "stream_error_flush",
        providerId: "flowbit",
        coalescing: { maxDelayMs: 1000 }
      }))
    ).rejects.toThrow("provider socket closed");
  });

  it("flushes pending text before a normalized close without an explicit stop", async () => {
    async function* source(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: "text-delta", text: "clos" };
      yield { type: "text-delta", text: "ed" };
    }

    const events = await collect(
      normalizeAndCoalesceProviderStreamEvents(source(), {
        streamId: "stream_close_flush",
        providerId: "flowbit",
        coalescing: { maxDelayMs: 1000 }
      })
    );

    expect(events.map((event) => event.type)).toEqual(["start", "delta"]);
  });

  it("flushes pending coalesced deltas before propagating an aborted or closed source", async () => {
    async function* source(): AsyncGenerator<ProviderStreamContractEvent> {
      yield textDelta(1, "pend");
      yield textDelta(2, "ing");
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const iterator = coalesceProviderStreamContractEventStream(source(), { maxDelayMs: 1000 })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "delta", sequence: 2, delta: { type: "text", text: "pending" } }
    });
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});
