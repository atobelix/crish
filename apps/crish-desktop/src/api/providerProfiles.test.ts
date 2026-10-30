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
    model: null,
    hasApiKey: true,
  })),
}));

// 密钥写入走 DPAPI 凭据槽；回执的树快照由 rustProfileStore 内部安装进镜像
vi.mock('./provider-profiles/rustProfileStore', () => ({
  configSecretSet: vi.fn(async (providerId: string, apiKey: string) => ({
    status: 'ok' as const,
    data: {
      ok: true,
      profileId: providerId,
      hasKey: Boolean(apiKey.trim()),
    },
  })),
  configSecretClear: vi.fn(async (profileId: string) => ({
    status: 'ok' as const,
    data: { ok: true, profileId: providerId, hasKey: false },
  })),
  configSecretGet: vi.fn(async (providerId: string) => ({
    status: 'ok' as const,
    data: { ok: true, profileId: providerId, hasKey: false, apiKeyLast4: null },
  })),
  configSecretHas: vi.fn(async (providerId: string) => ({
    status: 'ok' as const,
    data: { ok: true, profileId: providerId, hasKey: false },
  })),
  configSecretReveal: vi.fn(async (providerId: string, uiConfirm: boolean) => ({
    status: 'ok' as const,
    data: {
      ok: true,
      profileId: providerId,
      hasKey: uiConfirm,
      apiKeyLast4: 'st4',
      revealed: uiConfirm,
    },
  })),
}));

// 激活/就绪态只读统一树镜像：单测注入可控 live 面
const liveMock = vi.hoisted(() => ({
  setActiveModel: vi.fn(async () => ({ ok: true, error: '' })),
  ensureLoaded: vi.fn(async () => true),
  getActiveModelRef: vi.fn(() => null),
  getLiveProvider: vi.fn(() => undefined),
  getLiveModel: vi.fn(() => undefined),
  providerHasKey: vi.fn(() => false),
  listLivePickerEntries: vi.fn(() => []),
}));

vi.mock('./modelsCatalogStore', () => ({
  modelsCatalogStore: {
    setActiveModel: liveMock.setActiveModel,
    ensureLoaded: liveMock.ensureLoaded,
    getActiveModelRef: liveMock.getActiveModelRef,
    getState: vi.fn(() => ({
      loaded: true,
      revision: 'rev-1',
      credentialStates: {},
    })),
    acceptSnapshot: vi.fn(),
  },
  getActiveModelRef: liveMock.getActiveModelRef,
}));

vi.mock('./modelsCatalogLive', () => ({
  getLiveProvider: liveMock.getLiveProvider,
  getLiveModel: liveMock.getLiveModel,
  providerHasKey: liveMock.providerHasKey,
  listLivePickerEntries: liveMock.listLivePickerEntries,
  listLiveProviders: vi.fn(() => []),
  anyProviderHasKey: vi.fn(() => false),
}));

import {
  activateProfileModel,
  getProviderSetupStatus,
  loadProfiles,
  removeProfile,
  resolveDisplayModelId,
  resetLegacyMigrationForTests,
  saveProfileKey,
  saveProfiles,
  upsertProfile,
} from './providerProfiles';
import { normalizeProviderProfile } from './provider-profiles/profileValidation';
import { configSecretSet } from './provider-profiles/rustProfileStore';

type LiveOverrides = {
  /** getLiveProvider 返回值（null = 供应商不存在；缺省 = {id:'p1'}） */
  provider?: unknown;
  /** getLiveModel 返回值（null = 模型不存在；缺省 = {id:'m1'}） */
  model?: unknown;
  hasKey?: boolean;
  activeRef?: { providerId: string; modelId: string } | null;
  entries?: unknown[];
};

function seedLive(o: LiveOverrides = {}): void {
  liveMock.getLiveProvider.mockImplementation(
    () => ('provider' in o ? o.provider : { id: 'p1' }) as never
  );
  liveMock.getLiveModel.mockImplementation(
    () => ('model' in o ? o.model : { id: 'm1' }) as never
  );
  liveMock.providerHasKey.mockReturnValue(o.hasKey ?? false);
  liveMock.getActiveModelRef.mockReturnValue((o.activeRef ?? null) as never);
  liveMock.listLivePickerEntries.mockReturnValue((o.entries ?? []) as never);
  liveMock.setActiveModel.mockResolvedValue({ ok: true, error: '' });
  liveMock.ensureLoaded.mockResolvedValue(true);
}

const LIVE_P1 = { provider: { id: 'p1' }, model: { id: 'm1' } };

