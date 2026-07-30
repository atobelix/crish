import { describe, it, expect } from 'vitest';
import { ProviderRegistryV2Impl } from '../registry-v2';
import { normalizeDeclarativeDef } from '../declarative-schema';
import type { DeclarativeProviderEntry } from '../registry-v2';
import type { DeclarativeProviderDef } from '../declarative-schema';

function makeEntry(
  overrides?: Partial<DeclarativeProviderDef>
): DeclarativeProviderEntry {
  const raw: DeclarativeProviderDef = {
    providerId: 'test-provider',
    name: 'Test Provider',
    engine: 'openai-compatible',
    baseUrl: 'https://api.test.com/v1',
    models: [{ id: 'test-model' }],
    auth: { type: 'api-key', placement: 'header' },
    ...overrides,
  };
  const normalized = normalizeDeclarativeDef(raw);
  return {
    providerId: normalized.providerId,
    engine: normalized.engine,
    metadata: {
      name: raw.name,
      ...(raw.description !== undefined
        ? { description: raw.description }
        : {}),
      models: normalized.models.map((m) => m.id),
      capabilities: [],
      defaultBaseUrl: normalized.baseUrl,
      ...(raw.website !== undefined ? { website: raw.website } : {}),
      ...(raw.docsUrl !== undefined ? { docsUrl: raw.docsUrl } : {}),
      apiKeyEnv: normalized.auth.defaultEnvVar,
      endpointType: raw.endpointType ?? 'auto',
      streamingSupport: raw.streamingSupport ?? 'streaming',
    },
    declarative: normalized,
  };
}

describe('ProviderRegistryV2Impl', () => {
  it('registers and retrieves a provider', () => {
    const registry = new ProviderRegistryV2Impl();
    registry.registerDeclarative(makeEntry(), '/test/provider.json');
    expect(registry.getDeclarativeEntry('test-provider')).toBeDefined();
    expect(registry.getDeclarativeEntry('test-provider')!.providerId).toBe(
      'test-provider'
    );
  });

  it('overwrites on duplicate registration', () => {
    const registry = new ProviderRegistryV2Impl();
    registry.registerDeclarative(makeEntry(), '/test/a.json');
    registry.registerDeclarative(
      makeEntry({ name: 'Updated' }),
      '/test/b.json'
    );
    expect(registry.getDeclarativeEntry('test-provider')).toBeDefined();
    expect(registry.getDeclarativeEntry('test-provider')!.metadata.name).toBe(
      'Updated'
    );
  });

  it('unregisters a provider and returns true', () => {
    const registry = new ProviderRegistryV2Impl();
    registry.registerDeclarative(makeEntry(), '/test/provider.json');
    expect(registry.unregisterDeclarative('test-provider')).toBe(true);
    expect(registry.getDeclarativeEntry('test-provider')).toBeUndefined();
  });

  it('returns false when unregistering a non-existent provider', () => {
    const registry = new ProviderRegistryV2Impl();
    expect(registry.unregisterDeclarative('nonexistent')).toBe(false);
  });

  it('lists all registered providers', () => {
    const registry = new ProviderRegistryV2Impl();
    registry.registerDeclarative(
      makeEntry({ providerId: 'a' }),
      '/test/a.json'
    );
    registry.registerDeclarative(
      makeEntry({ providerId: 'b' }),
      '/test/b.json'
    );
    const list = registry.listDeclarativeEntries();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.providerId).sort()).toEqual(['a', 'b']);
  });

  it('finds provider by file path', () => {
    const registry = new ProviderRegistryV2Impl();
    registry.registerDeclarative(
      makeEntry({ providerId: 'foo' }),
      '/test/foo.json'
    );
    registry.registerDeclarative(
      makeEntry({ providerId: 'bar' }),
      '/test/bar.json'
    );
    expect(
      registry.getDeclarativeEntryByFile('/test/foo.json')!.providerId
    ).toBe('foo');
    expect(
      registry.getDeclarativeEntryByFile('/test/bar.json')!.providerId
    ).toBe('bar');
    expect(
      registry.getDeclarativeEntryByFile('/test/nonexistent.json')
    ).toBeUndefined();
  });

  it('handles empty registry', () => {
    const registry = new ProviderRegistryV2Impl();
    expect(registry.listDeclarativeEntries()).toEqual([]);
    expect(registry.getDeclarativeEntry('anything')).toBeUndefined();
    expect(registry.unregisterDeclarative('anything')).toBe(false);
  });

  it('cleans up fileIndex on unregister', () => {
    const registry = new ProviderRegistryV2Impl();
    registry.registerDeclarative(makeEntry(), '/test/p.json');
    registry.unregisterDeclarative('test-provider');
    expect(registry.getDeclarativeEntryByFile('/test/p.json')).toBeUndefined();
  });
});
