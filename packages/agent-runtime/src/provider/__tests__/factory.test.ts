import { describe, it, expect, beforeEach } from "vitest";
import { setAllowTestLocalhost } from "../auth/base-url-validator";
import { ProviderRegistryV2Impl, EngineProvider } from "../registry-v2";
import { ProviderFactory } from "../factory";
import { normalizeDeclarativeDef } from "../declarative-schema";
import type { DeclarativeProviderEntry } from "../registry-v2";
import type { DeclarativeProviderDef } from "../declarative-schema";
import type { Engine, EngineOptions, EngineRequest } from "../types";
import type { AgentProviderRequest, ProviderStreamEvent } from "../../types";

function registerProvider(
  registry: ProviderRegistryV2Impl,
  overrides?: Partial<DeclarativeProviderDef>,
  filePath = "/test/provider.json",
): string {
  const raw: DeclarativeProviderDef = {
    providerId: "test-provider",
    name: "Test Provider",
    engine: "openai-compatible",
    baseUrl: "https://api.test.com/v1",
    models: [{ id: "test-model" }],
    auth: { type: "api-key", placement: "header" },
    ...overrides,
  };
  const normalized = normalizeDeclarativeDef(raw);
  const entry: DeclarativeProviderEntry = {
    providerId: normalized.providerId,
    engine: normalized.engine,
    metadata: {
      name: raw.name,
      models: normalized.models.map((m) => m.id),
      capabilities: [],
      defaultBaseUrl: normalized.baseUrl,
      apiKeyEnv: normalized.auth.defaultEnvVar,
      endpointType: raw.endpointType ?? "auto",
      streamingSupport: raw.streamingSupport ?? "streaming",
    },
    declarative: normalized,
  };
  registry.registerDeclarative(entry, filePath);
  return normalized.providerId;
}

describe("ProviderFactory", () => {
  let registry: ProviderRegistryV2Impl;
  let factory: ProviderFactory;

  beforeEach(() => {
    setAllowTestLocalhost(false);
    registry = new ProviderRegistryV2Impl();
    factory = new ProviderFactory();
  });

  it("creates an OpenAI-compatible provider from registered def", () => {
    registerProvider(registry);
    const provider = factory.createProvider("test-provider", {
      apiKey: "sk-test",
    });
    expect(provider).toBeInstanceOf(EngineProvider);
    expect(provider.id).toBe("test-provider");
  });

  it("creates an Anthropic provider from registered def", () => {
    registerProvider(registry, {
      providerId: "claude",
      engine: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      models: [{ id: "claude-sonnet-4" }],
    });
    const provider = factory.createProvider("claude", {
      apiKey: "sk-ant-test",
    });
    expect(provider).toBeInstanceOf(EngineProvider);
    expect(provider.id).toBe("claude");
  });

  it("creates an Ollama provider from registered def", () => {
    registerProvider(registry, {
      providerId: "local-ollama",
      engine: "ollama",
      baseUrl: "http://ollama.local:11434",
      models: [{ id: "llama3" }],
    });
    const provider = factory.createProvider("local-ollama", {});
    expect(provider).toBeInstanceOf(EngineProvider);
    expect(provider.id).toBe("local-ollama");
  });

  it("throws for unknown providerId", () => {
    expect(() => factory.createProvider("nonexistent", {})).toThrow(
      "Unknown provider: nonexistent",
    );
  });

  it("supports registering custom engines", () => {
    const customEngine: Engine = {
      id: "custom-engine",
      buildRequest(_request: AgentProviderRequest, _options: EngineOptions): EngineRequest {
        return { url: "https://custom/api", init: { method: "POST" } };
      },
      async *parseStream(): AsyncIterable<ProviderStreamEvent> {
        yield { type: "stop", reason: "stop" };
      },
      async *parseResponse(): AsyncIterable<ProviderStreamEvent> {
        yield { type: "stop", reason: "stop" };
      },
    };
    registry.registerEngineClass("custom-engine", { id: "custom-engine", createEngine: () => customEngine });
    registerProvider(registry, {
      providerId: "custom-provider",
      engine: "custom-engine",
      baseUrl: "https://custom/api",
      models: [{ id: "custom-model" }],
    } as any);
    const provider = registry.createProvider("custom-provider", { type: "api-key", apiKey: "" });
    expect(provider).toBeInstanceOf(EngineProvider);
    expect(provider.id).toBe("custom-provider");
  });

  it("creates provider with custom baseUrl override", () => {
    registerProvider(registry);
    const provider = factory.createProvider("test-provider", {
      apiKey: "sk-test",
      baseUrl: "https://custom-proxy.test/v1",
    }) as EngineProvider;
    expect(provider).toBeDefined();
  });

  it("creates provider with custom headers", () => {
    registerProvider(registry);
    const provider = factory.createProvider("test-provider", {
      apiKey: "sk-test",
      headers: { "X-Custom": "value" },
    });
    expect(provider).toBeDefined();
  });

  it("throws SSRF error when baseUrl points to localhost", () => {
    registerProvider(registry, {
      providerId: "evil",
      engine: "openai-compatible",
      baseUrl: "http://localhost:8080",
      models: [{ id: "test-model" }],
    });
    expect(() => factory.createProvider("evil", {})).toThrow("SSRF rejected:");
  });

  it("throws SSRF error when credential baseUrl is a private IP", () => {
    registerProvider(registry);
    expect(() =>
      factory.createProvider("test-provider", {
        apiKey: "sk-test",
        baseUrl: "http://192.168.1.1:8080",
      }),
    ).toThrow("SSRF rejected:");
  });

  it("stream() yields error when fetch fails", async () => {
    registerProvider(registry);
    const provider = factory.createProvider("test-provider", {
      apiKey: "sk-test",
    });
    const request: AgentProviderRequest = {
      sessionId: "test-session",
      cwd: "/test",
      messages: [{ id: "msg-1", role: "user", createdAt: new Date().toISOString(), blocks: [{ type: "text", text: "hi" }] }],
      tools: [],
      signal: new AbortController().signal,
    };
    const events: ProviderStreamEvent[] = [];
    for await (const evt of provider.stream(request)) {
      events.push(evt);
    }
    expect(events).toHaveLength(1);
    const stop = events[0]!;
    expect(stop.type).toBe("stop");
    if (stop.type === "stop" && "error" in stop) {
      expect((stop as { error?: string }).error).toBeDefined();
    }
  });
});
