import { describe, expect, it } from "vitest";
import {
  createSseAbortError,
  findSseSeparator,
  MalformedSseFrameError,
  normalizeStreamTimeoutMs,
  parseSseFrame,
  readSseJson,
  sseSeparatorLength,
  type SseDiagnosticsOptions,
} from "./openai-stream-parse";

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("openai-stream-parse", () => {
  it("findSseSeparator prefers earlier of lf and crlf", () => {
    expect(findSseSeparator("a\n\nb")).toBe(1);
    expect(findSseSeparator("a\r\n\r\nb")).toBe(1);
    expect(findSseSeparator("no sep")).toBe(-1);
    // mixed separators: earlier wins
    expect(findSseSeparator("a\n\nb\r\n\r\nc")).toBe(1);
    expect(findSseSeparator("a\r\n\r\nb\n\nc")).toBe(1);
  });

  it("parseSseFrame aggregates data lines and [DONE]", () => {
    expect(parseSseFrame("data: [DONE]")).toBe("[DONE]");
    expect(parseSseFrame("data: {\"a\":1}")).toEqual({ a: 1 });
    expect(parseSseFrame("event: ping\n\n")).toBeNull();
    expect(
      parseSseFrame("data: {\"x\":\n data: 1}"),
    ).toEqual({ x: 1 });
    // multi-line JSON across data: lines
    expect(
      parseSseFrame("data: {\"msg\":\n data: \"hi\"}"),
    ).toEqual({ msg: "hi" });
  });

  it("parseSseFrame does not throw on keep-alive or non-objects", () => {
    expect(() => parseSseFrame("data: not-json")).not.toThrow();
    expect(parseSseFrame("data: not-json")).toBeNull();
    expect(parseSseFrame("data: [1,2]")).toBeNull();
    expect(parseSseFrame("data: \"str\"")).toBeNull();
    expect(parseSseFrame("data: :")).toBeNull();
    expect(parseSseFrame("")).toBeNull();
    expect(parseSseFrame(": comment only")).toBeNull();
  });

  it("parseSseFrame throws MalformedSseFrameError for JSON-looking corrupt payloads", () => {
    expect(() => parseSseFrame("data: {bad json}")).toThrow(MalformedSseFrameError);
    expect(() => parseSseFrame("data: [1,")).toThrow(MalformedSseFrameError);
    try {
      parseSseFrame("data: {\"truncated\":");
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedSseFrameError);
      expect((error as MalformedSseFrameError).raw).toContain("truncated");
      expect((error as MalformedSseFrameError).message).toMatch(/Malformed SSE JSON/);
    }
  });

  it("readSseJson surfaces malformed JSON frames as thrown errors after partial yield", async () => {
    const body = sseBody([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: {bad json}\n\n",
    ]);
    const events: unknown[] = [];
    await expect(async () => {
      for await (const event of readSseJson(body)) {
        events.push(event);
      }
    }).rejects.toBeInstanceOf(MalformedSseFrameError);
    expect(events).toEqual([{ choices: [{ delta: { content: "ok" } }] }]);
  });

  it("readSseJson emits diagnostics and drains trailing buffer without [DONE]", async () => {
    const diagnostics: SseDiagnosticsOptions = {
      enabled: true,
      providerId: "test",
      endpoint: "chat-completions",
      url: "https://example.test/v1/chat/completions",
      attempt: 1,
      maxAttempts: 1,
    };
    const body = sseBody(['data: {"n":1}\n\n', 'data: {"n":2}']);
    const events = [];
    for await (const event of readSseJson(body, diagnostics)) {
      events.push(event);
    }
    expect(events.some((e) => (e as { __kind?: string }).__kind === "diagnostic")).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ __kind: "diagnostic", diagnostic: expect.objectContaining({ phase: "sse-first-byte" }) }),
        { n: 1 },
        { n: 2 },
        expect.objectContaining({ __kind: "diagnostic", diagnostic: expect.objectContaining({ phase: "stream-end" }) }),
      ]),
    );
  });

  it("createSseAbortError prefers AbortSignal reason", () => {
    const controller = new AbortController();
    controller.abort(new Error("user-cancel"));
    expect(createSseAbortError(controller.signal).message).toBe("user-cancel");
    expect(createSseAbortError(undefined).message).toMatch(/cancelled|aborted/i);
  });

  it("normalizeStreamTimeoutMs drops non-positive and non-finite values", () => {
    expect(normalizeStreamTimeoutMs(undefined)).toBeUndefined();
    expect(normalizeStreamTimeoutMs(0)).toBeUndefined();
    expect(normalizeStreamTimeoutMs(-1)).toBeUndefined();
    expect(normalizeStreamTimeoutMs(Number.NaN)).toBeUndefined();
    expect(normalizeStreamTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeStreamTimeoutMs(1500.9)).toBe(1500);
  });

  it("sseSeparatorLength distinguishes CRLF and LF frame boundaries", () => {
    expect(sseSeparatorLength("a\r\n\r\nb", 1)).toBe(4);
    expect(sseSeparatorLength("a\n\nb", 1)).toBe(2);
    expect(sseSeparatorLength("none", 0)).toBe(0);
    expect(findSseSeparator("a\r\n\r\nb")).toBe(1);
  });

  it("readSseJson aborts promptly when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    const body = sseBody(['data: {"n":1}\n\n']);
    await expect(async () => {
      for await (const _ of readSseJson(body, undefined, controller.signal)) {
        /* drain */
      }
    }).rejects.toThrow(/pre-aborted|abort/i);
  });
});
