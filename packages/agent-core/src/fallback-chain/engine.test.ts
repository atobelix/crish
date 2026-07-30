import { describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent } from "@crish/shared-types";
import type { AgentProvider } from "../core/runtime-options";
import { callWithFallbackChain, classifyFallbackError, isNonRetryableClientError, selectFallbackList } from "./engine";
import type { FallbackConfig } from "./types";

function mockProvider(id: string, events: ProviderStreamEvent[]): AgentProvider {
  return {
    id,
    stream: vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    }),
  };
}

function mockProviderWithThrow(id: string, error: Error): AgentProvider {
  return {
    id,
    stream: vi.fn().mockImplementation(async function* () {
      throw error;
    }),
  };
}

describe("classifyFallbackError", () => {
  it("classifies auth error", () => {
    const r = classifyFallbackError(new Error("unauthorized"), 401);
    expect(r.type).toBe("auth-error");
    expect(r.retryable).toBe(false);
  });

  it("classifies rate limit", () => {
    const r = classifyFallbackError(new Error("rate limit"), 429);
    expect(r.type).toBe("rate-limit");
    expect(r.retryable).toBe(true);
  });

  it("classifies timeout", () => {
    const r = classifyFallbackError(new Error("timed out"));
    expect(r.type).toBe("timeout");
    expect(r.retryable).toBe(true);
  });

  it("classifies network error", () => {
    const r = classifyFallbackError(new Error("fetch failed"));
    expect(r.type).toBe("network-error");
    expect(r.retryable).toBe(true);
  });

  it("classifies quota exhausted", () => {
    const r = classifyFallbackError(new Error("out of credits"));
    expect(r.type).toBe("quota-exhausted");
    expect(r.retryable).toBe(false);
  });

  it("classifies context overflow", () => {
    const r = classifyFallbackError(new Error("context length exceeded"));
    expect(r.type).toBe("context-overflow");
    expect(r.retryable).toBe(false);
  });

  it("classifies server error", () => {
    const r = classifyFallbackError(new Error("server error"), 503);
    expect(r.type).toBe("server-error");
    expect(r.retryable).toBe(true);
  });

  it("classifies bad request", () => {
    const r = classifyFallbackError(new Error("bad request"), 400);
    expect(r.type).toBe("bad-request");
    expect(r.retryable).toBe(false);
  });

  it("defaults to unknown", () => {
    const r = classifyFallbackError(new Error("weird error"));
    expect(r.type).toBe("unknown");
    expect(r.retryable).toBe(false);
  });
});

describe("selectFallbackList", () => {
  const config: FallbackConfig = {
    onRateLimit: ["b", "c"],
    onTimeout: ["d"],
    onServerError: ["e"],
    onError: ["f"],
    maxAttempts: 3,
  };

  it("returns type-specific list", () => {
    expect(selectFallbackList("rate-limit", config)).toEqual(["b", "c"]);
  });

  it("falls back to onError when type-specific is missing", () => {
    const cfg: FallbackConfig = { onError: ["x"], maxAttempts: 2 };
    expect(selectFallbackList("rate-limit", cfg)).toEqual(["x"]);
  });

  it("returns undefined when no list is configured", () => {
    expect(selectFallbackList("rate-limit", { maxAttempts: 2 })).toBeUndefined();
  });
});

describe("isNonRetryableClientError", () => {
  it("returns true for auth-error", () => {
    expect(isNonRetryableClientError("auth-error")).toBe(true);
  });

  it("returns true for bad-request", () => {
    expect(isNonRetryableClientError("bad-request")).toBe(true);
  });

  it("returns false for other types", () => {
    expect(isNonRetryableClientError("rate-limit")).toBe(false);
  });
});

