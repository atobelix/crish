// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { emptyAddDraft, PRESETS, useModelProfilesState } from './useModelProfilesState';

const toastShow = vi.hoisted(() => vi.fn());
const profileMocks = vi.hoisted(() => {
  const OPENAI = {
    id: 'preset-openai',
    name: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o'],
  };
  const loadProfiles = vi.fn(() => [OPENAI]);
  return {
    OPENAI,
    createCustomProfile: vi.fn((opts: { name: string }) => ({
      id: 'custom-123',
      ...opts,
    })),
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
    { key: 'vision', label: '视觉' },
    { key: 'reasoning', label: '思考' },
  ],
  scanProviderModels: vi.fn(async () => ({ ok: true, models: ['gpt-4o-mini'] })),
  setModelCapability: vi.fn(),
  setModelContextLength: vi.fn(),
  setModelDisplayName: vi.fn(),
  testProviderModel: vi.fn(async () => ({ ok: true, latencyMs: 120 })),
}));

describe('useModelProfilesState', () => {
  beforeEach(() => {
    profileMocks.loadProfiles.mockReturnValue([profileMocks.OPENAI]);
    profileMocks.createCustomProfile.mockClear();
    sessionStorage.removeItem('crish_models_selected_profile_v1');
  });

  it('initializes with expected default values', () => {
    const { result } = renderHook(() => useModelProfilesState());

    expect(result.current.profiles.length).toBeGreaterThan(0);
    expect(result.current.selectedId).toBe('preset-openai');
    expect(result.current.selected?.name).toBe('OpenAI 兼容');
    expect(result.current.addDraft).toEqual(emptyAddDraft());
  });

  it('allows adding profile from preset', () => {
    profileMocks.createCustomProfile.mockClear();
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.addFromPreset(PRESETS[0]);
    });

    expect(profileMocks.createCustomProfile).toHaveBeenCalledTimes(1);
    expect(result.current.selectedId).toBe('custom-123');
  });

  it('添加同名预设绑定已有行，不 createCustomProfile', () => {
    const seed = {
      id: 'opencode-go',
      name: 'OpenCode Go 订阅',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      models: ['deepseek-v4-flash'],
    };
    profileMocks.loadProfiles.mockReturnValue([seed]);
    profileMocks.createCustomProfile.mockClear();
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.addFromPreset(PRESETS[0]);
    });

    expect(profileMocks.createCustomProfile).not.toHaveBeenCalled();
    expect(result.current.selectedId).toBe('opencode-go');
    expect(
      result.current.profiles.filter((p) => p.name === 'OpenCode Go 订阅')
    ).toHaveLength(1);
    profileMocks.loadProfiles.mockReturnValue([profileMocks.OPENAI]);
  });

  it('设置列表按展示名折叠：种子 opencode-go 与 preset 拷贝只一行', () => {
    const seed = {
      id: 'opencode-go',
      name: 'OpenCode Go 订阅',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      models: ['deepseek-v4-flash'],
      hasKey: false,
      enabled: true,
    };
    const copy = {
      id: 'preset-opencode-go',
      name: 'OpenCode Go 订阅',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      models: [],
      hasKey: false,
      enabled: true,
    };
    profileMocks.loadProfiles.mockReturnValue([seed, copy]);
    const { result } = renderHook(() => useModelProfilesState());

    expect(result.current.profiles.map((p) => p.id)).toEqual(['opencode-go']);
    expect(
      result.current.profiles.filter((p) => p.name === 'OpenCode Go 订阅')
    ).toHaveLength(1);
    expect(result.current.selectedId).toBe('opencode-go');
  });

  it('sessionStorage 指向被折叠的拷贝时改绑胜者', () => {
    const seed = {
      id: 'opencode-go',
      name: 'OpenCode Go 订阅',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      models: ['deepseek-v4-flash'],
      hasKey: false,
      enabled: true,
    };
    const copy = {
      id: 'preset-opencode-go',
      name: 'OpenCode Go 订阅',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      models: [],
      hasKey: false,
      enabled: true,
    };
    profileMocks.loadProfiles.mockReturnValue([seed, copy]);
    sessionStorage.setItem(
      'crish_models_selected_profile_v1',
      'preset-opencode-go'
    );
    const { result } = renderHook(() => useModelProfilesState());

    expect(result.current.selectedId).toBe('opencode-go');
    expect(result.current.selected?.id).toBe('opencode-go');
    sessionStorage.removeItem('crish_models_selected_profile_v1');
  });

  it('已有种子+拷贝时添加同名预设不 create、列表仍一行', () => {
    const seed = {
      id: 'opencode-go',
      name: 'OpenCode Go 订阅',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      models: ['deepseek-v4-flash'],
      hasKey: false,
      enabled: true,
    };
    const copy = {
      id: 'preset-opencode-go',
      name: 'OpenCode Go 订阅',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      models: [],
      hasKey: false,
      enabled: true,
    };
    profileMocks.loadProfiles.mockReturnValue([seed, copy]);
    profileMocks.createCustomProfile.mockClear();
    const { result } = renderHook(() => useModelProfilesState());
    expect(result.current.profiles).toHaveLength(1);

    act(() => {
      result.current.addFromPreset(PRESETS[0]);
    });

    expect(profileMocks.createCustomProfile).not.toHaveBeenCalled();
    expect(result.current.profiles).toHaveLength(1);
    expect(result.current.profiles[0]?.id).toBe('opencode-go');
    expect(result.current.selectedId).toBe('opencode-go');
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
});
