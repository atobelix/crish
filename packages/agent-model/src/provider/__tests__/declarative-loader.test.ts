import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import {
  ProviderRegistryV2Impl,
  type ProviderRegistryV2,
} from '../registry-v2';
import { DeclarativeLoader } from '../loader';
import {
  normalizeDeclarativeDef,
  validateProviderId,
} from '../declarative-schema';

import openaiFixture from './fixtures/declarative-openai.json';
import claudeFixture from './fixtures/declarative-claude.json';
import minimalFixture from './fixtures/declarative-minimal.json';
import sparseFixture from './fixtures/declarative-sparse.json';
import tempFixture from './fixtures/declarative-temp.json';

const mockFiles = new Map<string, string>();
const mockDirFiles: Record<string, string[]> = {};
const mockExists: Record<string, boolean> = {};
let mockWatchCallback: ((eventType: string, filename: string) => void) | null =
  null;

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: string) => mockExists[p] ?? false),
  readdirSync: vi.fn((p: string) => mockDirFiles[p] ?? []),
  readFileSync: vi.fn((p: string, _encoding?: string) => {
    if (!mockFiles.has(p)) throw new Error(`ENOENT: ${p}`);
    return mockFiles.get(p)!;
  }),
  watch: vi.fn(
    (_dir: string, listener: (eventType: string, filename: string) => void) => {
      mockWatchCallback = listener;
      return { close: vi.fn() };
    }
  ),
}));

function p(...segments: string[]): string {
  return path.join(...segments);
}

function setup(
  dir: string,
  dirFiles: string[],
  dirExists: boolean,
  entries: Record<string, string>
) {
  mockFiles.clear();
  for (const [filePath, content] of Object.entries(entries)) {
    mockFiles.set(filePath, content);
  }
  mockDirFiles[dir] = dirFiles;
  mockExists[dir] = dirExists;
}

