// useWebSearchSettingsVm.test.ts：移动端网页搜索设置 ViewModel 单元测试
// 严格测试：状态机联动、Key 掩码格式化、连通性探测流程模拟与引擎列表排序

import { act, renderHook, waitFor } from '@testing-library/react-native';
import {
  formatMaskedKey,
  useWebSearchSettingsVm,
} from './useWebSearchSettingsVm';
import {
  resetSearchSettingsForTest,
  useSearchSettingsStore,
} from '@/domain/store/searchSettingsStore';
import { WebSearchKeyManager } from '@/domain/store/searchKeyManager';
import type { SecureStoreDriver } from '@/db/secureStore';
import * as providersModule from '@/adapters/webSearch/providers';

describe('useWebSearchSettingsVm', () => {
  let mockSecureStorage: Record<string, string>;
  let mockDriver: SecureStoreDriver;
  let testKeyManager: WebSearchKeyManager;

  beforeEach(() => {
    // 重置 Zustand store
    resetSearchSettingsForTest();

    // 内存态 SecureStoreDriver Mock
    mockSecureStorage = {};
    mockDriver = {
      getItem: jest.fn(async (key: string) => mockSecureStorage[key] ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        mockSecureStorage[key] = value;
      }),
      deleteItem: jest.fn(async (key: string) => {
        delete mockSecureStorage[key];
      }),
    };

    // 单例 KeyManager 重置与注入
    testKeyManager = WebSearchKeyManager.getInstance(mockDriver);
    testKeyManager.resetForTest();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('formatMaskedKey 纯函数掩码格式化', () => {
    it('处理空串与异常类型安全返回空串', () => {
      expect(formatMaskedKey('')).toBe('');
      expect(formatMaskedKey('   ')).toBe('');
      expect(formatMaskedKey(null as any)).toBe('');
      expect(formatMaskedKey(undefined as any)).toBe('');
    });

    it('超短 Key (<= 4 字符) 全部掩码处理', () => {
      expect(formatMaskedKey('1234')).toBe('••••');
      expect(formatMaskedKey('abc')).toBe('•••');
    });

    it('短 Key (5 ~ 8 字符) 保留前 2 后 2', () => {
      expect(formatMaskedKey('12345678')).toBe('12...78');
      expect(formatMaskedKey('abcdef')).toBe('ab...ef');
    });

    it('标准 API Key 正确格式化为 sk-tavi...9a2b 形式', () => {
      const key = 'sk-tavily-12345-9a2b';
      expect(formatMaskedKey(key)).toBe('sk-tavi...9a2b');
    });

    it('多 Key 换行或逗号输入时取首个 Key 进行掩码输出', () => {
      const multiline = 'sk-tavily-12345-9a2b\nsk-tavily-67890-c4d5';
      expect(formatMaskedKey(multiline)).toBe('sk-tavi...9a2b');

      const commaSeparated = 'tvly-abcdefghij-9999, tvly-other-key';
      expect(formatMaskedKey(commaSeparated)).toBe('tvly-ab...9999');
    });
  });

  describe('ViewModel 基础状态与偏好切换联动', () => {
    it('初始化具备正确的默认值', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      expect(result.current.enabled).toBe(true);
      expect(result.current.modelToolsPreferred).toBe(true);
      expect(result.current.selectedProvider).toBe('tavily');
      expect(result.current.maxTokens).toBe(4000);
      expect(result.current.freeEnginesOrder).toEqual([
        'wikipedia',
        'duckduckgo',
        'baidu',
      ]);
      expect(result.current.availableProviders).toHaveLength(6);
      expect(result.current.tokenOptions).toEqual([2000, 4000, 8000]);
    });

    it('toggleEnabled 切换全局开关', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      await act(async () => {
        result.current.toggleEnabled();
      });
      await waitFor(() => expect(result.current.enabled).toBe(false));

      await act(async () => {
        result.current.toggleEnabled(true);
      });
      await waitFor(() => expect(result.current.enabled).toBe(true));
    });

    it('toggleModelToolsPreferred 切换原生模型工具优先开关', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      await act(async () => {
        result.current.toggleModelToolsPreferred();
      });
      await waitFor(() =>
        expect(result.current.modelToolsPreferred).toBe(false)
      );

      await act(async () => {
        result.current.toggleModelToolsPreferred(true);
      });
      await waitFor(() =>
        expect(result.current.modelToolsPreferred).toBe(true)
      );
    });

    it('selectProvider 选择首选服务商', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      await act(async () => {
        result.current.selectProvider('jina');
      });
      await waitFor(() => expect(result.current.selectedProvider).toBe('jina'));
      expect(useSearchSettingsStore.getState().selectedByokProvider).toBe(
        'jina'
      );
    });

    it('setMaxTokens 更新提取 Token 上限', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      await act(async () => {
        result.current.setMaxTokens(8000);
      });
      await waitFor(() => expect(result.current.maxTokens).toBe(8000));
      expect(useSearchSettingsStore.getState().maxTokensPerFetch).toBe(8000);
    });
  });

  describe('Key 安全存储与掩码获取', () => {
    it('未配置 Key 时 getMaskedKey 返回空串，keyPresence 为 false', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      await act(async () => {
        await result.current.refreshKeys();
      });

      expect(result.current.getMaskedKey('tavily')).toBe('');
      expect(result.current.keyPresence['tavily']).toBeFalsy();
    });

    it('saveKey 成功落盘 SecureStore，且更新掩码与 keyPresence 状态', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      await act(async () => {
        await result.current.saveKey('tavily', 'sk-tavily-12345-9a2b');
      });

      await waitFor(() => {
        expect(result.current.getMaskedKey('tavily')).toBe('sk-tavi...9a2b');
        expect(result.current.keyPresence['tavily']).toBe(true);
      });

      expect(mockDriver.setItem).toHaveBeenCalledWith(
        'websearch.key.tavily',
        'sk-tavily-12345-9a2b'
      );
    });

    it('getMaskedKey 支持直接对 rawKey 字符串进行脱敏输出', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      expect(result.current.getMaskedKey('sk-tavily-12345-9a2b')).toBe(
        'sk-tavi...9a2b'
      );
    });
  });

  describe('checkProviderHealth 连通性测试流程模拟', () => {
    it('服务商不存在时返回对应错误', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      let healthResult: any;
      await act(async () => {
        healthResult = await result.current.checkProviderHealth('non-existent');
      });

      expect(healthResult.ok).toBe(false);
      expect(healthResult.error).toContain('未找到服务商: non-existent');
    });

    it('商业服务商未配置 API Key 时返回错误', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      let healthResult: any;
      await act(async () => {
        healthResult = await result.current.checkProviderHealth('tavily');
      });

      expect(healthResult.ok).toBe(false);
      expect(healthResult.error).toBe('未配置 API Key');
    });

    it('成功调用 Adapter.checkHealth 并在状态中记录毫秒延迟', async () => {
      const mockAdapter: any = {
        id: 'tavily',
        name: 'Tavily Search',
        search: jest.fn(),
        checkHealth: jest.fn(async () => ({ ok: true, latencyMs: 168 })),
      };

      jest
        .spyOn(providersModule, 'getSearchProvider')
        .mockReturnValue(mockAdapter);

      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      await act(async () => {
        await result.current.saveKey('tavily', 'tvly-secret-123456');
      });

      let healthResult: any;
      await act(async () => {
        healthResult = await result.current.checkProviderHealth('tavily');
      });

      expect(mockAdapter.checkHealth).toHaveBeenCalledWith(
        'tvly-secret-123456'
      );
      expect(healthResult.ok).toBe(true);
      expect(healthResult.latencyMs).toBe(168);
      await waitFor(() => {
        expect(result.current.healthResults['tavily']).toEqual({
          ok: true,
          latencyMs: 168,
        });
      });
    });

    it('Adapter.checkHealth 抛出异常时记录失败原因与状态', async () => {
      const mockAdapter: any = {
        id: 'jina',
        name: 'Jina Search',
        search: jest.fn(),
        checkHealth: jest.fn(async () => {
          throw new Error('401 Unauthorized: Invalid API Key');
        }),
      };

      jest
        .spyOn(providersModule, 'getSearchProvider')
        .mockReturnValue(mockAdapter);

      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      await act(async () => {
        await result.current.saveKey('jina', 'jina_invalid_key');
      });

      let healthResult: any;
      await act(async () => {
        healthResult = await result.current.checkProviderHealth('jina');
      });

      expect(healthResult.ok).toBe(false);
      expect(healthResult.error).toContain('401 Unauthorized');
      await waitFor(() => {
        expect(result.current.healthResults['jina']?.ok).toBe(false);
        expect(result.current.healthResults['jina']?.error).toContain(
          '401 Unauthorized'
        );
      });
    });
  });

  describe('免 Key 引擎顺序调整与开关管理', () => {
    it('moveFreeEngine 正确调整引擎排列优先级', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      expect(result.current.freeEnginesOrder).toEqual([
        'wikipedia',
        'duckduckgo',
        'baidu',
      ]);

      await act(async () => {
        result.current.moveFreeEngine(0, 2);
      });

      await waitFor(() => {
        expect(result.current.freeEnginesOrder).toEqual([
          'duckduckgo',
          'baidu',
          'wikipedia',
        ]);
      });
      expect(useSearchSettingsStore.getState().enabledFreeEngines).toEqual([
        'duckduckgo',
        'baidu',
        'wikipedia',
      ]);
    });

    it('moveFreeEngine 超界索引静默忽略', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      await act(async () => {
        result.current.moveFreeEngine(-1, 5);
      });

      expect(result.current.freeEnginesOrder).toEqual([
        'wikipedia',
        'duckduckgo',
        'baidu',
      ]);
    });

    it('toggleFreeEngine 开关切换与 isFreeEngineEnabled', async () => {
      const { result } = await renderHook(() =>
        useWebSearchSettingsVm(testKeyManager)
      );

      expect(result.current.isFreeEngineEnabled('baidu')).toBe(true);

      await act(async () => {
        result.current.toggleFreeEngine('baidu');
      });

      await waitFor(() => {
        expect(result.current.isFreeEngineEnabled('baidu')).toBe(false);
        expect(result.current.freeEnginesOrder).not.toContain('baidu');
      });

      await act(async () => {
        result.current.toggleFreeEngine('baidu');
      });

      await waitFor(() => {
        expect(result.current.isFreeEngineEnabled('baidu')).toBe(true);
        expect(result.current.freeEnginesOrder).toContain('baidu');
      });
    });
  });
});
