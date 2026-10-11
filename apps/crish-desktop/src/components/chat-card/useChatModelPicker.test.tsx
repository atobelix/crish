// @vitest-environment jsdom
/**
 * §3.6#4：useChatModelPicker 依赖 catalogVersion，yaml 变时重算 needsModelSetup。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useLayoutEffect, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import {
  ensureModelsCatalogLoaded,
  modelsCatalogStore,
  resetModelsCatalogMirror,
} from '../../api/modelsCatalogStore';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';
import {
  setActiveModelId,
  setActiveProfileId,
} from '../../api/providerProfiles';
import { useChatModelPicker } from './useChatModelPicker';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, './useChatModelPicker.ts'), 'utf8');
const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';
const PROFILES_KEY = 'crish_provider_profiles_v1';

vi.mock('../../api/engineConfig', () => ({
  fetchEngineStatus: vi.fn(async () => ({
    ok: true,
    connected: true,
    hasApiKey: true,
    model: 'old-id',
  })),
}));

vi.mock('../../services/toast/ToastContext', () => ({
  toast: { show: vi.fn() },
}));

function workbenchReadOk(providers: Record<string, ProviderSpec>) {
  return {
    path: CATALOG_PATH,
    content: '',
    template: '',
    revision: 'revision-0',
    credentialStates: {},
    parseError: null,
    tree: { version: 2, activeModel: null, providers },
  };
}

function spec(models: Array<{ id: string }>): ProviderSpec {
  return {
    displayName: 'Acme',
    baseUrl: 'https://example.invalid/v1',
    protocol: 'openai/chat',
    models: models.map((m) => ({ id: m.id, displayName: m.id })),
  };
}

async function loadProviders(
  providers: Record<string, ProviderSpec>
): Promise<void> {
  mockTauriCommand('workbench_read_models_yaml', () =>
    workbenchReadOk(providers)
  );
  mockTauriCommand('workbench_save_models_yaml', () => ({ path: CATALOG_PATH }));
  const res = await ensureModelsCatalogLoaded(true);
  expect(res.ok).toBe(true);
}

function seedLsKeyedProfile(models: string[]): void {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify([
      {
        id: 'acme',
        name: 'Acme',
        baseUrl: 'https://example.invalid/v1',
        hasKey: true,
        enabled: true,
        models,
      },
    ])
  );
}

describe('useChatModelPicker 源码形状（§3.6#4）', () => {
  it('依赖 catalogVersion + listLivePickerEntries，不订 useModelMetaTick', () => {
    expect(SRC).toMatch(/useModelsCatalogVersion/);
    expect(SRC).toMatch(/catalogVersion/);
    expect(SRC).toMatch(/listLivePickerEntries/);
    expect(SRC).not.toMatch(/useModelMetaTick/);
    expect(SRC).not.toMatch(/getModelMeta/);
    expect(SRC).not.toMatch(/loadProfiles/);
  });
});

describe('useChatModelPicker catalogVersion → needsModelSetup', () => {
  beforeEach(() => {
    localStorage.clear();
    resetModelsCatalogMirror();
    setActiveProfileId('acme');
    setActiveModelId('old-id');
    seedLsKeyedProfile(['ls-seed-model', 'old-id']);
  });

  afterEach(() => {
    resetModelsCatalogMirror();
    localStorage.clear();
  });

  it('yaml 未加载时即使 LS 有种子模型，needsModelSetup 仍为 true', async () => {
    const { result } = renderHook(() => useChatModelPicker({ projectTick: 0 }));
    await waitFor(() => {
      expect(result.current.engineHint).not.toBeNull();
    });
    expect(result.current.needsModelSetup).toBe(true);
    expect(result.current.engineModel).not.toBe('ls-seed-model');
  });

  it('首次渲染和订阅安装之间目录更新时仍能刷新模型可用状态', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => {
      useLayoutEffect(() => {
        modelsCatalogStore.acceptSnapshot(
          workbenchReadOk({ acme: spec([{ id: 'old-id' }]) })
        );
      }, []);
      return children;
    };

    const { result } = renderHook(
      () => useChatModelPicker({ projectTick: 0 }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.needsModelSetup).toBe(false);
      expect(result.current.engineModel).toBe('old-id');
    });
  });

  it('yaml 列出模型后 needsModelSetup 变为 false', async () => {
    const { result } = renderHook(() => useChatModelPicker({ projectTick: 0 }));
    await waitFor(() => {
      expect(result.current.needsModelSetup).toBe(true);
    });

    await act(async () => {
      await loadProviders({
        acme: spec([{ id: 'old-id' }]),
      });
    });
    await waitFor(() => {
      expect(result.current.needsModelSetup).toBe(false);
      expect(result.current.engineModel).toBe('old-id');
    });
  });

  it('删除 yaml 中全部模型后重算 needsModelSetup=true（不信 LS 列表）', async () => {
    await loadProviders({
      acme: spec([{ id: 'old-id' }]),
    });
    const { result } = renderHook(() => useChatModelPicker({ projectTick: 0 }));
    await waitFor(() => {
      expect(result.current.needsModelSetup).toBe(false);
    });

    await act(async () => {
      await loadProviders({ acme: spec([]) });
    });
    await waitFor(() => {
      expect(result.current.needsModelSetup).toBe(true);
      expect(result.current.engineModel).toBe('');
    });
  });
});
