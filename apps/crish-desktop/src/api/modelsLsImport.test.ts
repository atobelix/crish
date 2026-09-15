/**
 * modelsLsImport.test.ts —— 一次性 LS→yaml 导入
 *
 * 内存 localStorage 夹具 + mock workbench_read/apply（统一事务契约：完整规范树 + 修订号 + 凭据状态）。
 * 禁止断言 setter spy；写盘内容以提交给内核事务的规范树为准（序列化在内核）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../test-setup';
import {
  ensureLsImported,
  LS_IMPORT_FLAG_KEY,
  resetLsImportForTesting,
} from './modelsLsImport';
import { modelsCatalogStore, resetModelsCatalogMirror, selectModel } from './modelsCatalogStore';
import { DEFAULT_PROTOCOL } from './modelsNormalize';
import * as profilePersistence from './provider-profiles/profileStorePersistence';
import type {
  ModelsYamlTree,
  ProviderSpec,
} from './modelsCatalogTypes';

const READ = 'workbench_read_models_yaml';
const APPLY = 'workbench_apply_models_config';
const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';
const PROFILES_KEY = 'crish_provider_profiles_v1';
const META_KEY = 'crish_model_meta_v1';
const PRICES_KEY = 'crish_model_prices_v1';
const SECRET = 'sk-plain-secret-must-not-appear';

/**
 * 出厂字典（Rust catalog.json）模型 id 抽样：导入**不得**把字典价目写进 yaml。
 * 前端零本地副本（`pricingCatalogData*.ts` / `DEFAULT_PRICES` 已物理删除），
 * 故此处显式列举字典 id 作为「不得发明」断言集（取代旧 DEFAULT_PRICES 派生集）。
 */
const DICTIONARY_MODEL_IDS = [
  'gpt-5.6-sol',
  'claude-sonnet-4-5',
  'deepseek-v4-pro',
  'glm-5-2',
  'grok-4.5',
  'kimi-k3',
  'qwen3-8-max',
  'gemini-3-5-flash',
];

function readSnapshot(providers: Record<string, ProviderSpec>) {
  return {
    path: CATALOG_PATH,
    revision: 'revision-0',
    content: '',
    template: '',
    credentialStates: {},
    parseError: null,
    tree: { version: 2, activeModel: null, providers },
  };
}

function mockReadOk(providers: Record<string, ProviderSpec>): void {
  mockTauriCommand(READ, () => readSnapshot(providers));
}

function mockSaveOk(): ReturnType<typeof vi.fn> {
  const impl = vi.fn((args: unknown) => {
    const { tree } = args as { tree: ModelsYamlTree };
    return {
      path: CATALOG_PATH,
      revision: 'revision-1',
      content: '',
      template: '',
      credentialStates: {},
      parseError: null,
      tree,
    };
  });
  mockTauriCommand(APPLY, impl);
  return impl;
}