describe('providerProfiles（OAuth 档案轨 + 激活单轨）', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLegacyMigrationForTests();
    vi.clearAllMocks();
    seedLive();
  });

  it('loadProfiles：空库不播种，返回空列表', () => {
    expect(loadProfiles()).toEqual([]);
    expect(localStorage.getItem('crish_provider_profiles_v1')).toBeNull();
  });

  it('saveProfiles → loadProfiles 往返：normalize 剥离明文 apiKey，仅留 hasKey', () => {
    saveProfiles([
      normalizeProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://x',
        models: [' a ', 'a', 'b'],
        apiKey: 'sk-plain',
        hasKey: true,
      }),
    ]);
    const raw = localStorage.getItem('crish_provider_profiles_v1') ?? '';
    expect(raw).not.toContain('sk-plain');
    const list = loadProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'openai',
      models: ['a', 'b'],
      hasKey: true,
    });
  });

  it('upsertProfile / removeProfile：OAuth 档案增删', () => {
    upsertProfile(
      normalizeProviderProfile({ id: 'p1', name: 'P1', models: [] })
    );
    expect(loadProfiles()).toHaveLength(1);
    removeProfile('p1');
    expect(loadProfiles()).toHaveLength(0);
  });

  it('loadProfiles：无密钥的旧种子模型列表被剥离（去 mimo 污染）', () => {
    localStorage.setItem(
      'crish_provider_profiles_v1',
      JSON.stringify([
        {
          id: 'flowbit',
          name: 'Flowbit',
          baseUrl: '',
          models: ['mimo-v2.5'],
          hasKey: false,
        },
      ])
    );
    const list = loadProfiles();
    expect(list[0].models).toEqual([]);
  });

  it('activateProfileModel：树 CAS 写入 activeModel，无密钥 → warning no_local_key', async () => {
    const res = await activateProfileModel('p1', 'm1');
    expect(res).toMatchObject({ ok: true, warning: 'no_local_key' });
    expect(liveMock.setActiveModel).toHaveBeenCalledWith({
      providerId: 'p1',
      modelId: 'm1',
    });
  });

  it('activateProfileModel：供应商或模型不存在 → 显式报错，不写树', async () => {
    seedLive({ provider: null, model: null });
    expect(await activateProfileModel('ghost', 'm1')).toMatchObject({
      ok: false,
      error: 'profile_not_found',
    });
    expect(liveMock.setActiveModel).not.toHaveBeenCalled();

    seedLive({ ...LIVE_P1, model: null });
    expect(await activateProfileModel('p1', 'ghost-model')).toMatchObject({
      ok: false,
      error: 'model_not_found',
    });
    expect(liveMock.setActiveModel).not.toHaveBeenCalled();
  });

  it('activateProfileModel：CAS 冲突 → 重读真源重试一次', async () => {
    seedLive(LIVE_P1);
    liveMock.setActiveModel
      .mockResolvedValueOnce({ ok: false, error: 'REVISION_CONFLICT' })
      .mockResolvedValueOnce({ ok: true, error: '' });
    const res = await activateProfileModel('p1', 'm1');
    expect(res.ok).toBe(true);
    expect(liveMock.setActiveModel).toHaveBeenCalledTimes(2);
    expect(liveMock.ensureLoaded).toHaveBeenCalledWith(true);
  });

  it('saveProfileKey：DPAPI 写入后刷新树镜像；活跃供应商属于本服务商 → 重发激活', async () => {
    seedLive({ ...LIVE_P1, activeRef: { providerId: 'p1', modelId: 'm1' } });
    const res = await saveProfileKey('p1', 'sk-live-1');
    expect(res).toMatchObject({ ok: true, synced: true });
    expect(configSecretSet).toHaveBeenCalledWith('p1', 'sk-live-1');
    expect(liveMock.ensureLoaded).toHaveBeenCalledWith(true);
    expect(liveMock.setActiveModel).toHaveBeenCalled();
  });

  it('saveProfileKey：非活跃供应商 → 只落凭据槽，不触发激活', async () => {
    seedLive({ activeRef: { providerId: 'other', modelId: 'm9' } });
    const res = await saveProfileKey('p1', 'sk-live-2');
    expect(res).toEqual({ ok: true, synced: true });
    expect(liveMock.setActiveModel).not.toHaveBeenCalled();
  });

  it('resolveDisplayModelId：树活跃优先，回落引擎模型', () => {
    seedLive({ activeRef: { providerId: 'p1', modelId: 'm1' } });
    expect(resolveDisplayModelId('engine-model')).toBe('m1');
    seedLive({});
    expect(resolveDisplayModelId('engine-model')).toBe('engine-model');
    expect(resolveDisplayModelId(null)).toBe('');
  });

  it('getProviderSetupStatus：无密钥 → needsKeySetup；有密钥有名单 → 可选模型', () => {
    seedLive({});
    expect(getProviderSetupStatus({})).toMatchObject({
      needsKeySetup: true,
      needsModelSetup: false,
      showModelPicker: true,
    });

    seedLive({
      entries: [{ providerId: 'p1', provider: {}, model: {} }],
      hasKey: true,
    });
    expect(getProviderSetupStatus({})).toMatchObject({
      hasLocalKey: true,
      needsKeySetup: false,
      hasLocalModel: true,
    });
  });
});
