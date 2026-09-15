// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { parse as parseYaml } from 'yaml';
import { mockTauriCommand } from '../../test-setup';
import { modelsCatalogStore } from '../../api/modelsCatalogStore';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';
import { emptyAddDraft, useModelProfilesState } from './useModelProfilesState';

const HOOK_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'useModelProfilesState.ts'),
  'utf8'
);

const toastShow = vi.hoisted(() => vi.fn());
const profileMocks = vi.hoisted(() => {
  const OPENAI = {
    id: 'preset-openai',
    name: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o'],
  };
  const loadProfiles = vi.fn(() => [OPENAI]);
  const createCustomProfile = vi.fn((opts: { name: string; baseUrl?: string; protocol?: string }) => {
    const p = { id: 'custom-123', models: [], hasKey: false, ...opts };
    loadProfiles.mockReturnValue([OPENAI, p]);
    return p;
  });
  return {
    OPENAI,
    createCustomProfile,
    loadProfiles,
  };
});
vi.mock('../../services/toast/ToastContext', () => ({
  toast: { show: (...args: unknown[]) => toastShow(...args) },
}));

vi.mock('../../api/providerProfiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/providerProfiles')>();
  return {
    ...actual,
    addModelToProfile: vi.fn(),
    createCustomProfile: profileMocks.createCustomProfile,
    getActiveModelId: vi.fn(() => 'gpt-4o'),
    getActiveProfileId: vi.fn(() => 'preset-openai'),
    loadProfiles: profileMocks.loadProfiles,
    mergeModelIds: vi.fn((a: unknown, b: unknown) => [
      ...(a as unknown[]),
      ...(b as unknown[]),
    ]),
    normalizeModelIds: vi.fn((m: unknown) => m),
    profileHasKey: vi.fn(() => true),
    removeProfile: vi.fn(() => []),
    saveProfileBaseUrl: vi.fn(async () => ({ ok: true })),
    saveProfileKey: vi.fn(async () => ({ ok: true })),
    setProfileEnabled: vi.fn(),
    upsertProfile: vi.fn(),
  };
});

vi.mock('../../api/modelCatalog', () => ({
  getModelMeta: vi.fn(() => ({ displayName: 'GPT-4o', contextLength: 128000, capabilities: { tools: true } })),
  MODEL_CAPABILITY_OPTIONS: [
    { key: 'tools', label: '工具调用' },
    { key: 'image', label: '图片' },
    { key: 'video', label: '视频' },
    { key: 'reasoning', label: '思考' },
  ],
  scanProviderModels: vi.fn(async () => ({ ok: true, models: ['gpt-4o-mini'] })),
  testProviderModel: vi.fn(async () => ({ ok: true, latencyMs: 120 })),
  // 旧岛 setter 仅作 no-op 防当前过渡期 throw；禁止当作保存成功断言
  setModelCapability: vi.fn(),
  setModelContextLength: vi.fn(),
  setModelDisplayName: vi.fn(),
  setModelMaxOutputTokens: vi.fn(),
  setModelThinkingLevel: vi.fn(),
  setModelProtocol: vi.fn(),
  setModelModalities: vi.fn(),
  setModelThinking: vi.fn(),
  setModelPricing: vi.fn(),
  setModelEnabled: vi.fn(),
}));

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

