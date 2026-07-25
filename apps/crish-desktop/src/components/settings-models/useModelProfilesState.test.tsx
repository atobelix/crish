// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { emptyAddDraft, PRESETS, useModelProfilesState } from './useModelProfilesState';

vi.mock('../../api/providerProfiles', () => ({
  addModelToProfile: vi.fn(),
  createCustomProfile: vi.fn((opts) => ({ id: 'custom-123', ...opts })),
  getActiveModelId: vi.fn(() => 'gpt-4o'),
  getActiveProfileId: vi.fn(() => 'preset-openai'),
  loadProfiles: vi.fn(() => [
    { id: 'preset-openai', name: 'OpenAI 兼容', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o'] }
  ]),
  mergeModelIds: vi.fn((a, b) => [...a, ...b]),
  normalizeModelIds: vi.fn((m) => m),
  profileDisplayLabel: vi.fn((p) => p.name),
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
  it('initializes with expected default values', () => {
    const { result } = renderHook(() => useModelProfilesState());

    expect(result.current.profiles.length).toBeGreaterThan(0);
    expect(result.current.selectedId).toBe('preset-openai');
    expect(result.current.selected?.name).toBe('OpenAI 兼容');
    expect(result.current.addDraft).toEqual(emptyAddDraft());
  });

  it('allows adding profile from preset', () => {
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.addFromPreset(PRESETS[0]);
    });

    expect(result.current.selectedId).toBe('custom-123');
  });

  it('allows filtering models', () => {
    const { result } = renderHook(() => useModelProfilesState());

    act(() => {
      result.current.setModelFilter('gpt');
    });

    expect(result.current.modelsList).toContain('gpt-4o');
  });
});
