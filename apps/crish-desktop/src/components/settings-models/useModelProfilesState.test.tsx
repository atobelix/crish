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
    findProfileByDisplayName: vi.fn(
      (profiles: { name: string }[], name: string) =>
        profiles.find((p) => p.name === name)
    ),
  };
});
vi.mock('../../services/toast/ToastContext', () => ({
  toast: { show: (...args: unknown[]) => toastShow(...args) },
}));

vi.mock('../../api/providerProfiles', () => ({
  addModelToProfile: vi.fn(),
  createCustomProfile: profileMocks.createCustomProfile,
  findProfileByDisplayName: profileMocks.findProfileByDisplayName,
  getActiveModelId: vi.fn(() => 'gpt-4o'),
  getActiveProfileId: vi.fn(() => 'preset-openai'),
  loadProfiles: profileMocks.loadProfiles,
  mergeModelIds: vi.fn((a, b) => [...a, ...b]),
  normalizeModelIds: vi.fn((m) => m),
  profileDisplayLabel: vi.fn((p: { name: string }) => p.name),
  profileHasKey: vi.fn(() => true),
  removeProfile: vi.fn(() => []),
  saveProfileBaseUrl: vi.fn(async () => ({ ok: true })),
  saveProfileKey: vi.fn(async () => ({ ok: true })),
  setProfileEnabled: vi.fn(),
  upsertProfile: vi.fn(),
}));

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
    profileMocks.loadProfiles.mockReturnValue([profileMocks.OPENAI]);
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
