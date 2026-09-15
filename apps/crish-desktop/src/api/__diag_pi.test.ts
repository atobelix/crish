// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../test-setup';
import { modelsCatalogStore } from './modelsCatalogStore';
import { applyIncrementalProbe } from './probeIncremental';
import type { ProviderSpec } from './modelsCatalogTypes';

const sampleProvider: ProviderSpec = {
  displayName: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  protocol: 'openai/chat',
  models: [
    {
      id: 'deepseek-v4-flash',
      displayName: '用户手动改写的显示名',
      contextWindow: 2_000_000,
      maxOutputTokens: 500_000,
      thinking: { CustomLevel: 'custom_wire' },
      pricing: { currency: 'CNY', unit: 'per_1m_tokens', input: 0.88, output: 2.88, cacheRead: 0.05 },
    },
  ],
};

describe('diag probeIncremental', () => {
  it('diag', async () => {
    modelsCatalogStore.resetForTesting();
    const providers = { deepseek: { ...sampleProvider, models: [...sampleProvider.models] } };
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: 'C:\\Users\\tester\\.conex\\models.yaml',
      content: '',
      template: '',
      revision: 'revision-0',
      credentialStates: {},
      parseError: null,
      tree: { version: 2, activeModel: null, providers },
    }));
    mockTauriCommand('workbench_apply_models_config', (args) => {
      const { tree } = args as { tree: unknown };
      return {
        path: 'C:\\Users\\tester\\.conex\\models.yaml',
        revision: 'revision-1',
        content: '',
        template: '',
        credentialStates: {},
        parseError: null,
        tree,
      };
    });
    const loaded = await modelsCatalogStore.ensureLoaded(true);
    console.log('loaded =', loaded);
    console.log('lastError =', JSON.stringify(modelsCatalogStore.getState().lastError));
    console.log('thinking now =', JSON.stringify(modelsCatalogStore.getState().tree.providers.deepseek?.models[0]?.thinking));
    expect(true).toBe(true);
    void applyIncrementalProbe;
  });
});
