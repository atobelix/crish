import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { LlmApiMockServer, Scenarios } from "./mock-server";
import { executeWithFallback, type RecoveryPipelineConfig } from "../../../recovery-pipeline";
import type { AgentProvider, AgentProviderRequest, ProviderStreamEvent } from "../../../types";

describe("E2E: context overflow self-healing", () => {
  const server = new LlmApiMockServer();

  beforeAll(async () => {
    await server.start(0);
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.clearLog();
    server.clearRequestCounts();
  });

  it("mock server returns 400 context_length_exceeded on first request, 200 on retry", async () => {
    server.on("/v1/context-test", Scenarios.contextLengthFollowedBySuccess());

    // First request: should get 400 with context_length_exceeded
    const res1 = await fetch(`${server.getBaseUrl()}/v1/context-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] }),
    });
    expect(res1.status).toBe(400);
    const body1 = await res1.json();
    expect(body1.error.message).toContain("context_length_exceeded");

    // Second request: should get 200 streaming success
    const res2 = await fetch(`${server.getBaseUrl()}/v1/context-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] }),
    });
    expect(res2.status).toBe(200);

    const reader = res2.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain("Retry");
    expect(text).toContain("succeeded");
    expect(text).toContain("[DONE]");

    expect(server.getRequestCount("/v1/context-test")).toBe(2);
  });

  it("tracks request count per path", async () => {
    server.on("/v1/count-test-1", Scenarios.contextLengthFollowedBySuccess());
    server.on("/v1/count-test-2", Scenarios.contextLengthFollowedBySuccess());

    await fetch(`${server.getBaseUrl()}/v1/count-test-1`, { method: "POST" });
    await fetch(`${server.getBaseUrl()}/v1/count-test-1`, { method: "POST" });
    await fetch(`${server.getBaseUrl()}/v1/count-test-2`, { method: "POST" });

    expect(server.getRequestCount("/v1/count-test-1")).toBe(2);
    expect(server.getRequestCount("/v1/count-test-2")).toBe(1);
  });

  it("phase falls back to last phase when request count exceeds phase count", async () => {
    server.on("/v1/overflow-test", Scenarios.contextLengthFollowedBySuccess());

    // First: 400
    const r1 = await fetch(`${server.getBaseUrl()}/v1/overflow-test`);
    expect(r1.status).toBe(400);

    // Second: 200 streaming
    const r2 = await fetch(`${server.getBaseUrl()}/v1/overflow-test`);
    expect(r2.status).toBe(200);

    // Third and beyond: also 200 streaming (fallback to last phase)
    const r3 = await fetch(`${server.getBaseUrl()}/v1/overflow-test`);
    expect(r3.status).toBe(200);

    expect(server.getRequestCount("/v1/overflow-test")).toBe(3);
  });

  it("recovery pipeline triggers context healer and retries on context_length_exceeded", async () => {
    server.on("/v1/chat/completions", Scenarios.contextLengthFollowedBySuccess());

    // Build a mock provider that points to the mock server
    const mockProvider: AgentProvider = {
      id: "mock-openai",
      async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
        if (request.signal.aborted) return;

        const url = `${server.getBaseUrl()}/v1/chat/completions`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer test-key" },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: request.messages.map(m => ({
              role: m.role,
              content: m.blocks.map(b => (b as { text: string }).text).join(""),
            })),
            stream: true,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          yield {
            type: "stop" as const,
            reason: "error" as const,
            error: `[${this.id}] ${response.status}: ${body.slice(0, 200)}`,
          };
          return;
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(":")) continue;
              if (trimmed.startsWith("data: ")) {
                const data = trimmed.slice(6);
                if (data === "[DONE]") {
                  yield { type: "stop" as const, reason: "stop" as const };
                  return;
                }
                try {
                  const parsed = JSON.parse(data);
                  const delta = parsed.choices?.[0]?.delta;
                  if (delta?.content) {
                    yield {
                      type: "text-delta" as const,
                      text: delta.content,
                    };
                  }
                  if (parsed.choices?.[0]?.finish_reason === "stop") {
                    yield { type: "stop" as const, reason: "stop" as const };
                    return;
                  }
                } catch {
                  // skip parse errors
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
        yield { type: "stop" as const, reason: "stop" as const };
      },
    };

    let healed = false;

    const pipelineConfig: RecoveryPipelineConfig = {
      maxTransportRetries: 0,
      transportBackoffMs: 100,
      fallbackProviders: [],
      fallbackConfig: { maxAttempts: 1 },
      providerResolver: () => mockProvider,
      contextHealer: async () => {
        healed = true;
        return true;
      },
    };

    const result = await executeWithFallback(
      {
        sessionId: "test-session",
        cwd: "/test",
        messages: [{ id: "m1", role: "user", createdAt: new Date().toISOString(), blocks: [{ type: "text", text: "Hello" }] }],
        tools: [],
        signal: new AbortController().signal,
      },
      mockProvider,
      pipelineConfig,
    );

    expect(result.ok).toBe(true);
    expect(healed).toBe(true);
    expect(server.getRequestCount("/v1/chat/completions")).toBe(2);

    if (result.ok) {
      const events: ProviderStreamEvent[] = [];
      for await (const ev of result.events) {
        events.push(ev);
        if (ev.type === "stop") break;
      }
      expect(events.length).toBeGreaterThan(0);
      const stopEvent = events.find(e => e.type === "stop");
      expect(stopEvent).toBeDefined();
      expect(stopEvent!.reason).not.toBe("error");
    }
  });

  it("returns context_length_exceeded error when context healer is not provided", async () => {
    const isolatedServer = new LlmApiMockServer();
    await isolatedServer.start(0);
    isolatedServer.on("/chat/completions", Scenarios.contextLengthFollowedBySuccess());

    const mockProvider: AgentProvider = {
      id: "mock-no-heal",
      async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
        if (request.signal.aborted) return;

        const url = `${isolatedServer.getBaseUrl()}/chat/completions`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: request.messages.map(m => ({
              role: m.role,
              content: m.blocks.map(b => (b as { text: string }).text).join(""),
            })),
            stream: true,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          yield {
            type: "stop" as const,
            reason: "error" as const,
            error: `[${this.id}] ${response.status}: ${body.slice(0, 200)}`,
          };
          return;
        }

        yield { type: "stop" as const, reason: "stop" as const };
      },
    };

    const pipelineConfig: RecoveryPipelineConfig = {
      maxTransportRetries: 0,
      transportBackoffMs: 100,
      fallbackProviders: [],
      fallbackConfig: { maxAttempts: 1 },
      providerResolver: () => mockProvider,
    };

    const result = await executeWithFallback(
      {
        sessionId: "test-session",
        cwd: "/test",
        messages: [{ id: "m1", role: "user", createdAt: new Date().toISOString(), blocks: [{ type: "text", text: "Hello" }] }],
        tools: [],
        signal: new AbortController().signal,
      },
      mockProvider,
      pipelineConfig,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.subType).toBe("context_length_exceeded");
    }

    await isolatedServer.stop();
  });
});