const CATALOG_PROVIDERS: Record<string, ProviderSpec> = {
  'preset-openai': {
    displayName: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai/chat',
    models: [
      {
        id: 'gpt-4o',
        displayName: 'GPT-4o',
        contextWindow: 128000,
        supportsTools: true,
        thinking: { Low: 'low' },
        modalities: { input: ['text'], output: ['text'] },
      },
    ],
  },
  'opencode-go': {
    displayName: 'OpenCode Go 订阅',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    protocol: 'openai/chat',
    models: [{ id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' }],
  },
  'preset-opencode-go': {
    displayName: 'OpenCode Go 订阅',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    protocol: 'openai/chat',
    models: [],
  },
  'opencode-zen': {
    displayName: 'OpenCode Zen 订阅',
    baseUrl: 'https://opencode.ai/zen/v1',
    protocol: 'openai/chat',
    models: [],
  },
};

function lastSavedYaml(saveImpl: ReturnType<typeof vi.fn>): string {
  const last = saveImpl.mock.calls[saveImpl.mock.calls.length - 1]?.[0] as
    | { tree?: unknown }
    | undefined;
  return JSON.stringify(last?.tree ?? null);
}

describe('useModelProfilesState', () => {
  let saveImpl: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    profileMocks.loadProfiles.mockReturnValue([profileMocks.OPENAI]);
    profileMocks.createCustomProfile.mockClear();
    sessionStorage.removeItem('crish_models_selected_profile_v1');
    modelsCatalogStore.resetForTesting();
    localStorage.setItem(
      'crish_models_ls_import_v1',
      JSON.stringify({ done: true, version: 1 })
    );
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: CATALOG_PATH,
      content: '',
      template: '',
      revision: 'revision-0',
      credentialStates: {},
      parseError: null,
      tree: { version: 2, activeModel: null, providers: structuredClone(CATALOG_PROVIDERS) },
    }));
    saveImpl = vi.fn((args: unknown) => {
      const { tree } = args as { tree: unknown };
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
    mockTauriCommand('workbench_apply_models_config', saveImpl);
    await modelsCatalogStore.ensureLoaded(true);
  });

  it('initializes with expected default values', () => {
    const { result } = renderHook(() => useModelProfilesState());

    expect(result.current.profiles.length).toBeGreaterThan(0);
    expect(result.current.selectedId).toBe('preset-openai');
    expect(result.current.selected?.name).toBe('OpenAI 兼容');
    expect(result.current.addDraft).toEqual(emptyAddDraft());
  });

  it('addCustomProvider 直接创建空白服务商并选中（无预置 URL）', async () => {
    profileMocks.createCustomProfile.mockClear();
    const { result } = renderHook(() => useModelProfilesState());

    await act(async () => {
      await result.current.addCustomProvider({});
      await Promise.resolve();
    });

    expect(profileMocks.createCustomProfile).toHaveBeenCalledTimes(1);
    const arg = profileMocks.createCustomProfile.mock.calls[0]?.[0] as {
      name?: string;
      baseUrl?: string;
    };
    expect(arg.name).toBe('自定义服务商');
    // 中立：不预填任何官方 URL
    expect(arg.baseUrl ?? '').not.toContain('openai.com');
    await waitFor(() => {
      expect(result.current.selectedId).toBe('custom-123');
    });
  });

  it('addCustomProvider 可带自定义名称与 Base URL', async () => {
    profileMocks.createCustomProfile.mockClear();
    const { result } = renderHook(() => useModelProfilesState());

    await act(async () => {
      await result.current.addCustomProvider({
        name: '公司网关',
        baseUrl: 'https://gw.example.com/v1',
        protocol: 'anthropic/messages',
      });
      await Promise.resolve();
    });

    expect(profileMocks.createCustomProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '公司网关',
        baseUrl: 'https://gw.example.com/v1',
        protocol: 'anthropic/messages',
      })
    );
  });

  // 说明（2026-09-15 单轨收敛）：旧实现按展示名折叠并「把被折叠的拷贝改绑胜者」，
  // 存在的唯一理由是旧 localStorage 档案轨会出现同名重复条目。统一树以
  // `providerId` 为键，**同展示名可共存且互不干扰**，折叠已无必要（`foldSettingsProfiles`
  // / `resolveSettingsSelectedId` 已物理删除）。下列两条断言改钉新不变量。
  it('同展示名的两个 provider 共存：不折叠、不丢行（树以 providerId 为键）', () => {
    const { result } = renderHook(() => useModelProfilesState());

    expect(result.current.profiles.map((p) => p.id)).toEqual([
      'preset-openai',
      'opencode-go',
      'preset-opencode-go',
      'opencode-zen',
    ]);
    expect(
      result.current.profiles.filter((p) => p.name === 'OpenCode Go 订阅')
    ).toHaveLength(2);
    expect(result.current.selectedId).toBe('preset-openai');
  });

  it('sessionStorage 指向树里不存在的 id → 丢弃并回落首行，不按展示名改绑', () => {
    sessionStorage.setItem(
      'crish_models_selected_profile_v1',
      'preset-opencode-go-ghost'
    );
    const { result } = renderHook(() => useModelProfilesState());

    expect(result.current.selectedId).toBe('preset-openai');
    expect(result.current.selected?.id).toBe('preset-openai');
    sessionStorage.removeItem('crish_models_selected_profile_v1');
  });

  it('allows filtering models', () => {
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.setModelFilter('gpt');
    });

    expect(result.current.modelsList).toContain('gpt-4o');
  });

  it('notify 丢掉成功（已自动获取），失败才 toast 且带 error 皮', () => {
    toastShow.mockClear();
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.notify(true, '已自动获取 7 个模型');
    });
    expect(toastShow).not.toHaveBeenCalled();

    act(() => {
      result.current.notify(false, '保存失败：x');
    });
    expect(toastShow).toHaveBeenCalledWith('保存失败：x', undefined, {
      type: 'error',
    });
  });

  it('手填新模型再保存改价：yaml 先有该 id，再有新 pricing.cacheRead', async () => {
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.setAddDraft({
        modelId: 'new-flash',
        displayName: 'New Flash',
        contextLength: '64000',
        caps: { tools: true, image: false, video: false, reasoning: false },
      });
    });

    saveImpl.mockClear();
    await act(async () => {
      result.current.handleManualAdd();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastSavedYaml(saveImpl)).toContain('new-flash');
    });

    await waitFor(() => {
      expect(result.current.configOpenId).toBe('new-flash');
    });

    act(() => {
      result.current.setCfgDraft({
        displayName: 'New Flash',
        contextLength: '64000',
        caps: { tools: true, image: false, video: false, reasoning: false },
        pricing: {
          currency: 'CNY',
          input: '1.1',
          output: '2.2',
          cacheRead: '0.07',
          cacheWrite: '0.3',
        },
      });
    });

    await act(async () => {
      const ret = result.current.saveConfig();
      await Promise.resolve(ret);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastSavedYaml(saveImpl)).toContain('"cacheRead":');
    });

    const doc = parseYaml(lastSavedYaml(saveImpl)) as {
      providers?: Record<string, { models?: Array<Record<string, unknown>> }>;
    };
    const node = doc.providers?.['preset-openai']?.models?.find(
      (m) => m.id === 'new-flash'
    );
    expect(node).toBeTruthy();
    expect((node?.pricing as { cacheRead?: number })?.cacheRead).toBe(0.07);
    expect((node?.pricing as { input?: number })?.input).toBe(1.1);
  });

  it('modelsList 读 live 树，不读凭据壳 models[] 幽灵 id', () => {
    const prevModels = profileMocks.OPENAI.models;
    profileMocks.OPENAI.models = ['gpt-4o', 'ghost-from-ls'];
    try {
      const { result } = renderHook(() => useModelProfilesState());
      expect(result.current.modelsList).toEqual(['gpt-4o']);
      expect(result.current.modelsList).not.toContain('ghost-from-ls');
    } finally {
      profileMocks.OPENAI.models = prevModels;
    }
  });

  it('停用模型仍留在设置列表（开关可再启用），过滤读 live displayName', async () => {
    await modelsCatalogStore.updateModel('preset-openai', 'gpt-4o', {
      enabled: false,
      displayName: '旗舰四代',
    });
    const { result } = renderHook(() => useModelProfilesState());
    expect(result.current.modelsList).toContain('gpt-4o');

    act(() => {
      result.current.setModelFilter('旗舰');
    });
    expect(result.current.modelsList).toContain('gpt-4o');

    act(() => {
      result.current.setModelFilter('metaonly-should-miss');
    });
    expect(result.current.modelsList).toEqual([]);
  });

  it('扫描差集：新 id 追加在末尾；已有节点 thinking 不被空草稿覆盖', async () => {
    const { result } = renderHook(() => useModelProfilesState());

    saveImpl.mockClear();
    await act(async () => {
      result.current.confirmScannedModels(['gpt-4o', 'gpt-4o-mini']);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastSavedYaml(saveImpl)).toContain('gpt-4o-mini');
    });

    const doc = parseYaml(lastSavedYaml(saveImpl)) as {
      providers?: Record<string, { models?: Array<Record<string, unknown>> }>;
    };
    const models = doc.providers?.['preset-openai']?.models ?? [];
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(models[0]?.thinking).toEqual({ Low: 'low' });
    expect(models[0]?.modalities).toEqual({
      input: ['text'],
      output: ['text'],
    });
  });

  it('读侧源码：列表/过滤走 selectModel，不把 getModelMeta 当配置', () => {
    expect(HOOK_SRC).toMatch(/\buseModelsCatalogVersion\b/);
    expect(HOOK_SRC).toMatch(/\bgetLiveProvider\b/);
    expect(HOOK_SRC).toMatch(/\bgetLiveModel\b/);
    expect(HOOK_SRC).not.toMatch(/\bgetModelMeta\s*\(/);
    expect(HOOK_SRC).not.toMatch(/\buseModelMetaTick\b/);
  });
});
