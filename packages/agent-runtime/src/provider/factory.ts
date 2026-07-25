import type { AgentProvider } from "../types";
import type { Engine } from "./types";
import type { ProviderRegistryV2 } from "./registry-v2";

export class ProviderFactory {
  private engineCache = new Map<string, Engine>();
  private registry: ProviderRegistryV2;

  constructor(registry: ProviderRegistryV2) {
    this.registry = registry;
  }

  registerEngineClass(): void {
    // Engine classes are managed by V2; this is a no-op stub
  }

  registerEngine(engine: Engine): void {
    this.engineCache.set(engine.id, engine);
  }

  getEngine(id: string): Engine | undefined {
    return this.engineCache.get(id);
  }

  createProvider(
    providerId: string,
    credential: {
      apiKey?: string;
      baseUrl?: string;
      headers?: Record<string, string>;
    },
  ): AgentProvider {
    return this.registry.createProvider(providerId, {
      type: "api-key",
      apiKey: credential.apiKey ?? "",
      ...(credential.baseUrl !== undefined ? { baseUrl: credential.baseUrl } : {}),
      ...(credential.headers !== undefined ? { headers: credential.headers } : {}),
    } as const as any);
  }
}

export { EngineProvider } from "./registry-v2";
