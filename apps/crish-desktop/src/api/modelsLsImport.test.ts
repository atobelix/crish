/**
 * modelsLsImport.test.ts —— 一次性 LS→yaml 导入
 *
 * 内存 localStorage 夹具 + mock workbench_read/save。
 * 禁止断言 setter spy；验收看 serialize / 写盘文本。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../test-setup';
import {
  ensureLsImported,
  LS_IMPORT_FLAG_KEY,
  resetLsImportForTesting,
} from './modelsLsImport';
import { modelsCatalogStore, resetModelsCatalogMirror, selectModel } from './modelsCatalogStore';
import { serializeModelsYamlTree } from './modelsCatalogIpc';
import { DEFAULT_PRICES } from './pricingTypes';
import * as profilePersistence from './provider-profiles/profileStorePersistence';
import type { ProviderSpec } from './modelsCatalogTypes';

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';
const PROFILES_KEY = 'crish_provider_profiles_v1';
const META_KEY = 'crish_model_meta_v1';
const PRICES_KEY = 'crish_model_prices_v1';
const SECRET = 'sk-plain-secret-must-not-appear';

function workbenchReadOk(providers: Record<string, ProviderSpec>) {
  return {
    path: CATALOG_PATH,
    content: '',
    template: '',
    seeded: false,
    parseError: null,
    providers,
  };
}

function mockReadOk(providers: Record<string, ProviderSpec>): void {
  mockTauriCommand('workbench_read_models_yaml', () => workbenchReadOk(providers));
}

function mockSaveOk(): ReturnType<typeof vi.fn> {
  const impl = vi.fn((_args: unknown) => ({ path: CATALOG_PATH }));
  mockTauriCommand('workbench_save_models_yaml', impl);
  return impl;
}

function savedYaml(saveImpl: ReturnType<typeof vi.fn>): string {
  const args = saveImpl.mock.calls[0]?.[0] as { content?: string } | undefined;
  return args?.content ?? '';
}

function flagRaw(): string | null {
  return localStorage.getItem(LS_IMPORT_FLAG_KEY);
}

function seedFullLs(): void {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify([
      {
        id: 'gemini',
        name: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        protocol: 'google/interactions',
        models: ['gemini-2.5-pro'],
        hasKey: true,
        apiKey: SECRET,
      },
    ])
  );
  localStorage.setItem(
    META_KEY,
    JSON.stringify({
      'gemini::gemini-2.5-pro': {
        profileId: 'gemini',
        model: 'gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        enabled: true,
        contextLength: 64000,
        thinking: { Low: 'low', High: 'high' },
        modalities: { input: ['text', 'image'], output: ['text'] },
        pricing: { currency: 'USD', input: 1.5, output: 3, cacheRead: 0.15 },
        defaultThinkingLevel: 'High',
      },
    })
  );
  localStorage.setItem(
    PRICES_KEY,
    JSON.stringify([
      {
        model: 'gemini-2.5-pro',
        inputPerMTok: 9,
        outputPerMTok: 3,
        cacheReadPerMTok: 0.15,
      },
    ])
  );
}

describe('ensureLsImported（一次性 LS→yaml）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetModelsCatalogMirror();
    resetLsImportForTesting();
  });

  it('空 yaml + 实有 LS → serialize/写盘文本含 thinking、modalities、pricing.input、protocol、contextWindow', async () => {
    seedFullLs();
    mockReadOk({});
    const saveImpl = mockSaveOk();

    const res = await ensureLsImported();
    expect(res).toEqual({ ok: true });

    const model = selectModel('gemini', 'gemini-2.5-pro');
    expect(model?.thinking).toEqual({ Low: 'low', High: 'high' });
    expect(model?.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
    expect(model?.pricing?.input).toBe(1.5);
    expect(model?.contextWindow).toBe(64000);

    const text = savedYaml(saveImpl);
    const serialized = serializeModelsYamlTree(modelsCatalogStore.getState().tree);
    for (const sample of [text, serialized]) {
      expect(sample).toContain('thinking:');
      expect(sample).toContain('modalities:');
      expect(sample).toContain('pricing:');
      expect(sample).toMatch(/pricing:[\s\S]*input:\s*1\.5/);
      expect(sample).toContain('protocol: google/generate-content');
      expect(sample).toContain('contextWindow: 64000');
      expect(sample).not.toContain(SECRET);
      expect(sample).not.toContain('defaultThinkingLevel');
      expect(sample).not.toContain('apiKey:');
    }

    expect(JSON.parse(flagRaw() || '{}')).toEqual({ done: true, version: 1 });
    expect(localStorage.getItem(PROFILES_KEY)).toContain(SECRET);
  });

  it('yaml 已有同 id 且带 thinking → LS 不同 thinking 不得覆盖', async () => {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify([
        {
          id: 'acme',
          name: 'Acme LS',
          baseUrl: 'https://ls.example.invalid/v1',
          protocol: 'openai/responses',
          models: ['acme-think'],
        },
      ])
    );
    localStorage.setItem(
      META_KEY,
      JSON.stringify({
        'acme::acme-think': {
          thinking: { High: 'ls-high' },
          defaultThinkingLevel: 'High',
          contextLength: 32000,
        },
      })
    );
    mockReadOk({
      acme: {
        displayName: 'Acme Yaml',
        baseUrl: 'https://yaml.example.invalid/v1',
        protocol: 'openai/chat',
        models: [
          {
            id: 'acme-think',
            thinking: { Low: 'yaml-low' },
          },
        ],
      },
    });
    const saveImpl = mockSaveOk();

    const res = await ensureLsImported();
    expect(res.ok).toBe(true);

    const model = selectModel('acme', 'acme-think');
    expect(model?.thinking).toEqual({ Low: 'yaml-low' });
    expect(model?.thinking).not.toHaveProperty('High');
    expect(model?.contextWindow).toBe(32000);

    const text = savedYaml(saveImpl);
    expect(text).toContain('yaml-low');
    expect(text).not.toContain('ls-high');
    expect(text).toContain('protocol: openai/chat');
    expect(text).toContain('Acme Yaml');
  });

  it('缺 LS 键 → 不把 DEFAULT_PRICES / 128000 写入', async () => {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify([
        {
          id: 'deepseek',
          name: 'DeepSeek 官方',
          baseUrl: 'https://api.deepseek.com',
          models: ['deepseek-v4-flash'],
          hasKey: false,
        },
      ])
    );
    mockReadOk({});
    const saveImpl = mockSaveOk();

    const res = await ensureLsImported();
    expect(res.ok).toBe(true);

    const text = savedYaml(saveImpl);
    const serialized = serializeModelsYamlTree(modelsCatalogStore.getState().tree);
    for (const sample of [text, serialized]) {
      expect(sample).toContain('deepseek-v4-flash');
      expect(sample).not.toMatch(/\b128000\b/);
      expect(sample).not.toContain('contextWindow:');
      expect(sample).not.toContain('pricing:');
      for (const price of DEFAULT_PRICES) {
        if (price.model === 'deepseek-v4-flash') {
          expect(sample).not.toContain(`input: ${price.inputPerMTok}`);
          expect(sample).not.toContain(`output: ${price.outputPerMTok}`);
        } else {
          expect(sample).not.toContain(price.model);
        }
      }
    }

    localStorage.clear();
    resetModelsCatalogMirror();
    resetLsImportForTesting();
    mockReadOk({});
    const saveEmpty = mockSaveOk();
    const emptyRes = await ensureLsImported();
    expect(emptyRes.ok).toBe(true);
    expect(saveEmpty).not.toHaveBeenCalled();
    const emptyText = serializeModelsYamlTree(modelsCatalogStore.getState().tree);
    expect(emptyText).not.toMatch(/\b128000\b/);
    for (const price of DEFAULT_PRICES) {
      expect(emptyText).not.toContain(price.model);
    }
  });

  it('完成标记已在 → 第二次零读配置键', async () => {
    seedFullLs();
    localStorage.setItem(LS_IMPORT_FLAG_KEY, JSON.stringify({ done: true, version: 1 }));
    mockReadOk({});
    const saveImpl = mockSaveOk();
    const getItemSpy = vi.spyOn(localStorage, 'getItem');

    const res = await ensureLsImported();
    expect(res).toEqual({ ok: true });
    expect(saveImpl).not.toHaveBeenCalled();

    const readKeys = getItemSpy.mock.calls.map((call) => call[0]);
    expect(readKeys).toContain(LS_IMPORT_FLAG_KEY);
    expect(readKeys).not.toContain(PROFILES_KEY);
    expect(readKeys).not.toContain(META_KEY);
    expect(readKeys).not.toContain(PRICES_KEY);
  });

  it('坏 JSON → 不写完成标记、不 saveProfiles', async () => {
    localStorage.setItem(PROFILES_KEY, '{ not-json');
    localStorage.setItem(META_KEY, JSON.stringify({}));
    localStorage.setItem(
      PRICES_KEY,
      JSON.stringify([{ model: 'gpt-5.6', inputPerMTok: 5, outputPerMTok: 30 }])
    );
    mockReadOk({});
    const saveImpl = mockSaveOk();
    const saveProfilesSpy = vi.spyOn(profilePersistence, 'saveProfiles');

    const res = await ensureLsImported();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/JSON 损坏/);
    expect(flagRaw()).toBeNull();
    expect(saveProfilesSpy).not.toHaveBeenCalled();
    expect(saveImpl).not.toHaveBeenCalled();
    expect(localStorage.getItem(PROFILES_KEY)).toBe('{ not-json');
    expect(modelsCatalogStore.getState().tree.providers).toEqual({});
  });

  it('yaml parseError → 整次放弃，不写完成标记', async () => {
    seedFullLs();
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: CATALOG_PATH,
      content: 'broken: [',
      template: '',
      seeded: false,
      parseError: { line: 4, column: 1, message: 'bad indentation' },
    }));
    const saveImpl = mockSaveOk();

    const res = await ensureLsImported();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/第 4 行/);
    expect(flagRaw()).toBeNull();
    expect(saveImpl).not.toHaveBeenCalled();
  });

  it('单飞：并发只走一次 updateTree / save', async () => {
    seedFullLs();
    mockReadOk({});
    const saveImpl = mockSaveOk();

    const a = ensureLsImported();
    const b = ensureLsImported();
    expect(a).toBe(b);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ ok: true });
    expect(rb).toEqual({ ok: true });
    expect(saveImpl).toHaveBeenCalledTimes(1);
  });
});
