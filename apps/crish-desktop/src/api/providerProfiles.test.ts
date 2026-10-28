import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
    },
    configurable: true,
  });
});

vi.mock('./engineConfig', () => ({
  updateEngineConfig: vi.fn(async () => ({ ok: true })),
  pushRecentModel: vi.fn((m: string) => [m]),
  fetchEngineStatus: vi.fn(async () => ({
    ok: true,
    model: 'user-local-model',
    hasApiKey: true,
  })),
}));

// PE-07 T07.4：profileStore 密钥读写改走 rustProfileStore（config_secret_* /
// config_profile_apply）——mock 三态（ok / missing / error）由用例控制。
vi.mock('./provider-profiles/rustProfileStore', () => ({
  configSecretSet: vi.fn(async (profileId: string, apiKey: string) => ({
    status: 'ok' as const,
    data: {
      ok: true,
      profileId,
      hasKey: Boolean(apiKey.trim()),
      persistence: 'persisted',
    },
  })),
  configSecretClear: vi.fn(async (profileId: string) => ({
    status: 'ok' as const,
    data: { ok: true, profileId, hasKey: false, persistence: 'persisted' },
  })),
  configSecretGet: vi.fn(async (profileId: string) => ({
    status: 'ok' as const,
    data: { ok: true, profileId, hasKey: false, apiKeyLast4: null },
  })),
  configSecretHas: vi.fn(async (profileId: string) => ({
    status: 'ok' as const,
    data: { ok: true, profileId, hasKey: false },
  })),
  configSecretReveal: vi.fn(async (profileId: string, uiConfirm: boolean) => ({
    status: 'ok' as const,
    data: {
      ok: true,
      profileId,
      hasKey: uiConfirm,
      apiKeyLast4: 'st4',
      revealed: uiConfirm,
    },
  })),
  configProfileApply: vi.fn(
    async (args: { profileId: string; apiKey?: string }) => ({
      status: 'ok' as const,
      data: {
        ok: true,
        profileId: args.profileId,
        hasApiKey: Boolean(args.apiKey),
        apiKeyLast4: 'st4',
        credentialMode: 'direct',
        credentialPersistence: 'persisted',
      },
    })
  ),
  configGet: vi.fn(async () => ({ status: 'ok' as const, data: { ok: true } })),
  configUpdate: vi.fn(async (u: Record<string, unknown>) => ({
    status: 'ok' as const,
    data: { ok: true, ...u },
  })),
}));

vi.mock('./clientApi', () => ({
  clientApi: {
    updateSettings: vi.fn(async (u: Record<string, unknown>) => ({
      defaultModel: u.defaultModel,
      defaultProvider: u.defaultProvider,
    })),
  },
}));

vi.mock('../store/layoutStore', () => ({
  useLayoutStore: {
    getState: () => ({
      setAppSettings: vi.fn(),
    }),
  },
  // workspaceStore 顶层模块图（I1-β 后 profileStore → contextStatePending →
  // storeAccess 链使 workspaceStore 进入本测试模块图；mock 补齐其顶层依赖）
  DEFAULT_WORKSPACE_ID: 'default',
  seedInitialWorkspaces: vi.fn(() => ({})),
  clampActiveWorkspaceIndex: (workspaces: unknown[], index: number) => {
    if (!Array.isArray(workspaces) || workspaces.length === 0) return 0;
    const i = Number.isFinite(index) ? Math.trunc(index) : 0;
    return Math.min(Math.max(0, i), workspaces.length - 1);
  },
}));

import {
  activateProfileModel,
  addModelToProfile,
  anyProfileHasKey,
  anyProfileHasModel,
  findProfileByDisplayName,
  flattenModelChoices,
  flattenModelChoicesFrom,
  foldProfilesByDisplayName,
  getActiveModelId,
  getActiveProfileId,
  getDefaultProviderProfiles,
  getProviderSetupStatus,
  isEmptyModelCatalog,
  isLegacySeedModelId,
  KNOWN_PROFILE_LABELS,
  loadProfiles,
  mergeModelIds,
  normalizeModelIds,
  normalizeProfileLabelText,
  normalizeProviderProfile,
  normalizeProviderProfiles,
  pickDefaultModelId,
  pickDefaultModelSelection,
  profileDisplayLabel,
  profileDisplayNameKey,
  profileHasKey,
  profileHasUsableModels,
  removeModelFromProfile,
  removeProfile,
  resetLegacyMigrationForTests,
  resolveDisplayModelId,
  resolvePreferredModelSelection,
  saveProfileBaseUrl,
  saveProfileKey,
  saveProfiles,
  sanitizeGhostActiveModel,
  setActiveModelId,
  setActiveProfileId,
  setProfileEnabled,
  setProfileKey,
  stripLegacySeedModels,
  truncateProfileLabel,
} from './providerProfiles';
import { updateEngineConfig } from './engineConfig';
import {
  configProfileApply,
  configSecretSet,
} from './provider-profiles/rustProfileStore';

