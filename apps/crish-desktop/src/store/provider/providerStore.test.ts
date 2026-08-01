import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enableMapSet } from 'immer';

enableMapSet();

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

// T06.9.2：providerStore 不再直连网络——mock api 层，断言 store 只经 api 调用
const { refreshAccountStatusMock } = vi.hoisted(() => ({
  refreshAccountStatusMock: vi.fn(),
}));

vi.mock('../../api/accountStatusApi', () => ({
  refreshAccountStatus: refreshAccountStatusMock,
}));

import { useProviderStore } from './providerStore';
import { refreshAccountStatus as apiRefreshAccountStatus } from '../../api/accountStatusApi';
import type { ProviderConfig, ModelMeta, Account } from './types';

describe('providerStore', () => {
  beforeEach(() => {
    localStorage.clear();
    refreshAccountStatusMock.mockReset();
    useProviderStore.setState({
      providers: new Map(),
      activeProviderId: null,
      routes: [],
      accounts: [],
      healthStatus: new Map(),
    });
  });

  describe('Provider Management (API Key & BaseURL)', () => {
    it('adds and sets active provider', () => {
      const config: ProviderConfig = {
        id: 'provider-1',
        name: 'OpenAI Test',
        type: 'openai',
        apiKey: 'sk-test-key-123',
        baseUrl: 'https://api.custom-openai.com/v1',
        enabled: true,
        models: [],
      };

      useProviderStore.getState().addProvider(config);
      const providers = useProviderStore.getState().providers;
      expect(providers.has('provider-1')).toBe(true);
      expect(providers.get('provider-1')?.apiKey).toBe('sk-test-key-123');

      useProviderStore.getState().setActiveProvider('provider-1');
      expect(useProviderStore.getState().activeProviderId).toBe('provider-1');
    });

    it('updates provider API Key and BaseURL with timestamp update', () => {
      const config: ProviderConfig = {
        id: 'p1',
        name: 'Anthropic',
        type: 'anthropic',
        apiKey: 'old-key',
        baseUrl: 'https://api.anthropic.com',
        enabled: true,
        models: [],
      };
      useProviderStore.getState().addProvider(config);

      useProviderStore.getState().updateProvider('p1', {
        apiKey: 'new-sk-ant-key',
        baseUrl: 'https://custom-proxy.internal/anthropic',
      });

      const updated = useProviderStore.getState().providers.get('p1');
      expect(updated?.apiKey).toBe('new-sk-ant-key');
      expect(updated?.baseUrl).toBe('https://custom-proxy.internal/anthropic');
      expect(updated?.updatedAt).toBeDefined();
    });

    it('removes provider and clears activeProviderId if matched', () => {
      const config: ProviderConfig = {
        id: 'p-to-del',
        name: 'To Delete',
        type: 'ollama',
        enabled: true,
        models: [],
      };
      useProviderStore.getState().addProvider(config);
      useProviderStore.getState().setActiveProvider('p-to-del');

      useProviderStore.getState().removeProvider('p-to-del');
      expect(useProviderStore.getState().providers.has('p-to-del')).toBe(false);
      expect(useProviderStore.getState().activeProviderId).toBeNull();
    });
  });

  describe('Model Catalog Sync & Operations', () => {

    it('adds, updates, and removes model meta in provider', () => {
      const provider: ProviderConfig = {
        id: 'p-models',
        name: 'DeepSeek',
        type: 'openai-compatible',
        enabled: true,
        models: [],
      };
      useProviderStore.getState().addProvider(provider);

      const model: ModelMeta = {
        id: 'deepseek-chat',
        name: 'DeepSeek V3',
        contextWindow: 64000,
        maxTokens: 4096,
      };

      useProviderStore.getState().addModel('p-models', model);
      let p = useProviderStore.getState().providers.get('p-models');
      expect(p?.models).toHaveLength(1);
      expect(p?.models[0].name).toBe('DeepSeek V3');

      useProviderStore.getState().updateModel('p-models', 'deepseek-chat', {
        name: 'DeepSeek-V3 Pro',
        contextWindow: 128000,
      });
      p = useProviderStore.getState().providers.get('p-models');
      expect(p?.models[0].name).toBe('DeepSeek-V3 Pro');
      expect(p?.models[0].contextWindow).toBe(128000);

      useProviderStore.getState().removeModel('p-models', 'deepseek-chat');
      p = useProviderStore.getState().providers.get('p-models');
      expect(p?.models).toHaveLength(0);
    });
  });

  describe('Health Check Probe Updates', () => {
    it('sets health status for provider probe', () => {
      useProviderStore.getState().setHealthStatus('p1', {
        healthy: true,
        latencyMs: 142,
        lastChecked: 1700000000000,
      });

      const statusMap = useProviderStore.getState().healthStatus;
      expect(statusMap.get('p1')).toEqual({
        healthy: true,
        latencyMs: 142,
        lastChecked: 1700000000000,
      });
    });
  });

  describe('Account Management & Health Refresh', () => {
    it('adds, updates, and removes account', () => {
      const account: Account = {
        id: 'acc-1',
        name: 'Primary OpenAI Account',
        providerId: 'provider-1',
        status: 'active',
        priority: 1,
      };

      useProviderStore.getState().addAccount(account);
      expect(useProviderStore.getState().accounts).toHaveLength(1);

      useProviderStore.getState().updateAccount('acc-1', { priority: 2, status: 'cooldown' });
      expect(useProviderStore.getState().accounts[0].priority).toBe(2);
      expect(useProviderStore.getState().accounts[0].status).toBe('cooldown');

      useProviderStore.getState().removeAccount('acc-1');
      expect(useProviderStore.getState().accounts).toHaveLength(0);
    });

    it('refreshes account status via api layer with success and error fallbacks', async () => {
      const account: Account = {
        id: 'acc-fetch',
        name: 'Account Fetch Test',
        providerId: 'p1',
        status: 'active',
      };
      useProviderStore.getState().addAccount(account);

      // 成功路径：api 返回类型化结果 → store 落字段
      refreshAccountStatusMock.mockResolvedValueOnce({
        status: 'active',
        usageScore: 95,
        cooldownUntil: 0,
      });
      await useProviderStore.getState().refreshAccountStatus('acc-fetch');
      const acc = useProviderStore.getState().accounts[0];
      expect(acc.lastCheckedAt).toBeDefined();
      expect(acc.usageScore).toBe(95);

      // 调用路径断言：store 只经 api 层，无裸 fetch
      expect(apiRefreshAccountStatus).toHaveBeenCalledWith('acc-fetch');
      expect(refreshAccountStatusMock).toHaveBeenCalledWith('acc-fetch');

      // 失败路径：api 抛错 → store 置 error 态
      refreshAccountStatusMock.mockRejectedValueOnce(new Error('Network error'));
      await useProviderStore.getState().refreshAccountStatus('acc-fetch');
      expect(useProviderStore.getState().accounts[0].status).toBe('error');
    });
  });
});