describe('DeclarativeLoader', () => {
  let registry: ProviderRegistryV2;
  let loader: DeclarativeLoader;

  beforeEach(() => {
    registry = new ProviderRegistryV2Impl();
    mockFiles.clear();
    mockWatchCallback = null;
  });

  afterEach(() => {
    loader?.stop();
  });

  it('loads all JSON files from directory', () => {
    const dir = p('/', 'providers');
    setup(dir, ['openai.json', 'claude.json'], true, {
      [p(dir, 'openai.json')]: JSON.stringify(openaiFixture),
      [p(dir, 'claude.json')]: JSON.stringify(claudeFixture),
    });

    loader = new DeclarativeLoader(registry, dir);
    loader.start();
    expect(registry.getDeclarativeEntry('openai')).toBeDefined();
    expect(registry.getDeclarativeEntry('claude')).toBeDefined();
  });

  it('handles empty directory', () => {
    const dir = p('/', 'empty');
    setup(dir, [], true, {});
    loader = new DeclarativeLoader(registry, dir);
    loader.start();
    expect(registry.listDeclarativeEntries()).toEqual([]);
  });

  it('handles invalid JSON gracefully', () => {
    const dir = p('/', 'providers');
    setup(dir, ['bad.json'], true, {
      [p(dir, 'bad.json')]: '{invalid json}',
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    loader = new DeclarativeLoader(registry, dir);
    loader.start();
    expect(registry.listDeclarativeEntries()).toEqual([]);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles missing directory gracefully', () => {
    const dir = p('/', 'nonexistent');
    setup(dir, [], false, {});
    loader = new DeclarativeLoader(registry, dir);
    expect(() => loader.start()).not.toThrow();
    expect(registry.listDeclarativeEntries()).toEqual([]);
  });

  it('registers provider with normalized defaults', () => {
    const dir = p('/', 'providers');
    setup(dir, ['minimal.json'], true, {
      [p(dir, 'minimal.json')]: JSON.stringify(minimalFixture),
    });
    loader = new DeclarativeLoader(registry, dir);
    loader.start();
    const entry = registry.getDeclarativeEntry('minimal');
    expect(entry).toBeDefined();
    expect(entry!.engine).toBe('openai-compatible');
    expect(entry!.declarative.baseUrl).toBe('https://api.example.com');
    expect(entry!.declarative.auth.type).toBe('api-key');
    expect(entry!.declarative.auth.placement).toBe('header');
    expect(entry!.declarative.auth.defaultEnvVar).toBe('MINIMAL_API_KEY');
    expect(entry!.declarative.models).toHaveLength(1);
    expect(entry!.declarative.models[0]!.contextWindow).toBe(4096);
    expect(entry!.declarative.paths.chatCompletions).toBe(
      '/v1/chat/completions'
    );
    expect(entry!.declarative.capabilities.streaming).toBe(true);
    expect(entry!.declarative.engineOptions.anthropicVersion).toBe(
      '2023-06-01'
    );
  });

  it('handles JSON with missing optional fields via normalization', () => {
    const dir = p('/', 'providers');
    setup(dir, ['sparse.json'], true, {
      [p(dir, 'sparse.json')]: JSON.stringify(sparseFixture),
    });
    loader = new DeclarativeLoader(registry, dir);
    loader.start();
    const entry = registry.getDeclarativeEntry('sparse');
    expect(entry).toBeDefined();
    expect(entry!.engine).toBe('ollama');
    expect(entry!.declarative.rateLimiting.requestsPerMinute).toBe(0);
    expect(entry!.declarative.metadata).toEqual({});
  });

  describe('validateProviderId', () => {
    it('accepts valid provider IDs', () => {
      expect(() => validateProviderId('openai')).not.toThrow();
      expect(() => validateProviderId('anthropic-messages')).not.toThrow();
      expect(() => validateProviderId('my_provider_01')).not.toThrow();
      expect(() => validateProviderId('A-B-C_123')).not.toThrow();
    });

    it('rejects providerId with spaces', () => {
      expect(() => validateProviderId('my provider')).toThrow(
        /only alphanumeric characters/i
      );
    });

    it('rejects providerId with special characters', () => {
      expect(() => validateProviderId('provider!@#')).toThrow(
        /only alphanumeric characters/i
      );
    });

    it('rejects providerId with dots', () => {
      expect(() => validateProviderId('my.provider')).toThrow(
        /only alphanumeric characters/i
      );
    });

    it('rejects empty providerId', () => {
      expect(() => validateProviderId('')).toThrow(
        /only alphanumeric characters/i
      );
    });
  });

  describe('normalizeDeclarativeDef validation', () => {
    it('throws for providerId with invalid characters', () => {
      expect(() =>
        normalizeDeclarativeDef({
          providerId: 'bad provider!',
          name: 'Bad',
          engine: 'openai-compatible',
          baseUrl: 'https://example.com',
          models: [{ id: 'm' }],
        })
      ).toThrow(/only alphanumeric characters/i);
    });

    it('throws when model.id exceeds 128 characters', () => {
      const longId = 'a'.repeat(129);
      expect(() =>
        normalizeDeclarativeDef({
          providerId: 'test',
          name: 'Test',
          engine: 'openai-compatible',
          baseUrl: 'https://example.com',
          models: [{ id: longId }],
        })
      ).toThrow(/exceeds maximum length/i);
    });

    it('accepts model.id at exactly 128 characters', () => {
      const longId = 'a'.repeat(128);
      expect(() =>
        normalizeDeclarativeDef({
          providerId: 'test',
          name: 'Test',
          engine: 'openai-compatible',
          baseUrl: 'https://example.com',
          models: [{ id: longId }],
        })
      ).not.toThrow();
    });

    it('warns on unknown fields', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      normalizeDeclarativeDef({
        providerId: 'test',
        name: 'Test',
        engine: 'openai-compatible',
        baseUrl: 'https://example.com',
        models: [{ id: 'm' }],
        unknownField: 'should warn',
        extraConfig: { foo: 1 },
      } as any);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unknownField')
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('extraConfig')
      );
      warnSpy.mockRestore();
    });

    it('does not warn on known fields', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      normalizeDeclarativeDef({
        providerId: 'test',
        name: 'Test',
        engine: 'openai-compatible',
        baseUrl: 'https://example.com',
        models: [{ id: 'm' }],
      });
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  it('unregisters provider when its JSON file is deleted (watcher rename)', () => {
    const dir = p('/', 'providers');
    setup(dir, ['temp.json'], true, {
      [p(dir, 'temp.json')]: JSON.stringify(tempFixture),
    });

    loader = new DeclarativeLoader(registry, dir);
    loader.start();
    expect(registry.getDeclarativeEntry('temp')).toBeDefined();

    if (mockWatchCallback) {
      delete mockExists[p(dir, 'temp.json')];
      mockWatchCallback('rename', 'temp.json');
    }
    expect(registry.getDeclarativeEntry('temp')).toBeUndefined();
  });
});