describe('providerProfiles', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLegacyMigrationForTests();
    vi.clearAllMocks();
  });

  it('DEFAULT_PROFILES: empty — neutral product, no third-party shells', () => {
    // 中立产品：不预置任何第三方服务商；用户自建 custom 服务商
    expect(getDefaultProviderProfiles()).toEqual([]);

    const loaded = loadProfiles();
    expect(loaded).toEqual([]);
  });

  it('resolvePreferred prefers stored local model over engine demo mimo', () => {
    saveProfiles([
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        models: ['deepseek-chat', 'deepseek-v4-flash'],
        hasKey: true,
        apiKey: 'sk-test',
      },
    ]);
    setActiveProfileId('deepseek');
    setActiveModelId('deepseek-v4-flash');

    const resolved = resolvePreferredModelSelection({
      engineModel: 'mimo-v2.5',
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.model).toBe('deepseek-v4-flash');
    expect(resolved!.profileId).toBe('deepseek');
    expect(resolved!.source).toBe('stored_active');

    // 展示层也不被引擎演示 id 盖住
    expect(resolveDisplayModelId('mimo-v2.5')).toBe('deepseek-v4-flash');
  });

  it('does not adopt engine demo model when it is not in any local list', () => {
    saveProfiles([
      {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        models: [],
        hasKey: true,
        apiKey: 'sk-x',
      },
    ]);
    // 清空活动选择
    try {
      localStorage.removeItem('crish_active_profile_id');
      localStorage.removeItem('crish_active_model_id');
    } catch {
      /* ignore */
    }

    const resolved = resolvePreferredModelSelection({
      engineModel: 'mimo-v2.5',
    });
    expect(resolved).toBeNull();
    expect(resolveDisplayModelId('mimo-v2.5')).toBe('');
  });

  it('does not adopt engine model without a stored provider selection', () => {
    saveProfiles([
      {
        id: 'flowbit',
        name: 'Flowbit',
        baseUrl: 'https://api.flowbit.me',
        models: ['mimo-v2.5'],
        hasKey: true,
        apiKey: 'k',
      },
    ]);
    try {
      localStorage.removeItem('crish_active_profile_id');
      localStorage.removeItem('crish_active_model_id');
    } catch {
      /* ignore */
    }

    // U1：引擎回报的 model 不带 provider 信息，不用于定位 → 置空
    const resolved = resolvePreferredModelSelection({
      engineModel: 'mimo-v2.5',
    });
    expect(resolved).toBeNull();
  });

  it('flattenModelChoices only returns real profile models', () => {
    saveProfiles([
      {
        id: 'a',
        name: 'A',
        baseUrl: 'https://example.com',
        models: ['model-a', 'model-b'],
        hasKey: true,
      },
      {
        id: 'b',
        name: 'B',
        baseUrl: 'https://example.com',
        models: [],
        hasKey: false,
        enabled: false,
      },
    ]);
    const choices = flattenModelChoices();
    expect(choices.map((c) => c.model).sort()).toEqual(['model-a', 'model-b']);
    expect(choices.every((c) => c.profileId === 'a')).toBe(true);
  });

  it('activateProfileModel writes active selection and adds model to list', async () => {
    saveProfiles([
      {
        id: 'p1',
        name: 'P1',
        baseUrl: 'https://api.example.com/v1',
        models: [],
        hasKey: true,
        apiKey: 'sk-1',
      },
    ]);

    const res = await activateProfileModel('p1', 'custom-model-x');
    expect(res.ok).toBe(true);
    expect(getActiveProfileId()).toBe('p1');
    expect(getActiveModelId()).toBe('custom-model-x');
    expect(loadProfiles().find((p) => p.id === 'p1')?.models).toContain(
      'custom-model-x'
    );
  });

  it('removeModelFromProfile clears active model when removed', () => {
    saveProfiles([
      {
        id: 'p1',
        name: 'P1',
        baseUrl: 'https://api.example.com/v1',
        models: ['m1', 'm2'],
        hasKey: true,
      },
    ]);
    setActiveProfileId('p1');
    setActiveModelId('m1');
    removeModelFromProfile('p1', 'm1');
    expect(getActiveModelId()).toBeNull();
    expect(loadProfiles()![0]!.models).toEqual(['m2']);
  });

  it('addModelToProfile is idempotent', () => {
    saveProfiles([
      {
        id: 'p1',
        name: 'P1',
        baseUrl: 'https://x',
        models: ['a'],
        hasKey: false,
      },
    ]);
    addModelToProfile('p1', 'a');
    addModelToProfile('p1', 'b');
    expect(loadProfiles()![0]!.models).toEqual(['a', 'b']);
  });

  it('returns null when active selection is empty (no auto-pick of keyed model)', async () => {
    saveProfiles([
      {
        id: 'empty',
        name: 'Empty',
        baseUrl: 'https://a',
        models: [],
        hasKey: false,
      },
      {
        id: 'keyed',
        name: 'Keyed',
        baseUrl: 'https://b',
        models: ['real-1'],
        hasKey: true,
        apiKey: 'k',
      },
    ]);
    await setProfileKey('keyed', 'k');
    try {
      localStorage.removeItem('crish_active_profile_id');
      localStorage.removeItem('crish_active_model_id');
    } catch {
      /* ignore */
    }

    // U1：无活动选择 → 置空，不自动选「第一个可用」
    expect(resolvePreferredModelSelection()).toBeNull();
  });

  it('getProviderSetupStatus: fresh install needs key, model picker remains visible', () => {
    // 中立产品：空库无预置服务商/模型/密钥
    loadProfiles();
    const s = getProviderSetupStatus({
      engineOk: true,
      engineHasApiKey: false,
    });
    expect(s.needsKeySetup).toBe(true);
    // 无密钥时不进入 needsModelSetup（先要配连接）
    expect(s.needsModelSetup).toBe(false);
    // 模型选择器作为输入坞第一公民恒定渲染（不随未配 Key 消失）
    expect(s.showModelPicker).toBe(true);
    expect(s.hasLocalKey).toBe(false);
    expect(anyProfileHasKey()).toBe(false);
    // 空库：无任何模型
    expect(anyProfileHasModel()).toBe(false);
  });

  it('getProviderSetupStatus: key without models → needsModelSetup, picker visible', () => {
    saveProfiles([
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        models: [],
        hasKey: true,
        apiKey: 'sk-x',
      },
    ]);
    try {
      localStorage.removeItem('crish_active_profile_id');
      localStorage.removeItem('crish_active_model_id');
    } catch {
      /* ignore */
    }
    const s = getProviderSetupStatus({
      engineOk: true,
      engineHasApiKey: false,
      engineModel: 'mimo-v2.5', // 演示 id 不得冒充已就绪
    });
    expect(s.needsKeySetup).toBe(false);
    expect(s.needsModelSetup).toBe(true);
    expect(s.showModelPicker).toBe(true);
    expect(s.resolvedModel).toBeNull();
    expect(anyProfileHasModel()).toBe(false);
  });

  it('getProviderSetupStatus: hand-filled model clears needsModelSetup', () => {
    saveProfiles([
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        models: ['deepseek-chat'],
        hasKey: true,
        apiKey: 'sk-x',
      },
    ]);
    setActiveProfileId('deepseek');
    setActiveModelId('deepseek-chat');
    const s = getProviderSetupStatus({ engineOk: true, engineHasApiKey: true });
    expect(s.needsKeySetup).toBe(false);
    expect(s.needsModelSetup).toBe(false);
    expect(s.showModelPicker).toBe(true);
    expect(s.resolvedModel).toBe('deepseek-chat');
  });

  it('getProviderSetupStatus: engine key alone shows picker (local-first still no demo model)', () => {
    saveProfiles([
      {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        models: [],
        hasKey: false,
      },
    ]);
    try {
      localStorage.removeItem('crish_active_profile_id');
      localStorage.removeItem('crish_active_model_id');
    } catch {
      /* ignore */
    }
    const s = getProviderSetupStatus({
      engineOk: true,
      engineHasApiKey: true,
      engineModel: 'mimo-v2.5',
    });
    expect(s.needsKeySetup).toBe(false);
    expect(s.hasEngineKey).toBe(true);
    expect(s.showModelPicker).toBe(true);
    // 引擎演示 model 不在本机列表 → 仍需手填
    expect(s.needsModelSetup).toBe(true);
    expect(s.resolvedModel).toBeNull();
  });

  it('stripLegacySeedModels clears old hardcoded mimo seed when no key', () => {
    const stripped = stripLegacySeedModels({
      id: 'flowbit',
      name: 'Flowbit',
      baseUrl: 'https://api.flowbit.me',
      models: ['mimo-v2.5'],
      hasKey: false,
    });
    expect(stripped.models).toEqual([]);

    const kept = stripLegacySeedModels({
      id: 'flowbit',
      name: 'Flowbit',
      baseUrl: 'https://api.flowbit.me',
      models: ['mimo-v2.5'],
      hasKey: true,
      apiKey: 'sk-x',
    });
    expect(kept.models).toEqual(['mimo-v2.5']);

    const custom = stripLegacySeedModels({
      id: 'flowbit',
      name: 'Flowbit',
      baseUrl: 'https://api.flowbit.me',
      models: ['mimo-v2.5', 'other'],
      hasKey: false,
    });
    expect(custom.models).toEqual(['mimo-v2.5', 'other']);
  });

  it('loadProfiles migrates legacy seed and clears ghost active mimo', () => {
    localStorage.setItem(
      'crish_provider_profiles_v1',
      JSON.stringify([
        {
          id: 'flowbit',
          name: 'Flowbit',
          baseUrl: 'https://api.flowbit.me',
          models: ['mimo-v2.5'],
          hasKey: false,
        },
      ])
    );
    localStorage.setItem('crish_active_profile_id', 'flowbit');
    localStorage.setItem('crish_active_model_id', 'mimo-v2.5');

    const loaded = loadProfiles();
    expect(loaded.find((p) => p.id === 'flowbit')?.models).toEqual([]);
    expect(getActiveModelId()).toBeNull();
    // 持久化后再次 load 仍为空
    expect(loadProfiles().find((p) => p.id === 'flowbit')?.models).toEqual([]);
  });

  it('loadProfiles always clears ghost mimo even when models already empty (no migration write)', () => {
    // residual after CK: sanitize only ran when `changed`; already-empty list left ghost active
    localStorage.setItem(
      'crish_provider_profiles_v1',
      JSON.stringify([
        {
          id: 'flowbit',
          name: 'Flowbit',
          baseUrl: 'https://api.flowbit.me',
          models: [],
          hasKey: false,
        },
        {
          id: 'openai',
          name: 'OpenAI 兼容',
          baseUrl: 'https://api.openai.com/v1',
          models: [],
          hasKey: true,
          apiKey: 'sk-x',
        },
      ])
    );
    localStorage.setItem('crish_active_profile_id', 'openai');
    localStorage.setItem('crish_active_model_id', 'mimo-v2.5');

    loadProfiles();
    expect(getActiveModelId()).toBeNull();
    // resolve must not treat ghost mimo as stored_active readiness
    expect(
      resolvePreferredModelSelection({ engineModel: 'mimo-v2.5' })
    ).toBeNull();
    const s = getProviderSetupStatus({
      engineOk: true,
      engineHasApiKey: true,
      engineModel: 'mimo-v2.5',
    });
    expect(s.resolvedModel).toBeNull();
    expect(s.needsModelSetup).toBe(true);
  });

  it('sanitizeGhostActiveModel keeps mimo only when listed on an enabled profile', () => {
    const listed = [
      {
        id: 'flowbit',
        name: 'Flowbit',
        baseUrl: 'https://api.flowbit.me',
        models: ['mimo-v2.5'],
        hasKey: true,
        apiKey: 'k',
      },
    ];
    setActiveProfileId('flowbit');
    setActiveModelId('mimo-v2.5');
    expect(sanitizeGhostActiveModel(listed)).toBe(false);
    expect(getActiveModelId()).toBe('mimo-v2.5');

    // not in any enabled list → ghost
    setActiveModelId('mimo-v2.5');
    expect(
      sanitizeGhostActiveModel([
        {
          id: 'flowbit',
          name: 'Flowbit',
          baseUrl: 'https://api.flowbit.me',
          models: [],
          hasKey: true,
          apiKey: 'k',
        },
      ])
    ).toBe(true);
    expect(getActiveModelId()).toBeNull();
  });

  it('saveProfileBaseUrl syncs engine when profile is active', async () => {
    saveProfiles([
      {
        id: 'p1',
        name: 'P1',
        baseUrl: 'https://old.example',
        models: ['m1'],
        hasKey: true,
        apiKey: 'sk-1',
      },
    ]);
    setActiveProfileId('p1');
    setActiveModelId('m1');

    const res = await saveProfileBaseUrl('p1', 'https://new.example/v1');
    expect(res.ok).toBe(true);
    expect(res.synced).toBe(true);
    expect(loadProfiles()![0]!.baseUrl).toBe('https://new.example/v1');
    // PE-07 T07.4（K-01）：同步改走 config_profile_apply，payload 不含 apiKey
    expect(updateEngineConfig).not.toHaveBeenCalled();
    expect(configProfileApply).toHaveBeenCalledWith({
      profileId: 'p1',
      baseUrl: 'https://new.example/v1',
      model: 'm1',
    });
    expect(
      JSON.stringify(vi.mocked(configProfileApply).mock.calls[0])
    ).not.toContain('sk-1');
  });

  it('saveProfileBaseUrl does not sync when profile is not active', async () => {
    saveProfiles([
      {
        id: 'p1',
        name: 'P1',
        baseUrl: 'https://a',
        models: [],
        hasKey: false,
      },
      {
        id: 'p2',
        name: 'P2',
        baseUrl: 'https://b',
        models: ['x'],
        hasKey: true,
        apiKey: 'k',
      },
    ]);
    setActiveProfileId('p2');
    vi.mocked(updateEngineConfig).mockClear();

    const res = await saveProfileBaseUrl('p1', 'https://a-new');
    expect(res.ok).toBe(true);
    expect(res.synced).toBe(false);
    expect(updateEngineConfig).not.toHaveBeenCalled();
    expect(loadProfiles().find((p) => p.id === 'p1')?.baseUrl).toBe(
      'https://a-new'
    );
  });

  it('saveProfileKey persists and activates when no active profile', async () => {
    saveProfiles([
      {
        id: 'ds',
        name: 'DS',
        baseUrl: 'https://api.deepseek.com',
        models: ['deepseek-chat'],
        hasKey: false,
      },
    ]);
    try {
      localStorage.removeItem('crish_active_profile_id');
      localStorage.removeItem('crish_active_model_id');
    } catch {
      /* ignore */
    }

    const res = await saveProfileKey('ds', 'sk-new');
    expect(res.ok).toBe(true);
    expect(res.synced).toBe(true);
    expect(getActiveProfileId()).toBe('ds');
    expect(getActiveModelId()).toBe('deepseek-chat');
    expect(anyProfileHasKey()).toBe(true);
    // K-01：密钥经 config_secret_set 落 DPAPI；激活经 config_profile_apply（无明文）
    expect(configSecretSet).toHaveBeenCalledWith('ds', 'sk-new');
    expect(configProfileApply).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'ds', model: 'deepseek-chat' })
    );
    expect(
      JSON.stringify(vi.mocked(configProfileApply).mock.calls[0])
    ).not.toContain('sk-new');
    // localStorage 全程无明文
    expect(localStorage.getItem('crish_provider_profiles_v1')).not.toContain(
      'sk-new'
    );
  });

  it('PE-07 T07.4 用例 3：setProfileKey 后 localStorage 无明文（仅 hasKey）', async () => {
    saveProfiles([
      {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        models: [],
        hasKey: false,
      },
    ]);
    await setProfileKey('openai', 'sk-x');
    const stored = localStorage.getItem('crish_provider_profiles_v1') || '';
    expect(stored).not.toContain('sk-x');
    const parsed = JSON.parse(stored);
    expect(parsed[0].hasKey).toBe(true);
    expect('apiKey' in parsed[0]).toBe(false);
    expect(configSecretSet).toHaveBeenCalledWith('openai', 'sk-x');
    // 会话内存缓存：模型扫描/连通测试可读
    expect(loadProfiles().find((p) => p.id === 'openai')?.hasKey).toBe(true);
  });

  it('removeProfile clears active model when removing active profile', () => {
    saveProfiles([
      {
        id: 'keep',
        name: 'Keep',
        baseUrl: 'https://k',
        models: ['k1'],
        hasKey: true,
      },
      {
        id: 'gone',
        name: 'Gone',
        baseUrl: 'https://g',
        models: ['g1'],
        hasKey: true,
      },
    ]);
    setActiveProfileId('gone');
    setActiveModelId('g1');
    removeProfile('gone');
    expect(getActiveProfileId()).toBeNull();
    expect(getActiveModelId()).toBeNull();
    expect(loadProfiles().some((p) => p.id === 'gone')).toBe(false);
  });

  it('setProfileEnabled(false) clears active selection for that profile', () => {
    saveProfiles([
      {
        id: 'p1',
        name: 'P1',
        baseUrl: 'https://x',
        models: ['m1'],
        hasKey: true,
        apiKey: 'k',
      },
    ]);
    setActiveProfileId('p1');
    setActiveModelId('m1');
    setProfileEnabled('p1', false);
    expect(getActiveProfileId()).toBeNull();
    expect(getActiveModelId()).toBeNull();
    expect(loadProfiles()![0]!.enabled).toBe(false);
    // 禁用后不参与解析
    expect(resolvePreferredModelSelection()).toBeNull();
  });

  it('resolve priority: stored_active wins over engine hint (no cross-provider fallback)', () => {
    saveProfiles([
      {
        id: 'a',
        name: 'A',
        baseUrl: 'https://a',
        models: ['local-pick', 'engine-also'],
        hasKey: true,
        apiKey: 'k',
      },
      {
        id: 'b',
        name: 'B',
        baseUrl: 'https://b',
        models: ['other-first'],
        hasKey: true,
        apiKey: 'k2',
      },
    ]);
    setActiveProfileId('a');
    setActiveModelId('local-pick');
    const r = resolvePreferredModelSelection({ engineModel: 'engine-also' });
    expect(r?.source).toBe('stored_active');
    expect(r?.model).toBe('local-pick');
  });

  describe('pure helpers', () => {
    it('normalizeModelIds trims, drops empties, dedupes preserving order', () => {
      expect(normalizeModelIds(null)).toEqual([]);
      expect(normalizeModelIds(undefined)).toEqual([]);
      expect(normalizeModelIds('not-array')).toEqual([]);
      expect(normalizeModelIds(['  a ', '', 'b', 'a', '  ', 'c', 'b'])).toEqual(
        ['a', 'b', 'c']
      );
      expect(normalizeModelIds([null, 0 as unknown as string, 'x'])).toEqual([
        '0',
        'x',
      ]);
    });

    it('mergeModelIds unions lists with first-wins order', () => {
      expect(mergeModelIds(['a', 'b'], ['b', 'c'], ['a', 'd'])).toEqual([
        'a',
        'b',
        'c',
        'd',
      ]);
      expect(mergeModelIds(undefined, null, [])).toEqual([]);
      expect(mergeModelIds(['  x '], 'y', ['y', 'z'])).toEqual(['x', 'y', 'z']);
    });

    it('normalizeProviderProfile dedupes models and Chinese-safe name', () => {
      const p = normalizeProviderProfile({
        id: 'deepseek',
        name: '  \u3000深度求索\u3000  ',
        baseUrl: '  https://api.deepseek.com  ',
        models: ['chat', ' chat ', '', 'chat', 'reasoner'],
        hasKey: false,
        apiKey: ' sk ',
      });
      expect(p.name).toBe('深度求索');
      expect(p.baseUrl).toBe('https://api.deepseek.com');
      expect(p.models).toEqual(['chat', 'reasoner']);
      expect(p.hasKey).toBe(true);
      expect(p.enabled).toBe(true);

      // empty name → known Chinese shell label
      const shell = normalizeProviderProfile({
        id: 'openai',
        name: '  ',
        models: [],
      });
      expect(shell.name).toBe(KNOWN_PROFILE_LABELS.openai);
    });

    it('normalizeProviderProfiles drops bad rows and dedupes by id (first wins)', () => {
      const list = normalizeProviderProfiles([
        null,
        { id: 'a', name: 'First', models: ['m1', 'm1'] },
        { name: 'no-id', models: ['x'] },
        { id: 'a', name: 'Second', models: ['m2'] },
        { id: 'b', name: 'B', models: [] },
      ]);
      expect(list.map((p) => p.id)).toEqual(['a', 'b']);
      expect(list![0]!.name).toBe('First');
      expect(list![0]!.models).toEqual(['m1']);
      expect(normalizeProviderProfiles(null)).toEqual([]);
      expect(normalizeProviderProfiles({})).toEqual([]);
    });

    it('profileDisplayLabel / truncate are Chinese-safe', () => {
      expect(profileDisplayLabel('flowbit')).toBe('Flowbit');
      expect(profileDisplayLabel({ id: 'custom', name: '我的服务商' })).toBe(
        '我的服务商'
      );
      expect(profileDisplayLabel({ id: 'openai', name: '  ' })).toBe(
        'OpenAI 兼容'
      );
      expect(profileDisplayLabel(null)).toBe('未命名服务商');
      expect(profileDisplayLabel('')).toBe('未命名服务商');

      expect(normalizeProfileLabelText('  你好\u3000')).toBe('你好');
      // 中文按码点截断，不半切 surrogate
      expect(truncateProfileLabel('深度求索模型服务', 4)).toBe('深度求…');
      expect(truncateProfileLabel('短', 10)).toBe('短');
      expect(truncateProfileLabel('abc', 1)).toBe('…');
    });

    it('foldProfilesByDisplayName keeps one OpenCode Go 订阅 (seed over empty custom)', () => {
      const seed = {
        id: 'opencode-go',
        name: 'OpenCode Go 订阅',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        models: ['deepseek-v4-flash'],
        hasKey: false,
        enabled: true,
      };
      const custom = {
        id: 'custom-dup',
        name: '  OpenCode Go 订阅  ',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        models: [],
        hasKey: false,
        enabled: true,
      };
      const zen = {
        id: 'opencode-zen',
        name: 'OpenCode Zen 订阅',
        baseUrl: 'https://opencode.ai/zen/v1',
        models: [],
        hasKey: false,
        enabled: true,
      };
      const folded = foldProfilesByDisplayName([custom, seed, zen]);
      expect(folded.map((p) => p.id)).toEqual(['opencode-go', 'opencode-zen']);
      expect(
        folded.filter((p) => profileDisplayNameKey(p) === 'OpenCode Go 订阅')
      ).toHaveLength(1);
      expect(
        findProfileByDisplayName([custom, seed], 'OpenCode Go 订阅')?.id
      ).toBe('opencode-go');
      expect(
        findProfileByDisplayName([zen], 'OpenCode Go 订阅')
      ).toBeUndefined();
    });

    it('foldProfilesByDisplayName prefers keyed custom over empty seed', () => {
      const seed = {
        id: 'opencode-go',
        name: 'OpenCode Go 订阅',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        models: ['deepseek-v4-flash'],
        hasKey: false,
      };
      const custom = {
        id: 'custom-keyed',
        name: 'OpenCode Go 订阅',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        models: ['deepseek-v4-flash', 'glm-5.2'],
        hasKey: true,
      };
      expect(
        foldProfilesByDisplayName([seed, custom]).map((p) => p.id)
      ).toEqual(['custom-keyed']);
    });

    it('empty catalog guards: no mimo fallback', () => {
      expect(isEmptyModelCatalog([])).toBe(true);
      expect(isEmptyModelCatalog(null)).toBe(true);
      expect(
        isEmptyModelCatalog([
          { enabled: true, models: [] },
          { enabled: false, models: ['hidden'] },
        ])
      ).toBe(true);
      expect(
        isEmptyModelCatalog([{ enabled: true, models: ['  ', 'real'] }])
      ).toBe(false);

      expect(profileHasUsableModels({ enabled: false, models: ['a'] })).toBe(
        false
      );
      expect(profileHasUsableModels({ enabled: true, models: ['a'] })).toBe(
        true
      );
      expect(profileHasKey({ hasKey: false, apiKey: '  k ' })).toBe(true);
      expect(profileHasKey({ hasKey: false })).toBe(false);

      // 空 catalog + 引擎演示 id → null（绝不回落 mimo）
      const empty = pickDefaultModelSelection(
        [
          {
            id: 'openai',
            name: 'O',
            baseUrl: '',
            models: [],
            hasKey: true,
            apiKey: 'k',
          },
        ],
        { engineModel: 'mimo-v2.5' }
      );
      expect(empty).toBeNull();
      expect(
        pickDefaultModelId(
          [{ id: 'x', name: 'X', baseUrl: '', models: [], hasKey: false }],
          { engineModel: 'mimo-v2.5', storedModel: 'mimo-v2.5' }
        )
      ).toBeNull();
    });

    it('pickDefaultModelSelection pure priority without LS', () => {
      const profiles = [
        {
          id: 'a',
          name: 'A',
          baseUrl: '',
          models: ['local-pick', 'engine-also'],
          hasKey: true,
          apiKey: 'k',
        },
        {
          id: 'b',
          name: 'B',
          baseUrl: '',
          models: ['other-first'],
          hasKey: true,
          apiKey: 'k2',
        },
      ];

      expect(
        pickDefaultModelSelection(profiles, {
          storedProfileId: 'a',
          storedModel: 'local-pick',
          engineModel: 'engine-also',
        })?.source
      ).toBe('stored_active');

      // 无 providerId 的裸 modelId → 不跨厂商回落（U1 裁决）
      expect(
        pickDefaultModelSelection(profiles, {
          storedModel: 'other-first',
        })
      ).toBeNull();

      expect(
        pickDefaultModelSelection(profiles, {
          storedProfileId: 'b',
        })?.source
      ).toBe('active_profile_first');

      // engineModel 不带 provider 信息，不用于定位 → null
      expect(
        pickDefaultModelSelection(profiles, {
          engineModel: 'engine-also',
        })
      ).toBeNull();

      // requireInList rejects hand-fill not in list
      expect(
        pickDefaultModelSelection(
          [{ id: 'a', name: 'A', baseUrl: '', models: ['only'], hasKey: true }],
          {
            storedProfileId: 'a',
            storedModel: 'ghost',
            requireInList: true,
          }
        )?.model
      ).toBe('only');
    });

    it('pickDefault allows stored hand-fill when catalog empty and requireInList off', () => {
      const r = pickDefaultModelSelection(
        [
          {
            id: 'p',
            name: 'P',
            baseUrl: '',
            models: [],
            hasKey: true,
            apiKey: 'k',
          },
        ],
        { storedProfileId: 'p', storedModel: 'hand-filled-id' }
      );
      expect(r).toEqual({
        profileId: 'p',
        model: 'hand-filled-id',
        source: 'stored_active',
      });
    });

    it('pickDefault refuses ghost legacy seed (mimo) as stored_active when not in list', () => {
      expect(isLegacySeedModelId('mimo-v2.5')).toBe(true);
      expect(isLegacySeedModelId('  mimo-v2.5  ')).toBe(true);
      expect(isLegacySeedModelId('hand-filled-id')).toBe(false);

      // empty catalog + ghost mimo → null（不冒充已配）
      expect(
        pickDefaultModelSelection(
          [
            {
              id: 'p',
              name: 'P',
              baseUrl: '',
              models: [],
              hasKey: true,
              apiKey: 'k',
            },
          ],
          {
            storedProfileId: 'p',
            storedModel: 'mimo-v2.5',
            engineModel: 'mimo-v2.5',
          }
        )
      ).toBeNull();

      // non-empty catalog but mimo not listed → 取该 provider 首个模型（同 provider，不跨厂商）
      const r = pickDefaultModelSelection(
        [
          {
            id: 'p',
            name: 'P',
            baseUrl: '',
            models: ['real-1'],
            hasKey: true,
            apiKey: 'k',
          },
        ],
        {
          storedProfileId: 'p',
          storedModel: 'mimo-v2.5',
          engineModel: 'mimo-v2.5',
        }
      );
      expect(r).toEqual({
        profileId: 'p',
        model: 'real-1',
        source: 'active_profile_first',
      });

      // user intentionally listed mimo → allowed
      expect(
        pickDefaultModelSelection(
          [
            {
              id: 'flowbit',
              name: 'F',
              baseUrl: '',
              models: ['mimo-v2.5'],
              hasKey: true,
              apiKey: 'k',
            },
          ],
          { storedProfileId: 'flowbit', storedModel: 'mimo-v2.5' }
        )
      ).toEqual({
        profileId: 'flowbit',
        model: 'mimo-v2.5',
        source: 'stored_active',
      });
    });

    it('flattenModelChoicesFrom is pure and skips disabled / dedupes models', () => {
      const choices = flattenModelChoicesFrom([
        {
          id: 'a',
          name: '',
          baseUrl: '',
          models: ['m1', 'm1', ' m2 '],
          hasKey: true,
          apiKey: 'k',
        },
        {
          id: 'b',
          name: 'B',
          baseUrl: '',
          models: ['hidden'],
          hasKey: false,
          enabled: false,
        },
      ]);
      expect(choices.map((c) => c.model)).toEqual(['m1', 'm2']);
      // empty name + unknown id → id as label
      expect(choices![0]!.profileName).toBe('a');
      expect(choices.every((c) => c.hasKey)).toBe(true);
      expect(flattenModelChoicesFrom(null)).toEqual([]);
    });

    it('pure helpers do not touch localStorage or emit side effects', () => {
      localStorage.setItem('crish_active_model_id', 'should-stay');
      const before = localStorage.getItem('crish_provider_profiles_v1');

      pickDefaultModelSelection(
        [{ id: 'z', name: 'Z', baseUrl: '', models: ['m'], hasKey: false }],
        { engineModel: 'mimo-v2.5' }
      );
      normalizeProviderProfiles([{ id: 'z', models: ['a', 'a'] }]);
      mergeModelIds(['x'], ['y']);
      isEmptyModelCatalog([]);
      profileDisplayLabel('deepseek');

      expect(localStorage.getItem('crish_active_model_id')).toBe('should-stay');
      expect(localStorage.getItem('crish_provider_profiles_v1')).toBe(before);
    });

    it('loadProfiles persists model id dedupe cleanup', () => {
      localStorage.setItem(
        'crish_provider_profiles_v1',
        JSON.stringify([
          {
            id: 'p1',
            name: 'P1',
            baseUrl: 'https://x',
            models: ['a', 'a', ' b ', 'b'],
            hasKey: true,
          },
        ])
      );
      const loaded = loadProfiles();
      expect(loaded![0]!.models).toEqual(['a', 'b']);
      const stored = JSON.parse(
        localStorage.getItem('crish_provider_profiles_v1')!
      );
      expect(stored[0]!.models).toEqual(['a', 'b']);
    });

    it('addModelToProfile uses merge/dedupe', () => {
      saveProfiles([
        {
          id: 'p1',
          name: 'P1',
          baseUrl: 'https://x',
          models: ['a'],
          hasKey: false,
        },
      ]);
      addModelToProfile('p1', '  a  ');
      addModelToProfile('p1', 'b');
      addModelToProfile('p1', '');
      expect(loadProfiles()![0]!.models).toEqual(['a', 'b']);
    });
  });
});
