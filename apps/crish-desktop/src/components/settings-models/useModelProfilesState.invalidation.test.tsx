// @vitest-environment jsdom
/**
 * R2-a ④ 设置页失效订阅组件测（详案 §1.1-④ / 02-总计划 R2-a）：
 * - 外部 profiles 变更（profiles-changed）→ 无未保存草稿直接 refresh 重载；
 * - 有未保存 cfgDraft → 提示 + 编辑会话 invalidate（不静默覆盖、不静默刷新）；
 * - saveConfig rev 核对（CT-01）：外部已变更 → 拒绝陈旧覆盖；
 * - openConfigFor 挂编辑会话（open(objectId, baseRev)）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { emitUiEvent } from '../../api/uiEvents';
import { useModelProfilesState } from './useModelProfilesState';
import type { ProviderProfile } from '../../api/providerProfiles';
import type { ModelMeta } from '../../api/modelCatalog';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  commit: vi.fn(),
  invalidate: vi.fn(),
  isOpen: vi.fn(),
  loadProfiles: vi.fn(),
  getModelMeta: vi.fn(),
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

vi.mock('../../api/providerProfiles', () => ({
  addModelToProfile: vi.fn(),
  createCustomProfile: vi.fn((opts) => ({ id: 'custom-123', ...opts })),
  getActiveModelId: vi.fn(() => 'gpt-4o'),
  getActiveProfileId: vi.fn(() => 'preset-openai'),
  loadProfiles: mocks.loadProfiles,
  mergeModelIds: vi.fn((a: string[], b: string[]) => [...a, ...b]),
  normalizeModelIds: vi.fn((m: unknown) => m),
  profileDisplayLabel: vi.fn((p: ProviderProfile) => p.name),
  profileHasKey: vi.fn(() => true),
  saveProfileKey: vi.fn(async () => ({ ok: true })),
  upsertProfile: vi.fn(),
}));

vi.mock('../../api/modelCatalog', () => ({
  getModelMeta: mocks.getModelMeta,
  MODEL_CAPABILITY_OPTIONS: [
    { key: 'tools', label: '工具调用' },
    { key: 'vision', label: '视觉' },
    { key: 'reasoning', label: '思考' },
  ],
  scanProviderModels: vi.fn(async () => ({
    ok: true,
    models: ['gpt-4o-mini'],
  })),
  setModelCapability: vi.fn(),
  setModelContextLength: vi.fn(),
  setModelDisplayName: vi.fn(),
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

const BASE_META: ModelMeta = {
  profileId: 'preset-openai',
  model: 'gpt-4o',
  displayName: 'GPT-4o',
  enabled: true,
  contextLength: 128000,
  capabilities: { tools: true },
};

let currentProfiles: ProviderProfile[];
let currentMeta: ModelMeta;

describe('useModelProfilesState 失效订阅（R2-a ④）', () => {
  beforeEach(() => {
    currentProfiles = [PROFILE];
    currentMeta = { ...BASE_META };
    mocks.loadProfiles.mockImplementation(() => currentProfiles);
    mocks.getModelMeta.mockImplementation(() => ({ ...currentMeta }));
    mocks.open.mockClear();
    mocks.commit.mockClear();
    mocks.invalidate.mockClear();
    mocks.isOpen.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('外部 profiles 变更且无未保存草稿 → 直接 refresh 重载（不提示）', () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useModelProfilesState(onShowToast));

    expect(result.current.profiles.map((p) => p.id)).toEqual(['preset-openai']);

    // 模拟其它 tab/窗口/Rust 端落盘（无未保存草稿）
    currentProfiles = [PROFILE_UPDATED];
    act(() => {
      emitUiEvent('profiles-changed');
    });

    expect(result.current.profiles[0]?.models).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);
    expect(onShowToast).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('外部变更且有未保存 cfgDraft → 提示 + 编辑会话 invalidate，不静默覆盖/不静默刷新', () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useModelProfilesState(onShowToast));

    act(() => {
      result.current.openConfigFor('gpt-4o');
    });
    expect(result.current.cfgDraft).not.toBeNull();
    // openConfigFor 挂编辑会话：open(objectId)（设置 rev 为本地签名不进会话）
    expect(mocks.open).toHaveBeenCalledWith('preset-openai::gpt-4o');

    currentProfiles = [PROFILE_UPDATED];
    act(() => {
      emitUiEvent('profiles-changed');
    });

    expect(onShowToast).toHaveBeenCalledWith(
      false,
      '配置已被外部修改，请确认后重载或丢弃草稿'
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      'preset-openai::gpt-4o',
      'external'
    );
    // 不静默覆盖：草稿保留、列表不强制刷新
    expect(result.current.cfgDraft).not.toBeNull();
  });

  it('saveConfig rev 核对（CT-01）：外部已变更 rev 不符 → 拒绝陈旧覆盖', () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useModelProfilesState(onShowToast));

    act(() => {
      result.current.openConfigFor('gpt-4o');
      // 保存前编辑草稿
      result.current.setCfgDraft({
        displayName: 'GPT-4o 改',
        contextLength: '130000',
        caps: { tools: true, vision: false, reasoning: false },
      });
    });

    // 外部变更：model meta 被其它窗口改写（rev 漂移）
    currentMeta = {
      ...BASE_META,
      contextLength: 200000,
      displayName: 'GPT-4o（外部改）',
    };

    act(() => {
      result.current.saveConfig();
    });

    expect(onShowToast).toHaveBeenCalledWith(
      false,
      '配置已被外部修改，保存已取消，请重新确认'
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      'preset-openai::gpt-4o',
      'external'
    );
    // applyMetaForModel 路径（modelCatalog setters）不触发——陈旧草稿未整体覆盖
    expect(result.current.cfgDraft).not.toBeNull();
  });

  it('saveConfig rev 一致 → 正常保存并 commit 编辑会话（推进 rev）', () => {
    const onShowToast = vi.fn();
    const { result } = renderHook(() => useModelProfilesState(onShowToast));

    act(() => {
      result.current.openConfigFor('gpt-4o');
      result.current.setCfgDraft({
        displayName: 'GPT-4o 正常改',
        contextLength: '130000',
        caps: { tools: true, vision: false, reasoning: false },
      });
    });

    act(() => {
      result.current.saveConfig();
    });

    // commit(objectId) 已调用（会话提交关闭；CT-01 核对在本地 rev 比对完成）
    expect(mocks.commit).toHaveBeenCalledWith('preset-openai::gpt-4o');
    expect(onShowToast).not.toHaveBeenCalled();
    // 保存后重开配置（新会话 + 新本地 rev）
    expect(mocks.open).toHaveBeenCalledTimes(2);
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
