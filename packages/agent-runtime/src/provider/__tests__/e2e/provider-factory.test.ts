import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setAllowTestLocalhost } from "../../auth/base-url-validator";
import { LlmApiMockServer, Scenarios } from "./mock-server";
import { ProviderRegistryV2Impl } from "../../registry-v2";
import { ProviderFactory } from "../../factory";
import { normalizeDeclarativeDef } from "../../declarative-schema";
import type { DeclarativeProviderEntry } from "../../registry-v2";
import type { DeclarativeProviderDef } from "../../declarative-schema";
import type { ProviderStreamEvent } from "../../../types";

describe("E2E: ProviderFactory with mock server", () => {
  const server = new LlmApiMockServer();
  let registry: ProviderRegistryV2Impl;
  let factory: ProviderFactory;

  beforeAll(async () => {
    setAllowTestLocalhost(true);
    await server.start(0);

    server.on("/v1/chat/completions", Scenarios.openaiChatText());

    registry = new ProviderRegistryV2Impl();
    factory = new ProviderFactory(registry);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("creates provider and streams response", async () => {
    const raw: DeclarativeProviderDef = {
      providerId: "mock-openai",
      name: "Mock OpenAI",
      engine: "openai-compatible",
      baseUrl: server.getBaseUrl(),
      auth: { type: "api-key", placement: "header", keyHeader: "authorization" },
      models: [{ id: "gpt-4o", contextWindow: 128000, maxOutputTokens: 4096 }],
      paths: { chatCompletions: "/v1/chat/completions" },
      capabilities: { streaming: true, systemPrompt: true },
    };
    const normalized = normalizeDeclarativeDef(raw);
    const entry: DeclarativeProviderEntry = {
      providerId: normalized.providerId,
      engine: normalized.engine,
      metadata: {
        name: raw.name,
        models: normalized.models.map(m => m.id),
        capabilities: [],
        defaultBaseUrl: normalized.baseUrl,
        apiKeyEnv: normalized.auth.defaultEnvVar,
        endpointType: "auto",
        streamingSupport: "streaming",
      },
      declarative: normalized,
    };
    registry.registerDeclarative(entry, "/test/mock-openai.json");

    const provider = factory.createProvider("mock-openai", { apiKey: "test-key" });
    expect(provider.id).toBe("mock-openai");

    const events: ProviderStreamEvent[] = [];
    const controller = new AbortController();
    const stream = provider.stream({
      sessionId: "test-session",
      cwd: "/test",
      messages: [{ id: "m1", role: "user", createdAt: new Date().toISOString(), blocks: [{ type: "text", text: "Hello" }] }],
      tools: [],
      signal: controller.signal,
    });

    for await (const event of stream) {
      events.push(event);
      if (event.type === "stop") break;
    }

    expect(events.length).toBeGreaterThan(0);
    const stopEvent = events.find(e => e.type === "stop")!;
    expect(stopEvent.reason).not.toBe("error");
  });
});