/** 提交给统一事务的候选树（内核据此落盘与序列化）。 */
function savedTree(saveImpl: ReturnType<typeof vi.fn>): ModelsYamlTree | null {
  const args = saveImpl.mock.calls[0]?.[0] as { tree?: ModelsYamlTree } | undefined;
  return args?.tree ?? null;
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

  it('空 yaml + 实有 LS → 提交树含 thinking、modalities、pricing.input、protocol、contextWindow', async () => {
    seedFullLs();
    mockReadOk({});
    const saveImpl = mockSaveOk();

    const res = await ensureLsImported();
    expect(res).toEqual({ ok: true });

    // 镜像（已提交回执）
    const model = selectModel('gemini', 'gemini-2.5-pro');
    expect(model?.thinking).toEqual({ Low: 'low', High: 'high' });
    expect(model?.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
    expect(model?.pricing?.input).toBe(1.5);
    expect(model?.contextWindow).toBe(64000);

    // 提交给内核事务的规范树（落盘依据）
    const tree = savedTree(saveImpl);
    expect(tree).not.toBeNull();
    const provider = tree!.providers.gemini!;
    expect(provider.protocol).toBe('google/generate-content');
    const imported = provider.models[0]!;
    expect(imported.thinking).toEqual({ Low: 'low', High: 'high' });
    expect(imported.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
    expect(imported.pricing?.input).toBe(1.5);
    expect(imported.contextWindow).toBe(64000);

    const payload = JSON.stringify(tree);
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain('defaultThinkingLevel');
    expect(payload).not.toContain('apiKey');

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

    // 镜像断言
    const model = selectModel('acme', 'acme-think');
    expect(model?.thinking).toEqual({ Low: 'yaml-low' });
    expect(model?.thinking).not.toHaveProperty('High');
    expect(model?.contextWindow).toBe(32000);

    // 提交树断言
    const tree = savedTree(saveImpl)!;
    const provider = tree.providers.acme!;
    expect(provider.displayName).toBe('Acme Yaml');
    expect(provider.protocol).toBe('openai/chat');
    const payload = JSON.stringify(tree);
    expect(payload).toContain('yaml-low');
    expect(payload).not.toContain('ls-high');
  });

  it('缺 LS 键 → 不把出厂字典价目 / 128000 写入', async () => {
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

    // 提交树：不发明窗口 / 价格，协议落 SSOT 默认值
    const tree = savedTree(saveImpl)!;
    expect(Object.keys(tree.providers)).toEqual(['deepseek']);
    const imported = tree.providers.deepseek!.models[0]!;
    expect(imported.id).toBe('deepseek-v4-flash');
    expect(tree.providers.deepseek!.protocol).toBe(DEFAULT_PROTOCOL);
    expect(imported.contextWindow).toBeUndefined();
    expect(imported.pricing).toBeUndefined();
    const payload = JSON.stringify(tree);
    expect(payload).not.toMatch(/\b128000\b/);
    // 字典价目模型不得经导入混入（结构断言：供应商集合精确）
    for (const model of DICTIONARY_MODEL_IDS) {
      if (model !== 'deepseek-v4-flash') {
        expect(payload).not.toContain(`"${model}"`);
      }
    }

    // 已提交镜像与提交树一致（回执安装）
    const mirrorTree = modelsCatalogStore.getState().tree;
    expect(Object.keys(mirrorTree.providers)).toEqual(['deepseek']);
    const mirrorModel = mirrorTree.providers.deepseek!.models[0]!;
    expect(mirrorModel.pricing).toBeUndefined();
    expect(mirrorModel.contextWindow).toBeUndefined();
    const mirror = JSON.stringify(mirrorTree);
    expect(mirror).not.toMatch(/\b128000\b/);
    for (const model of DICTIONARY_MODEL_IDS) {
      if (model !== 'deepseek-v4-flash') {
        expect(mirror).not.toContain(`"${model}"`);
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
    const emptyText = JSON.stringify(modelsCatalogStore.getState().tree);
    expect(emptyText).not.toMatch(/\b128000\b/);
    for (const model of DICTIONARY_MODEL_IDS) {
      expect(emptyText).not.toContain(`"${model}"`);
    }
  });

  it('完成标记已在 → 第二次零读配置键', async () => {
    // 第一次：真实导入写完成标记（随后验证短路行为）
    seedFullLs();
    mockReadOk({});
    const saveFirst = mockSaveOk();
    const first = await ensureLsImported();
    expect(first).toEqual({ ok: true });
    expect(flagRaw()).toBeTruthy();

    // 第二次：仅短路读 flag，不得再碰三把配置键 / save
    // jsdom 下 getItem 在 Storage.prototype，实例 spy 拦不到（见 modelCatalogMeta.test.ts 同款适配）
    const getItemSpy =
      typeof Storage !== 'undefined'
        ? vi.spyOn(Storage.prototype, 'getItem')
        : vi.spyOn(localStorage, 'getItem');
    const saveSecond = mockSaveOk();

    const res = await ensureLsImported();
    expect(res).toEqual({ ok: true });
    expect(saveFirst).toHaveBeenCalledTimes(1);
    expect(saveSecond).not.toHaveBeenCalled();

    const readKeys = getItemSpy.mock.calls.map((call) => String(call[0]));
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
    mockTauriCommand(READ, () => ({
      path: CATALOG_PATH,
      revision: 'revision-0',
      content: 'broken: [',
      template: '',
      credentialStates: {},
      parseError: { line: 4, column: 1, message: 'bad indentation' },
      tree: null,
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
