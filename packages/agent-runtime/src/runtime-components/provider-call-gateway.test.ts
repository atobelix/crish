import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider, AgentProviderRequest, ProviderStreamEvent } from "../types";
import { ProviderCallGateway } from "./provider-call-gateway";
import { FauxAgentProvider } from "../testing/faux-provider";
import type { ProviderStreamContractEvent } from "../provider-stream-contract";

function createProvider(events: ProviderStreamEvent[]): AgentProvider {
  return {
    id: "test-provider",
    async *stream(_request: AgentProviderRequest) {
      for (const event of events) yield event;
    },
  };
}

function createRequest(overrides: Partial<AgentProviderRequest> = {}): AgentProviderRequest {
  return {
    sessionId: "s_test",
    cwd: "C:/workspace",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collectCall(
  gateway: ProviderCallGateway,
  provider: AgentProvider,
  request: AgentProviderRequest,
): Promise<{
  events: ProviderStreamContractEvent[];
  result: import("./provider-call-gateway").ProviderCallResult;
}> {
  const events: ProviderStreamContractEvent[] = [];
  const iterator = gateway.call(provider, request);
  let result: import("./provider-call-gateway").ProviderCallResult | undefined;
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
  }
  return { events, result: result! };
}

describe("ProviderCallGateway", () => {
  it("streams text-delta events and returns accumulated text", async () => {
    const gateway = new ProviderCallGateway();
    const provider = createProvider([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " World" },
      { type: "stop", reason: "stop" },
    ]);
    const { events, result } = await collectCall(gateway, provider, createRequest());

    expect(result.response.text).toBe("Hello World");
    expect(result.response.finishReason).toBe("stop");
    expect(events.some((e) => e.type === "delta")).toBe(true);
  });

  it("captures tool calls from provider events", async () => {
    const gateway = new ProviderCallGateway();
    const provider = createProvider([
      {
        type: "tool-call",
        id: "call_1",
        toolName: "read_file",
        input: { path: "/tmp/test" },
      },
      { type: "stop", reason: "tool-call" },
    ]);
    const { result } = await collectCall(gateway, provider, createRequest());

    expect(result.response.toolCalls).toHaveLength(1);
    expect(result.response.toolCalls![0]).toMatchObject({
      toolName: "read_file",
      input: { path: "/tmp/test" },
    });
    expect(result.response.finishReason).toBe("tool-call");
  });

  it("captures provider diagnostics", async () => {
    const gateway = new ProviderCallGateway();
    const provider = createProvider([
      { type: "provider-diagnostic", diagnostic: { phase: "request-start", providerId: "test", endpoint: "chat" } },
      { type: "text-delta", text: "ok" },
      { type: "stop", reason: "stop" },
    ]);
    const { result } = await collectCall(gateway, provider, createRequest());

    expect(result.response.diagnostics).toHaveLength(1);
    expect(result.response.diagnostics![0]).toMatchObject({ phase: "request-start" });
  });

  it("reports error when provider throws during streaming", async () => {
    const gateway = new ProviderCallGateway();
    const provider = createProvider([
      { type: "text-delta", text: "partial" },
      { type: "stop", reason: "error", error: "connection lost" },
    ]);
    const { result } = await collectCall(gateway, provider, createRequest());

    expect(result.response.finishReason).toBe("error");
    expect(result.response.error).toMatch(/connection lost/i);
  });

  it("records usage when present in end event", async () => {
    const gateway = new ProviderCallGateway();
    const provider = createProvider([
      { type: "text-delta", text: "done" },
      { type: "stop", reason: "stop", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } },
    ]);
    const { result } = await collectCall(gateway, provider, createRequest());

    expect(result.response.usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });

  it("handles empty provider response gracefully", async () => {
    const gateway = new ProviderCallGateway();
    const provider = createProvider([{ type: "stop", reason: "stop" }]);
    const { result } = await collectCall(gateway, provider, createRequest());

    expect(result.response.text).toBe("");
    expect(result.response.finishReason).toBe("stop");
  });

  it("aborts early when signal is already aborted", async () => {
    const gateway = new ProviderCallGateway();
    const controller = new AbortController();
    controller.abort();
    const provider = createProvider([
      { type: "text-delta", text: "should not appear" },
      { type: "stop", reason: "stop" },
    ]);
    const { result } = await collectCall(gateway, provider, createRequest({ signal: controller.signal }));

    expect(result.response.finishReason).toBe("error");
    expect(result.response.error).toBe("aborted");
  });

  it("returns empty toolCalls when none provided", async () => {
    const gateway = new ProviderCallGateway();
    const provider = createProvider([{ type: "stop", reason: "stop" }]);
    const { result } = await collectCall(gateway, provider, createRequest());

    expect(result.response.toolCalls).toEqual([]);
  });

  it("does not have connection manager by default", () => {
    const gateway = new ProviderCallGateway();
    expect(gateway.getConnectionManager()).toBeUndefined();
  });

  it("does not have token tracker by default", () => {
    const gateway = new ProviderCallGateway();
    expect(gateway.getTokenTracker()).toBeUndefined();
  });

  // ─── J-10: Error injection & recovery ───────────────

  describe("J-10 error injection & recovery", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("FauxAgentProvider normal flow through ProviderCallGateway", async () => {
      const faux = new FauxAgentProvider("faux-test");
      faux.setEvents([
        { type: "start" } as any,
        { type: "delta", delta: { type: "text", text: "Faux says hi" } } as any,
        { type: "end", finishReason: "stop" } as any,
      ]);

      const gateway = new ProviderCallGateway();
      const { events, result } = await collectCall(gateway, faux as any, createRequest());

      expect(result.response.text).toBe("Faux says hi");
      expect(result.response.finishReason).toBe("stop");
      expect(events.some((e) => e.type === "delta")).toBe(true);
    });

    it("handles provider errors gracefully and returns error response", async () => {
      const faux = new FauxAgentProvider("err-test");
      faux.setError(new Error("connection lost"));

      const gateway = new ProviderCallGateway();
      const { result } = await collectCall(gateway, faux as any, createRequest());

      expect(result.response.finishReason).toBe("error");
      expect(result.response.error).toBe("connection lost");
    });

    it("FauxAgentProvider with failAfter yields partial events", async () => {
      const faux = new FauxAgentProvider("faux-partial");
      faux.setEvents([
        { type: "start" } as any,
        { type: "delta", delta: { type: "text", text: "before fail" } } as any,
        { type: "end", finishReason: "stop" } as any,
      ]);
      faux.setFailAfter(2);

      const gateway = new ProviderCallGateway();
      const { result } = await collectCall(gateway, faux as any, createRequest());

      expect(result.response.finishReason).toBe("stop");
    });

    it("FauxAgentProvider with error in stream returns error response", async () => {
      const faux = new FauxAgentProvider("err-stream");
      faux.setEvents([
        { type: "start" } as any,
        { type: "delta", delta: { type: "text", text: "before" } } as any,
        { type: "error", error: { message: "stream failure" } } as any,
      ]);

      const gateway = new ProviderCallGateway();
      const { result } = await collectCall(gateway, faux as any, createRequest());

      expect(result.response.finishReason).toBe("error");
      expect(result.response.text).toBe("before");
    });

    it("retries with exponential backoff on network errors", async () => {
      vi.useFakeTimers();

      let callCount = 0;
      const failingProvider: AgentProvider = {
        id: "retry-provider",
        stream: (_req: AgentProviderRequest) => {
          callCount++;
          throw new Error("network: timeout");
        },
      };

      const gateway = new ProviderCallGateway();
      const request = createRequest();

      const callPromise = collectCall(gateway, failingProvider, request);
      await vi.runAllTimersAsync();
      const { result } = await callPromise;
      vi.useRealTimers();

      expect(callCount).toBeGreaterThan(1);
      expect(result.response.finishReason).toBe("error");
    }, 15000);

    it("streaming error from provider during iteration returns error response", async () => {
      const faux = new FauxAgentProvider("mid-stream-error");
      faux.setEvents([
        { type: "start" } as any,
        { type: "delta", delta: { type: "text", text: "partial" } } as any,
        { type: "end", finishReason: "error", error: { message: "mid-stream failure" } } as any,
      ]);

      const gateway = new ProviderCallGateway();
      const { result } = await collectCall(gateway, faux as any, createRequest());

      expect(result.response.finishReason).toBe("error");
      expect(result.response.text).toBe("partial");
    });

    it("abort during streaming returns aborted error", async () => {
      const controller = new AbortController();
      const faux = new FauxAgentProvider("abort-test");
      faux.setEvents([
        { type: "start" } as any,
        { type: "delta", delta: { type: "text", text: "partial" } } as any,
        { type: "end", finishReason: "stop" } as any,
      ]);

      const gateway = new ProviderCallGateway();
      const iterator = gateway.call(faux as any, createRequest({ signal: controller.signal }));

      const first = await iterator.next();
      expect(first.done).toBe(false);

      controller.abort("user cancelled");

      let result: any;
      while (true) {
        const next = await iterator.next();
        if (next.done) { result = next.value; break; }
      }

      expect(result.response.finishReason).toBe("error");
      expect(result.response.error).toBe("aborted");
    });
  });
});
