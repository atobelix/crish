import { describe, expect, it, vi } from "vitest";
import { executeWithFallback } from "./recovery-pipeline";
import type { ProviderStreamEvent } from "@crish/shared-types";
import type { AgentProvider, AgentProviderRequest } from "./core/runtime-options";

function mockProvider(id: string, events: ProviderStreamEvent[]): AgentProvider {
  return {
    id,
    async *stream(_request: AgentProviderRequest) {
      for (const e of events) yield e;
    },
  };
}

function mockProviderWithThrow(id: string, error: Error): AgentProvider {
  return {
    id,
    async *stream(_request: AgentProviderRequest) {
      throw error;
    },
  };
}

const baseRequest: AgentProviderRequest = {
  sessionId: "s1",
  cwd: "/",
  messages: [],
  tools: [],
  signal: new AbortController().signal,
};

function defaultConfig(overrides: Record<string, unknown> = {}) {
  return {
    maxTransportRetries: 2,
    transportBackoffMs: 1,
    fallbackProviders: [],
    fallbackConfig: { maxAttempts: 2 },
    providerResolver: (_id: string) => mockProvider("dummy", []),
    onActionableError: vi.fn(),
    ...overrides,
  };
}

describe("recovery-pipeline", () => {
  it("succeeds on the first try with no errors", async () => {
    const provider = mockProvider("primary", [
      { type: "text-delta", text: "hello" },
      { type: "stop", reason: "stop" },
    ]);
    const result = await executeWithFallback(baseRequest, provider, defaultConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events: ProviderStreamEvent[] = [];
    for await (const e of result.events) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "text-delta" && (e as any).text === "hello")).toBe(true);
  });

  it("retries on transient network error (throw)", async () => {
    const streamFn = vi.fn()
      .mockImplementationOnce(async function* () {
        throw new Error("ECONNRESET");
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text-delta", text: "ok" } as ProviderStreamEvent;
        yield { type: "stop", reason: "stop" } as ProviderStreamEvent;
      });

    const provider: AgentProvider = { id: "primary", stream: streamFn };
    const config = defaultConfig({ maxTransportRetries: 3, transportBackoffMs: 1 });
    const result = await executeWithFallback(baseRequest, provider, config);
    expect(result.ok).toBe(true);
  });

  it("retries on transient error in stop event", async () => {
    const streamFn = vi.fn()
      .mockImplementationOnce(async function* () {
        yield { type: "stop", reason: "error", error: "timeout" } as ProviderStreamEvent;
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text-delta", text: "ok" } as ProviderStreamEvent;
        yield { type: "stop", reason: "stop" } as ProviderStreamEvent;
      });

    const provider: AgentProvider = { id: "primary", stream: streamFn };
    const config = defaultConfig({ maxTransportRetries: 3, transportBackoffMs: 1 });
    const result = await executeWithFallback(baseRequest, provider, config);
    expect(result.ok).toBe(true);
  });

  it("returns error when max retries exceeded", async () => {
    const provider = mockProviderWithThrow("primary", new Error("ECONNRESET"));
    const config = defaultConfig({ maxTransportRetries: 1, transportBackoffMs: 1 });
    const result = await executeWithFallback(baseRequest, provider, config);
    expect(result.ok).toBe(false);
  });

  it("calls onActionableError on non-retryable errors", async () => {
    const onError = vi.fn();
    const provider = mockProviderWithThrow("primary", new Error("auth failed"));
    const config = defaultConfig({ maxTransportRetries: 1, transportBackoffMs: 1, onActionableError: onError });
    const result = await executeWithFallback(baseRequest, provider, config);
    expect(result.ok).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("handles empty provider stream gracefully", async () => {
    const provider = mockProvider("primary", []);
    const config = defaultConfig();
    const result = await executeWithFallback(baseRequest, provider, config);
    expect(result.ok).toBe(true);
  });

  it("recovers from context length exceeded via contextHealer", async () => {
    const healer = vi.fn().mockResolvedValue(true);
    const streamFn = vi.fn()
      .mockImplementationOnce(async function* () {
        yield { type: "stop", reason: "error", error: "context length exceeded" } as ProviderStreamEvent;
      })
      .mockImplementationOnce(async function* () {
        yield { type: "text-delta", text: "healed" } as ProviderStreamEvent;
        yield { type: "stop", reason: "stop" } as ProviderStreamEvent;
      });

    const provider: AgentProvider = { id: "primary", stream: streamFn };
    const config = defaultConfig({ contextHealer: healer, maxTransportRetries: 1, transportBackoffMs: 1 });
    const result = await executeWithFallback(baseRequest, provider, config);
    expect(result.ok).toBe(true);
    expect(healer).toHaveBeenCalled();
  });

  it("enforces max depth to prevent infinite recursion", async () => {
    const healer = vi.fn().mockResolvedValue(true);
    const provider = mockProviderWithThrow("primary", new Error("context length exceeded"));
    const config = defaultConfig({
      contextHealer: healer,
      maxTransportRetries: 1,
      transportBackoffMs: 1,
    });
    const result = await executeWithFallback(baseRequest, provider, config);
    expect(result.ok).toBe(false);
  });
});
