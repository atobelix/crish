import { bench, describe } from "vitest";
import { ProviderRegistryV2Impl } from "../../registry-v2";
import { normalizeDeclarativeDef } from "../../declarative-schema";
import type { DeclarativeProviderEntry } from "../../registry-v2";
import type { DeclarativeProviderDef } from "../../declarative-schema";

function makeEntry(overrides?: Partial<DeclarativeProviderDef>): DeclarativeProviderEntry {
  const raw: DeclarativeProviderDef = {
    providerId: "bench-provider",
    name: "Bench Provider",
    engine: "openai-compatible",
    baseUrl: "https://api.bench.com/v1",
    auth: { type: "api-key", placement: "header", keyHeader: "Authorization", defaultEnvVar: "BENCH_API_KEY" },
    models: [{ id: "bench-model", aliases: [], capabilities: [], contextWindow: 128000, maxOutputTokens: 4096, costPer1kInput: 0, costPer1kOutput: 0 }],
    paths: { chatCompletions: "/v1/chat/completions", models: "/v1/models" },
    capabilities: { toolUse: true, vision: false, reasoning: false, streaming: true, systemPrompt: true, jsonMode: false, parallelToolCalls: true },
    engineOptions: { authHeader: "authorization", maxTokensField: "max_tokens", reasoningContent: "omit", toolChoice: "auto", anthropicVersion: "2023-06-01", keepAlive: "5m" },
    rateLimiting: { requestsPerMinute: 0, tokensPerMinute: 0 },
    metadata: {},
    ...overrides,
  };
  const normalized = normalizeDeclarativeDef(raw);
  return {
    providerId: normalized.providerId,
    engine: normalized.engine,
    metadata: {
      name: raw.name,
      ...(raw.description !== undefined ? { description: raw.description } : {}),
      models: normalized.models.map(m => m.id),
      capabilities: ["code", "tool-use"],
      defaultBaseUrl: normalized.baseUrl,
      ...(raw.website !== undefined ? { website: raw.website } : {}),
      ...(raw.docsUrl !== undefined ? { docsUrl: raw.docsUrl } : {}),
      apiKeyEnv: normalized.auth.defaultEnvVar,
      endpointType: raw.endpointType ?? "auto",
      streamingSupport: raw.streamingSupport ?? "streaming",
    },
    declarative: normalized,
  };
}

const registry = new ProviderRegistryV2Impl();

registry.registerDeclarative(makeEntry({
  providerId: "bench-provider",
  name: "Bench Provider",
  capabilities: { toolUse: true, vision: false, reasoning: false, streaming: true, systemPrompt: true, jsonMode: false, parallelToolCalls: true },
}), "/bench/provider.json");

describe("Provider Lifecycle Benchmarks", () => {
  bench("register 100 providers", () => {
    const r = new ProviderRegistryV2Impl();
    for (let i = 0; i < 100; i++) {
      r.registerDeclarative(
        makeEntry({ providerId: `p-${i}`, name: `P${i}`, models: [{ id: `m-${i}` }] }),
        `/bench/p-${i}.json`,
      );
    }
  });

  bench("lookup provider by id", () => {
    registry.getDeclarativeEntry("bench-provider");
  });

  bench("create provider from factory", () => {
    registry.createProvider("bench-provider", { type: "api-key", apiKey: "test-key" });
  });

  bench("list providers", () => {
    registry.listDeclarativeEntries();
  });
});