describe("callWithFallbackChain", () => {
  const request = { sessionId: "s1", cwd: "/", systemPrompt: "", messages: [], tools: [], signal: new AbortController().signal };

  it("succeeds with primary provider (no error)", async () => {
    const primary = mockProvider("primary", [{ type: "text-delta", text: "hello" }, { type: "stop", reason: "stop" }]);
    const resolver = { getProvider: vi.fn() };
    const config: FallbackConfig = { onError: ["fallback1"], maxAttempts: 2 };

    const events: ProviderStreamEvent[] = [];
    for await (const e of callWithFallbackChain(primary, request, config, resolver)) {
      events.push(e);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text-delta", text: "hello" });
    expect(resolver.getProvider).not.toHaveBeenCalled();
  });

  it("falls back to first fallback when primary errors (stop event)", async () => {
    const primary = mockProvider("primary", [{ type: "stop", reason: "error", error: "timed out" }]);
    const fallback = mockProvider("fallback1", [{ type: "text-delta", text: "ok" }, { type: "stop", reason: "stop" }]);
    const resolver = { getProvider: vi.fn(() => fallback) };
    const config: FallbackConfig = { onTimeout: ["fallback1"], maxAttempts: 2 };

    const events: ProviderStreamEvent[] = [];
    for await (const e of callWithFallbackChain(primary, request, config, resolver)) {
      events.push(e);
    }
    expect(resolver.getProvider).toHaveBeenCalledWith("fallback1");
    const types = events.map(e => e.type);
    expect(types).toContain("text-delta");
  });

  it("iterates through fallback list when first fallback also fails", async () => {
    const primary = mockProvider("primary", [{ type: "stop", reason: "error", error: "timed out" }]);
    const fallback1 = mockProvider("fallback1", [{ type: "stop", reason: "error", error: "timed out" }]);
    const fallback2 = mockProvider("fallback2", [{ type: "text-delta", text: "finally ok" }, { type: "stop", reason: "stop" }]);
    const resolver = { getProvider: vi.fn().mockReturnValueOnce(fallback1).mockReturnValueOnce(fallback2) };
    const config: FallbackConfig = { onTimeout: ["fallback1", "fallback2"], maxAttempts: 3 };

    const events: ProviderStreamEvent[] = [];
    for await (const e of callWithFallbackChain(primary, request, config, resolver)) {
      events.push(e);
    }
    expect(resolver.getProvider).toHaveBeenCalledTimes(2);
    expect(resolver.getProvider).toHaveBeenNthCalledWith(1, "fallback1");
    expect(resolver.getProvider).toHaveBeenNthCalledWith(2, "fallback2");
    expect(events.some(e => e.type === "text-delta" && (e as any).text === "finally ok")).toBe(true);
  });

  it("does not retry an already-attempted model", async () => {
    const primary = mockProvider("primary", [{ type: "stop", reason: "error", error: "timed out" }]);
    const fallback = mockProvider("fallback1", [{ type: "stop", reason: "error", error: "timed out" }]);
    const resolver = { getProvider: vi.fn(() => fallback) };
    const config: FallbackConfig = { onTimeout: ["fallback1", "fallback1"], maxAttempts: 3 };

    const events: ProviderStreamEvent[] = [];
    for await (const e of callWithFallbackChain(primary, request, config, resolver)) {
      events.push(e);
    }
    expect(resolver.getProvider).toHaveBeenCalledTimes(1);
  });

  it("throws when all fallbacks are exhausted (catch branch)", async () => {
    const error = new Error("timed out");
    const primary = mockProviderWithThrow("primary", error);
    const fallback1 = mockProviderWithThrow("fallback1", error);
    const fallback2 = mockProviderWithThrow("fallback2", error);
    const resolver = { getProvider: vi.fn().mockReturnValueOnce(fallback1).mockReturnValueOnce(fallback2) };
    const config: FallbackConfig = { onTimeout: ["fallback1", "fallback2"], maxAttempts: 3 };

    await expect(async () => {
      for await (const _e of callWithFallbackChain(primary, request, config, resolver)) {
        // consume
      }
    }).rejects.toThrow("timed out");
    expect(resolver.getProvider).toHaveBeenCalledTimes(2);
  });

  it("stops on non-retryable error", async () => {
    const primary = mockProvider("primary", [{ type: "stop", reason: "error", error: "auth failed" }]);
    const resolver = { getProvider: vi.fn() };
    const config: FallbackConfig = { onError: ["fallback1"], maxAttempts: 2 };

    const events: ProviderStreamEvent[] = [];
    for await (const e of callWithFallbackChain(primary, request, config, resolver)) {
      events.push(e);
    }
    expect(resolver.getProvider).not.toHaveBeenCalled();
  });

  it("respects maxAttempts limit", async () => {
    const primary = mockProvider("primary", [{ type: "stop", reason: "error", error: "timed out" }]);
    const resolver = { getProvider: vi.fn() };
    const config: FallbackConfig = { onTimeout: ["fallback1"], maxAttempts: 0 };

    const events: ProviderStreamEvent[] = [];
    for await (const e of callWithFallbackChain(primary, request, config, resolver)) {
      events.push(e);
    }
    expect(resolver.getProvider).not.toHaveBeenCalled();
  });
});
