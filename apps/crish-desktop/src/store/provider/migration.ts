import type { ProviderConfig, AuthConfig, EngineType } from "./types";

const OLD_STORE_KEY = "crish_provider_profiles_v1";

interface OldProviderProfile {
  id: string;
  name: string;
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  endpoint?: string;
  providerId?: string;
}

export function migrateFromV1(): ProviderConfig[] {
  try {
    const raw = localStorage.getItem(OLD_STORE_KEY);
    if (!raw) return [];

    const profiles: OldProviderProfile[] = JSON.parse(raw);
    if (!Array.isArray(profiles)) return [];

    return profiles.map((old, i): ProviderConfig => {
      const engineType: EngineType =
        old.provider === "anthropic" ? "anthropic-native" :
        old.provider === "gemini" ? "gemini-native" : "openai-compatible";

      const auth: AuthConfig = old.apiKey
        ? { mode: "api_key", apiKey: old.apiKey, apiKeyHeader: "Authorization" }
        : { mode: "none" };

      return {
        id: old.id ?? `migrated-${i}`,
        name: old.name ?? old.provider,
        engineType,
        baseUrl: old.baseUrl ?? getDefaultBaseUrl(engineType),
        auth,
        models: old.model ? [{
          id: old.model,
          providerId: old.id ?? `migrated-${i}`,
          contextWindow: 128000,
          maxOutputTokens: 4096,
          pricing: [],
          capabilities: [],
          aliases: [],
          isDeprecated: false,
          order: 0,
          enabled: true,
        }] : [],
        autoSyncModels: false,
        rateLimit: { rpm: 0, tpm: 0, coolDownMs: 1000, maxConcurrency: 1 },
        fallback: { errorTypes: [] },
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
  } catch {
    return [];
  }
}

function getDefaultBaseUrl(engine: EngineType): string {
  switch (engine) {
    case "openai-compatible": return "https://api.openai.com/v1";
    case "anthropic-native": return "https://api.anthropic.com/v1";
    case "gemini-native": return "https://generativelanguage.googleapis.com/v1beta/openai";
    default: return "";
  }
}
