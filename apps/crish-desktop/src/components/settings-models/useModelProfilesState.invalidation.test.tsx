// @vitest-environment jsdom
/**
 * R2-a ④ / T2-7：设置页失效订阅。
 * 外部失效事件源从 profiles-changed 扩到 models-catalog-changed。
 * CT-01 与成功保存的完成句是 yaml 文本，不是 setter spy。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { parse as parseYaml } from 'yaml';
import { emitUiEvent } from '../../api/uiEvents';
import { mockTauriCommand } from '../../test-setup';
import { modelsCatalogStore } from '../../api/modelsCatalogStore';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';
import { useModelProfilesState } from './useModelProfilesState';
import type { ProviderProfile } from '../../api/providerProfiles';

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  commit: vi.fn(),
  invalidate: vi.fn(),
  isOpen: vi.fn(),
  loadProfiles: vi.fn(),
  getModelMeta: vi.fn(),
  toastShow: vi.fn(),
}));

vi.mock('../../services/toast/ToastContext', () => ({
  toast: {
    show: mocks.toastShow,
  },
}));

vi.mock('../../api/chat-bridge/editSessionConsumer', () => ({
  editSessionConsumer: {
    open: mocks.open,
    commit: mocks.commit,
    invalidate: mocks.invalidate,
    isOpen: mocks.isOpen,
  },
  invalidateEditObjects: vi.fn(),
  bindEditSession: vi.fn(),
  getBoundEditSession: vi.fn(() => null),
  isEditSessionConsumerBound: vi.fn(() => false),
}));

vi.mock('../../api/providerProfiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/providerProfiles')>();
  return {
    ...actual,
    addModelToProfile: vi.fn(),
    createCustomProfile: vi.fn((opts) => ({ id: 'custom-123', ...opts })),
    getActiveModelId: vi.fn(() => 'gpt-4o'),
    getActiveProfileId: vi.fn(() => 'preset-openai'),
    loadProfiles: mocks.loadProfiles,
    mergeModelIds: vi.fn((a: string[], b: string[]) => [...a, ...b]),
    normalizeModelIds: vi.fn((m: unknown) => m),
    profileHasKey: vi.fn(() => true),
    saveProfileKey: vi.fn(async () => ({ ok: true })),
    upsertProfile: vi.fn(),
  };
});

// 旧岛 getModelMeta 仅作打开草稿过渡；CT-01 / 保存成功不得靠它当完成句。
vi.mock('../../api/modelCatalog', () => ({
  getModelMeta: mocks.getModelMeta,
  MODEL_CAPABILITY_OPTIONS: [
    { key: 'tools', label: '工具调用' },
    { key: 'image', label: '图片' },
    { key: 'reasoning', label: '思考' },
  ],
  scanProviderModels: vi.fn(async () => ({
    ok: true,
    models: ['gpt-4o-mini'],
  })),
  testProviderModel: vi.fn(async () => ({ ok: true, latencyMs: 120 })),
}));

const PROFILE: ProviderProfile = {
  id: 'preset-openai',
  name: 'OpenAI 兼容',
  baseUrl: 'https://api.openai.com/v1',
  models: ['gpt-4o'],
  hasKey: true,
};

const PROFILE_UPDATED: ProviderProfile = {
  ...PROFILE,
  models: ['gpt-4o', 'gpt-4o-mini'],
};

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
        maxOutputTokens: 16384,
        enabled: true,
        capabilities: { tools: true },
        thinking: { Low: 'low', High: 'high' },
        modalities: { input: ['text'], output: ['text'] },
        pricing: {
          currency: 'USD',
          input: 2.5,
          output: 10,
          cacheRead: 0.25,
          cacheWrite: 0.5,
        },
      },
    ],
  },
};

function lastSavedYaml(saveImpl: ReturnType<typeof vi.fn>): string {
  const last = saveImpl.mock.calls[saveImpl.mock.calls.length - 1]?.[0] as
    | { content?: string }
    | undefined;
  return last?.content ?? '';
}

function parseGpt4o(content: string): Record<string, unknown> | undefined {
  const doc = parseYaml(content) as {
    providers?: Record<
      string,
      { models?: Array<Record<string, unknown>> }
    >;
  };
  return doc.providers?.['preset-openai']?.models?.find((m) => m.id === 'gpt-4o');
}

async function awaitSave(fn: () => unknown): Promise<void> {
  await act(async () => {
    const ret = fn();
    await Promise.resolve(ret);
    await Promise.resolve();
    await Promise.resolve();
  });
}

let currentProfiles: ProviderProfile[];
let saveImpl: ReturnType<typeof vi.fn>;

describe('useModelProfilesState 失效订阅（R2-a ④ / T2-7）', () => {
  beforeEach(async () => {
    currentProfiles = [PROFILE];
    mocks.loadProfiles.mockImplementation(() => currentProfiles);
    mocks.getModelMeta.mockImplementation(() => ({
      profileId: 'preset-openai',
      model: 'gpt-4o',
      displayName: 'GPT-4o',
      enabled: true,
      contextLength: 128000,
      capabilities: { tools: true },
    }));
    mocks.open.mockClear();
    mocks.commit.mockClear();
    mocks.invalidate.mockClear();
    mocks.isOpen.mockClear();
    mocks.toastShow.mockClear();

    modelsCatalogStore.resetForTesting();
    localStorage.setItem(
      'crish_models_ls_import_v1',
      JSON.stringify({ done: true, version: 1 })
    );
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: CATALOG_PATH,
      content: '',
      template: '',
      seeded: false,
      parseError: null,
      providers: structuredClone(CATALOG_PROVIDERS),
    }));
    saveImpl = vi.fn((_args: unknown) => ({ path: CATALOG_PATH }));
    mockTauriCommand('workbench_save_models_yaml', saveImpl);
    await modelsCatalogStore.ensureLoaded(true);
  });

  afterEach(() => {
    modelsCatalogStore.resetForTesting();
  });

  it('外部 profiles 变更且无未保存草稿 → 直接 refresh 重载（不提示）', () => {
    const { result } = renderHook(() => useModelProfilesState());

    expect(result.current.profiles.map((p) => p.id)).toEqual(['preset-openai']);

    currentProfiles = [PROFILE_UPDATED];
    act(() => {
      emitUiEvent('profiles-changed');
    });

    expect(result.current.profiles[0]?.models).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);
    expect(mocks.toastShow).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('外部 profiles-changed 且有未保存 cfgDraft → 提示 + invalidate，不静默覆盖', () => {
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.openConfigFor('gpt-4o');
    });
    expect(result.current.cfgDraft).not.toBeNull();
    expect(mocks.open).toHaveBeenCalledWith('preset-openai::gpt-4o');

    currentProfiles = [PROFILE_UPDATED];
    act(() => {
      emitUiEvent('profiles-changed');
    });

    expect(mocks.toastShow).toHaveBeenCalledWith(
      '配置已被外部修改，请确认后重载或丢弃草稿',
      undefined,
      { type: 'error' }
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      'preset-openai::gpt-4o',
      'external'
    );
    expect(result.current.cfgDraft).not.toBeNull();
  });

  it('外部 models-catalog-changed 且有未保存 cfgDraft → 提示 + invalidate（事件源扩到目录变更）', () => {
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.openConfigFor('gpt-4o');
    });
    expect(result.current.cfgDraft).not.toBeNull();

    act(() => {
      emitUiEvent('models-catalog-changed');
    });

    expect(mocks.toastShow).toHaveBeenCalledWith(
      '配置已被外部修改，请确认后重载或丢弃草稿',
      undefined,
      { type: 'error' }
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      'preset-openai::gpt-4o',
      'external'
    );
    expect(result.current.cfgDraft).not.toBeNull();
  });

  it('外部 models-catalog-changed 且无未保存草稿 → 不提示、不 invalidate', () => {
    const { result } = renderHook(() => useModelProfilesState());
    expect(result.current.cfgDraft).toBeNull();

    act(() => {
      emitUiEvent('models-catalog-changed');
    });

    expect(mocks.toastShow).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('saveConfig CT-01：外部 yaml/store 已变更 rev 不符 → 拒绝陈旧覆盖，不写草稿进 yaml', async () => {
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.openConfigFor('gpt-4o');
      result.current.setCfgDraft({
        displayName: 'GPT-4o 陈旧草稿',
        contextLength: '130000',
        caps: { tools: true, image: false, video: false, reasoning: true },
        thinkingEnabled: true,
        thinkingMap: { Low: 'low', CustomUltra: 'stale_wire' },
        modalities: { input: ['text', 'image'], output: ['text'] },
        pricing: {
          currency: 'CNY',
          input: '0.99',
          output: '2.8',
          cacheRead: '0.08',
          cacheWrite: '0.2',
        },
      });
    });

    saveImpl.mockClear();
    await act(async () => {
      await modelsCatalogStore.updateModel('preset-openai', 'gpt-4o', {
        contextWindow: 200000,
        displayName: 'GPT-4o（外部改）',
      });
    });
    const callsAfterExternal = saveImpl.mock.calls.length;
    expect(parseGpt4o(lastSavedYaml(saveImpl))?.displayName).toBe(
      'GPT-4o（外部改）'
    );

    await awaitSave(() => result.current.saveConfig());

    expect(mocks.toastShow).toHaveBeenCalledWith(
      '配置已被外部修改，保存已取消，请重新确认',
      undefined,
      { type: 'error' }
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      'preset-openai::gpt-4o',
      'external'
    );
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(result.current.cfgDraft).not.toBeNull();
    expect(saveImpl.mock.calls.length).toBe(callsAfterExternal);
    expect(lastSavedYaml(saveImpl)).not.toContain('GPT-4o 陈旧草稿');
    expect(lastSavedYaml(saveImpl)).not.toContain('stale_wire');
  });

  it('saveConfig rev 一致 → yaml 含 thinking/modalities/cacheRead 并 commit', async () => {
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.openConfigFor('gpt-4o');
      result.current.setCfgDraft({
        displayName: 'GPT-4o 正常改',
        contextLength: '200000',
        maxOutputTokens: '16384',
        caps: { tools: true, image: true, video: false, reasoning: true },
        thinkingEnabled: true,
        thinkingMap: { Low: 'low', CustomUltra: 'ultra_wire' },
        modalities: { input: ['text', 'image'], output: ['text'] },
        pricing: {
          currency: 'CNY',
          input: '0.99',
          output: '2.8',
          cacheRead: '0.08',
          cacheWrite: '0.2',
        },
      });
    });

    saveImpl.mockClear();
    await awaitSave(() => result.current.saveConfig());

    await waitFor(() => {
      expect(lastSavedYaml(saveImpl)).toContain('ultra_wire');
    });

    const content = lastSavedYaml(saveImpl);
    expect(content).toContain('thinking:');
    expect(content).toContain('modalities:');
    expect(content).toContain('cacheRead:');
    expect(content).not.toContain('inputPerMTok');
    expect(content).not.toContain('contextLength:');
    expect(content).not.toContain('defaultThinkingLevel');

    const node = parseGpt4o(content);
    expect(node?.displayName).toBe('GPT-4o 正常改');
    expect(node?.thinking).toEqual({ Low: 'low', CustomUltra: 'ultra_wire' });
    expect(node?.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    });
    expect((node?.pricing as { cacheRead?: number })?.cacheRead).toBe(0.08);
    expect(node?.contextWindow).toBe(200000);

    expect(mocks.commit).toHaveBeenCalledWith('preset-openai::gpt-4o');
    expect(mocks.toastShow).not.toHaveBeenCalled();
  });

  it('closeConfig → 编辑会话 external 失效 + 草稿清空', () => {
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.openConfigFor('gpt-4o');
    });
    act(() => {
      result.current.closeConfig();
    });

    expect(mocks.invalidate).toHaveBeenCalledWith(
      'preset-openai::gpt-4o',
      'external'
    );
    expect(result.current.cfgDraft).toBeNull();
    expect(result.current.configOpenId).toBeNull();
  });
});
