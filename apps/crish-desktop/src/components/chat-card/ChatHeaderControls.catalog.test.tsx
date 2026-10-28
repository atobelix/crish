// @vitest-environment jsdom
/**
 * §3.6#3：ChatHeaderControls / useModelSelection 订 catalog-changed，
 * 删除/改名后重解析当前标签；禁止跨厂商同名跳转；禁止回落 LS 种子。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import {
  ensureModelsCatalogLoaded,
  resetModelsCatalogMirror,
} from '../../api/modelsCatalogStore';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';
import { emitUiEvent } from '../../api/uiEvents';
import {
  setActiveModelId,
  setActiveProfileId,
} from '../../api/providerProfiles';
import {
  resolveHeaderModelFromCatalog,
  useModelSelection,
} from './ChatHeaderControls';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  resolve(__dirname, './ChatHeaderControls.tsx'),
  'utf8'
);
const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

vi.mock('../../api/engineConfig', () => ({
  fetchEngineStatus: vi.fn(async () => ({
    ok: true,
    connected: true,
    hasApiKey: true,
    model: 'old-id',
  })),
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

function mockReadOk(providers: Record<string, ProviderSpec>): void {
  mockTauriCommand('workbench_read_models_yaml', () =>
    workbenchReadOk(providers)
  );
}

function spec(
  models: Array<{ id: string; enabled?: boolean }>,
  enabled?: boolean
): ProviderSpec {
  return {
    displayName: 'fixture',
    baseUrl: 'https://example.invalid/v1',
    protocol: 'openai/chat',
    ...(enabled === false ? { enabled: false } : {}),
    models: models.map((m) => ({
      id: m.id,
      displayName: m.id,
      ...(m.enabled === false ? { enabled: false } : {}),
    })),
  };
}

async function loadProviders(
  providers: Record<string, ProviderSpec>
): Promise<void> {
  mockReadOk(providers);
  mockTauriCommand('workbench_save_models_yaml', () => ({
    path: CATALOG_PATH,
  }));
  const res = await ensureModelsCatalogLoaded(true);
  expect(res.ok).toBe(true);
}

describe('ChatHeaderControls 源码形状（§3.6#3）', () => {
  it('订 useModelsCatalogVersion / models-catalog-changed，不订 useModelMetaTick', () => {
    expect(SRC).toMatch(/useModelsCatalogVersion/);
    expect(SRC).toMatch(/catalogVersion/);
    expect(SRC).not.toMatch(/useModelMetaTick/);
    expect(SRC).not.toMatch(/selectModelGlobally/);
    expect(SRC).not.toMatch(/resolvePreferredModelSelection/);
    expect(SRC).not.toMatch(/resolveDisplayModelId/);
    expect(SRC).toMatch(/getLiveModel/);
    expect(SRC).toMatch(/listLivePickerEntries/);
  });
});

describe('resolveHeaderModelFromCatalog', () => {
  beforeEach(() => {
    localStorage.clear();
    resetModelsCatalogMirror();
  });

  afterEach(() => {
    resetModelsCatalogMirror();
    localStorage.clear();
  });

  it('未加载时不回落 LS 种子 id', async () => {
    setActiveProfileId('opencode-go');
    setActiveModelId('deepseek-v4-flash');
    expect(
      resolveHeaderModelFromCatalog({
        profileId: 'opencode-go',
        storedModel: 'deepseek-v4-flash',
      })
    ).toEqual({ profileId: 'opencode-go', model: '' });
  });

  it('当前模型仍在 yaml → 保留原标签', async () => {
    await loadProviders({
      acme: spec([{ id: 'old-id' }, { id: 'keep-id' }]),
    });
    expect(
      resolveHeaderModelFromCatalog({
        profileId: 'acme',
        storedModel: 'old-id',
      })
    ).toEqual({ profileId: 'acme', model: 'old-id' });
  });

  it('删除当前模型后同厂商自愈到剩余项', async () => {
    await loadProviders({
      acme: spec([{ id: 'keep-id' }]),
      other: spec([{ id: 'old-id' }]),
    });
    expect(
      resolveHeaderModelFromCatalog({
        profileId: 'acme',
        storedModel: 'old-id',
      })
    ).toEqual({ profileId: 'acme', model: 'keep-id' });
  });

  it('改名（旧 id 消失、新 id 同厂商）→ 徽标落到新 id', async () => {
    await loadProviders({
      acme: spec([{ id: 'new-id' }]),
    });
    expect(
      resolveHeaderModelFromCatalog({
        profileId: 'acme',
        storedModel: 'old-id',
      })
    ).toEqual({ profileId: 'acme', model: 'new-id' });
  });

  it('同厂商删空 → 置空，不得跳到另一供应商的同名模型', async () => {
    await loadProviders({
      acme: spec([]),
      other: spec([{ id: 'old-id' }]),
    });
    expect(
      resolveHeaderModelFromCatalog({
        profileId: 'acme',
        storedModel: 'old-id',
        engineModel: 'old-id',
      })
    ).toEqual({ profileId: 'acme', model: '' });
  });
});

describe('useModelSelection catalog-changed', () => {
  beforeEach(() => {
    localStorage.clear();
    resetModelsCatalogMirror();
    setActiveProfileId('acme');
    setActiveModelId('old-id');
  });

  afterEach(() => {
    resetModelsCatalogMirror();
    localStorage.clear();
  });

  it('emit models-catalog-changed 后删除旧 id：徽标自愈到同厂商剩余项', async () => {
    await loadProviders({
      acme: spec([{ id: 'old-id' }, { id: 'keep-id' }]),
    });
    const { result } = renderHook(() => useModelSelection(undefined, 0));
    await waitFor(() => {
      expect(result.current.engineModel).toBe('old-id');
    });

    await act(async () => {
      await loadProviders({
        acme: spec([{ id: 'keep-id' }]),
      });
    });
    await waitFor(() => {
      expect(result.current.engineModel).toBe('keep-id');
      expect(result.current.activeProfileId).toBe('acme');
    });
  });

  it('只 emit model-meta-changed 不足以重解析（负例）', async () => {
    await loadProviders({
      acme: spec([{ id: 'old-id' }]),
    });
    const { result } = renderHook(() => useModelSelection(undefined, 0));
    await waitFor(() => {
      expect(result.current.engineModel).toBe('old-id');
    });

    act(() => {
      emitUiEvent('model-meta-changed', {
        profileId: 'acme',
        model: 'ghost',
        enabled: false,
        displayName: '不该用这条',
      });
    });
    expect(result.current.engineModel).toBe('old-id');
  });

  it('加载失败时空标签，不展示 LS 种子', async () => {
    setActiveProfileId('opencode-go');
    setActiveModelId('deepseek-v4-flash');
    const { result } = renderHook(() => useModelSelection(undefined, 0));
    await waitFor(() => {
      expect(result.current.engineModel).toBe('');
    });
    expect(result.current.engineModel).not.toBe('deepseek-v4-flash');
  });
});
