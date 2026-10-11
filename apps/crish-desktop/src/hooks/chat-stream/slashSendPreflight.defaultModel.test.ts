// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import { modelsCatalogStore } from '../../api/modelsCatalogStore';
import {
  routeModelPickerPreflight,
  shouldPickModelInChat,
} from '../../api/modelPickerAvailability';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

function provider(models: ProviderSpec['models']): ProviderSpec {
  return {
    displayName: 'Acme',
    baseUrl: 'https://example.invalid/v1',
    protocol: 'openai/chat',
    enabled: true,
    stream: true,
    models,
  };
}

async function loadTree(
  activeModel: { providerId: string; modelId: string } | null,
  options: {
    providers?: Record<string, ProviderSpec>;
    credentialStates?: Record<string, { hasKey: boolean }>;
  } = {},
) {
  modelsCatalogStore.resetForTesting();
  localStorage.clear();
  mockTauriCommand('workbench_read_models_yaml', () => ({
    path: CATALOG_PATH,
    content: '',
    template: '',
    revision: 'revision-0',
    credentialStates: options.credentialStates ?? {},
    parseError: null,
    tree: {
      version: 2,
      activeModel,
      providers: options.providers ?? {
        acme: provider([{ id: 'acme-on', displayName: 'On', enabled: true }]),
      },
    },
  }));
  await modelsCatalogStore.ensureLoaded(true);
}

describe('未指定默认模型不阻断对话选择', () => {
  afterEach(() => {
    modelsCatalogStore.resetForTesting();
    localStorage.clear();
  });

  it('已有模型且未指定默认时，在对话里选', async () => {
    await loadTree(null, { credentialStates: { acme: { hasKey: true } } });
    expect(shouldPickModelInChat()).toBe(true);
  });

  it('已经指定默认模型时，不再要求对话里重选', async () => {
    await loadTree(
      { providerId: 'acme', modelId: 'acme-on' },
      { credentialStates: { acme: { hasKey: true } } },
    );
    expect(shouldPickModelInChat()).toBe(false);
  });

  it('有启用模型但没有可用凭据时，不打开空选择器', async () => {
    await loadTree(null);
    expect(shouldPickModelInChat()).toBe(false);
  });

  it('已配置供应商没有启用模型时，其他无凭据模型不算可选项', async () => {
    await loadTree(null, {
      providers: {
        configured: provider([]),
        unconfigured: provider([
          { id: 'unconfigured-model', displayName: '未配置模型', enabled: true },
        ]),
      },
      credentialStates: { configured: { hasKey: true } },
    });
    expect(shouldPickModelInChat()).toBe(false);
  });

  it('仅 S2 缺少默认模型时展示行内错误并打开对话选择器', async () => {
    await loadTree(null, { credentialStates: { acme: { hasKey: true } } });
    const setPickerInlineError = vi.fn();
    const onOpenModelPicker = vi.fn();

    expect(
      routeModelPickerPreflight('S2', {
        setPickerInlineError,
        onOpenModelPicker,
      })
    ).toBe(true);
    expect(setPickerInlineError).toHaveBeenCalledWith('请先选择要使用的模型');
    expect(onOpenModelPicker).toHaveBeenCalledTimes(1);

    expect(
      routeModelPickerPreflight('S1', {
        setPickerInlineError,
        onOpenModelPicker,
      })
    ).toBe(false);
  });
});
