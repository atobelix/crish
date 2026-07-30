import type { AgentProvider, Engine } from './types';
import { ProviderRegistryV2Impl, type ProviderRegistryV2 } from './registry-v2';
import type { DirectApiKeyProviderCredentialSource } from '../provider-gateway/types';

export class DefaultAgentProviderFactory {
  private readonly registry: ProviderRegistryV2 = new ProviderRegistryV2Impl();
  private readonly engineCache = new Map<string, Engine>();

  constructor() {}

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
    }
  ): AgentProvider {
    const credSource: DirectApiKeyProviderCredentialSource = {
      type: 'api-key',
      apiKey: credential.apiKey ?? '',
      ...(credential.baseUrl !== undefined
        ? { baseUrl: credential.baseUrl }
        : {}),
      ...(credential.headers !== undefined
        ? { headers: credential.headers }
        : {}),
    };
    return this.registry.createProvider(providerId, credSource);
  }
}

export { DefaultAgentProviderFactory as ProviderFactory };
export { EngineProvider } from './registry-v2';
