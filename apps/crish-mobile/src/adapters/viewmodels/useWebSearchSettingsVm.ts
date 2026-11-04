// useWebSearchSettingsVm：移动端网页搜索设置视图模型
// 依据方案文档：docs/mobile-web-search-and-sandbox/06-分维-状态机演进与SQLite持久化及设置方案.md §5, §6
//
// 核心职责：
// 1. 连接 useSearchSettingsStore 与 WebSearchKeyManager（硬件级凭据物理隔离）；
// 2. 驱动设置中心 UI：原生优先开关、BYOK 服务商卡片、一键连通性探测、免 Key 引擎排序与 Token 截断上限；
// 3. 提供状态流转与纯函数掩码计算。

import { useCallback, useEffect, useState } from 'react';
import { useSearchSettingsStore } from '@/domain/store/searchSettingsStore';
import {
  searchKeyManager,
  WebSearchKeyManager,
} from '@/domain/store/searchKeyManager';
import { getSearchProvider } from '@/adapters/webSearch/providers';

/**
 * 商业服务商展示元数据定义
 */
export interface ByokProviderMeta {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly placeholder: string;
  readonly officialUrl: string;
}

/**
 * 免 Key 开放引擎展示元数据定义
 */
export interface FreeEngineMeta {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
}

/**
 * 默认支持的商业提供商元数据列表
 */
export const AVAILABLE_BYOK_PROVIDERS: readonly ByokProviderMeta[] = [
  {
    id: 'tavily',
    name: 'Tavily Search',
    desc: '专为大模型智能体优化的高质量事实检索 API，原生返回清洗后的问答上下文。',
    placeholder: 'tvly-••••••••',
    officialUrl: 'https://tavily.com',
  },
  {
    id: 'jina',
    name: 'Jina Search',
    desc: '深度网页阅读与搜索 API，支持多源重试与大陆镜像智能容灾。',
    placeholder: 'jina_••••••••',
    officialUrl: 'https://jina.ai',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    desc: '独立自主索引的全球商业搜索，具备高隐私性与丰富摘要。',
    placeholder: 'BSA••••••••',
    officialUrl: 'https://brave.com/search/api',
  },
  {
    id: 'google_cse',
    name: 'Google CSE',
    desc: 'Google 可编程搜索引擎，自定义配置索引库与高精度官方检索。',
    placeholder: 'AIza••••••••',
    officialUrl: 'https://programmablesearchengine.google.com',
  },
  {
    id: 'bocha',
    name: '博查搜索 (Bocha)',
    desc: '面向大模型 AI 优化的中文语义开放搜索与事实核查 API。',
    placeholder: 'sk-••••••••',
    officialUrl: 'https://bochaai.com',
  },
  {
    id: 'searxng',
    name: 'SearXNG',
    desc: '开源自由元搜索引擎，可连接自建或公共私密搜索节点。',
    placeholder: '可选 API Key 或留空',
    officialUrl: 'https://docs.searxng.org',
  },
] as const;

/**
 * 默认支持的免 Key 引擎元数据列表
 */
export const AVAILABLE_FREE_ENGINES: readonly FreeEngineMeta[] = [
  {
    id: 'wikipedia',
    name: '维基百科 (免 Key 知识库)',
    desc: '全球最大的开放知识库百科，提供精准概念定义与事实查证。',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo (免 Key 国际)',
    desc: '国际主流隐私搜索引擎，轻量 HTML 直解无追踪。',
  },
  {
    id: 'baidu',
    name: '百度移动版 (免 Key 中文)',
    desc: '国内中文本土高频资讯与百科轻量抓取。',
  },
] as const;

/**
 * 网页正文截断 Token 选项列表
 */
export const TOKEN_LIMIT_OPTIONS: readonly number[] = [
  2000, 4000, 8000,
] as const;

/**
 * 纯函数：将 API Key 格式化为安全展示掩码（如 sk-tavi...9a2b）
 * 严格保护密钥物理隔离与防窥隐私
 */
export function formatMaskedKey(rawKey: string): string {
  if (!rawKey || typeof rawKey !== 'string') return '';
  const trimmed = rawKey.trim();
  if (!trimmed) return '';

  // 若用户粘贴了包含逗号或换行的多 Key，取首个 Key 进行掩码输出
  const firstKey = trimmed.split(/[\n,]/)[0]?.trim();
  if (!firstKey) return '';

  if (firstKey.length <= 8) {
    if (firstKey.length <= 4) {
      return '•'.repeat(firstKey.length);
    }
    return `${firstKey.slice(0, 2)}...${firstKey.slice(-2)}`;
  }

  // 针对典型 API Key (如 sk-tavily-12345-9a2b)：
  // 前缀截取前 7 位（sk-tavi），后缀保留后 4 位（9a2b），中间以 "..." 连接
  return `${firstKey.slice(0, 7)}...${firstKey.slice(-4)}`;
}

/**
 * 连通性测试结果
 */
export interface ProviderHealthResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * ViewModel 接口契约
 */
export interface WebSearchSettingsVm {
  // 1. 全局总开关与原生模型优先偏好
  readonly enabled: boolean;
  readonly toggleEnabled: (val?: boolean) => void;
  readonly modelToolsPreferred: boolean;
  readonly toggleModelToolsPreferred: (explicitValue?: boolean) => void;

  // 2. 商业服务商选择、Key 安全存储与连通性
  readonly selectedProvider: string;
  readonly selectProvider: (id: string) => void;
  readonly getMaskedKey: (providerIdOrKey: string) => string;
  readonly saveKey: (providerId: string, rawKey: string) => Promise<void>;
  readonly checkProviderHealth: (
    providerId: string
  ) => Promise<ProviderHealthResult>;
  readonly testingProviderId: string | null;
  readonly healthResults: Record<string, ProviderHealthResult>;
  readonly keyPresence: Record<string, boolean>;

  // 3. 免 Key 开放引擎链表与优先级排布
  readonly freeEnginesOrder: string[];
  readonly moveFreeEngine: (fromIndex: number, toIndex: number) => void;
  readonly toggleFreeEngine: (id: string) => void;
  readonly isFreeEngineEnabled: (id: string) => boolean;

  // 4. 网页提取内容 Token 截断上限
  readonly maxTokens: number;
  readonly setMaxTokens: (n: number) => void;

  // 5. 元数据常量
  readonly availableProviders: readonly ByokProviderMeta[];
  readonly availableFreeEngines: readonly FreeEngineMeta[];
  readonly tokenOptions: readonly number[];
  readonly refreshKeys: () => Promise<void>;
}

/**
 * 移动端网页搜索设置 ViewModel Hook
 * @param injectedKeyManager 可选的 KeyManager 实例（用于单测隔离注入）
 */
export function useWebSearchSettingsVm(
  injectedKeyManager?: WebSearchKeyManager
): WebSearchSettingsVm {
  const keyManager = injectedKeyManager ?? searchKeyManager;

  // 1. 订阅 Zustand 状态机
  const enabled = useSearchSettingsStore((s) => s.enabled);
  const modelToolsPreferred = useSearchSettingsStore(
    (s) => s.modelToolsPreferred
  );
  const selectedProvider = useSearchSettingsStore(
    (s) => s.selectedByokProvider
  );
  const freeEnginesOrder = useSearchSettingsStore((s) => s.enabledFreeEngines);
  const maxTokens = useSearchSettingsStore((s) => s.maxTokensPerFetch);

  // 2. 本地只读掩码缓存与连通性测试状态
  const [maskedKeys, setMaskedKeys] = useState<Record<string, string>>({});
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});
  const [testingProviderId, setTestingProviderId] = useState<string | null>(
    null
  );
  const [healthResults, setHealthResults] = useState<
    Record<string, ProviderHealthResult>
  >({});

  // 3. 从硬件 SecureStore 刷新各供应商的 Key 存在性与掩码
  const refreshKeys = useCallback(async () => {
    const providerIds = AVAILABLE_BYOK_PROVIDERS.map((p) => p.id);
    const newMasked: Record<string, string> = {};
    const newPresence: Record<string, boolean> = {};

    await Promise.all(
      providerIds.map(async (id) => {
        try {
          const keys = await keyManager.getAvailableKeys(id);
          if (keys.length > 0 && keys[0]) {
            newMasked[id] = formatMaskedKey(keys[0]);
            newPresence[id] = true;
          } else {
            newMasked[id] = '';
            newPresence[id] = false;
          }
        } catch {
          newMasked[id] = '';
          newPresence[id] = false;
        }
      })
    );

    setMaskedKeys(newMasked);
    setKeyPresence(newPresence);
  }, [keyManager]);

  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  // 4. 切换全局开关
  const toggleEnabled = useCallback((val?: boolean) => {
    const current = useSearchSettingsStore.getState().enabled;
    const nextVal = typeof val === 'boolean' ? val : !current;
    useSearchSettingsStore.getState().setEnabled(nextVal);
  }, []);

  // 5. 切换原生优先开关
  const toggleModelToolsPreferred = useCallback((explicitValue?: boolean) => {
    const current = useSearchSettingsStore.getState().modelToolsPreferred;
    const nextVal =
      typeof explicitValue === 'boolean' ? explicitValue : !current;
    useSearchSettingsStore.getState().setModelToolsPreferred(nextVal);
  }, []);

  // 6. 选择首选 BYOK 商业供应商
  const selectProvider = useCallback((id: string) => {
    useSearchSettingsStore.getState().setSelectedByokProvider(id);
  }, []);

  // 7. 掩码计算与输出（支持传 providerId 读取已缓存掩码，或传 rawKey 直接脱敏）
  const getMaskedKey = useCallback(
    (providerIdOrKey: string): string => {
      if (!providerIdOrKey) return '';
      // 若缓存中存在该 providerId 的掩码，直接输出
      if (maskedKeys[providerIdOrKey]) {
        return maskedKeys[providerIdOrKey];
      }
      // 若入参看起来是 rawKey（包含分隔符或长度特征）
      if (
        providerIdOrKey.includes('-') ||
        providerIdOrKey.startsWith('sk_') ||
        providerIdOrKey.length > 12
      ) {
        return formatMaskedKey(providerIdOrKey);
      }
      return '';
    },
    [maskedKeys]
  );

  // 8. 安全存储 Key 到硬件 SecureStore 槽位
  const saveKey = useCallback(
    async (providerId: string, rawKey: string): Promise<void> => {
      await keyManager.saveKeys(providerId, rawKey);
      const keys = await keyManager.getAvailableKeys(providerId);
      const masked = keys.length > 0 && keys[0] ? formatMaskedKey(keys[0]) : '';
      setMaskedKeys((prev) => ({ ...prev, [providerId]: masked }));
      setKeyPresence((prev) => ({ ...prev, [providerId]: keys.length > 0 }));
    },
    [keyManager]
  );

  // 9. 一键连通性测试 (checkHealth)
  const checkProviderHealth = useCallback(
    async (providerId: string): Promise<ProviderHealthResult> => {
      setTestingProviderId(providerId);
      const start = Date.now();
      try {
        const adapter = getSearchProvider(providerId);
        if (!adapter) {
          const res: ProviderHealthResult = {
            ok: false,
            latencyMs: 0,
            error: `未找到服务商: ${providerId}`,
          };
          setHealthResults((prev) => ({ ...prev, [providerId]: res }));
          return res;
        }

        const key = await keyManager.getKey(providerId);
        if (!key && providerId !== 'searxng') {
          const res: ProviderHealthResult = {
            ok: false,
            latencyMs: 0,
            error: '未配置 API Key',
          };
          setHealthResults((prev) => ({ ...prev, [providerId]: res }));
          return res;
        }

        if (typeof adapter.checkHealth === 'function') {
          const health = await adapter.checkHealth(key || '');
          const res: ProviderHealthResult = {
            ok: health.ok,
            latencyMs: health.latencyMs ?? Math.max(1, Date.now() - start),
            error: health.error,
          };
          setHealthResults((prev) => ({ ...prev, [providerId]: res }));
          return res;
        }

        // 默认连通性兜底
        const res: ProviderHealthResult = {
          ok: true,
          latencyMs: Math.max(1, Date.now() - start),
        };
        setHealthResults((prev) => ({ ...prev, [providerId]: res }));
        return res;
      } catch (err: any) {
        const latencyMs = Math.max(1, Date.now() - start);
        const res: ProviderHealthResult = {
          ok: false,
          latencyMs,
          error: err?.message || '连通性检查异常',
        };
        setHealthResults((prev) => ({ ...prev, [providerId]: res }));
        return res;
      } finally {
        setTestingProviderId(null);
      }
    },
    [keyManager]
  );

  // 10. 免 Key 引擎列表排序与移动
  const moveFreeEngine = useCallback((fromIndex: number, toIndex: number) => {
    const current = [...useSearchSettingsStore.getState().enabledFreeEngines];
    if (
      fromIndex < 0 ||
      fromIndex >= current.length ||
      toIndex < 0 ||
      toIndex >= current.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const [moved] = current.splice(fromIndex, 1);
    if (typeof moved !== 'string') return;
    current.splice(toIndex, 0, moved);
    useSearchSettingsStore.getState().setEnabledFreeEngines(current);
  }, []);

  // 11. 免 Key 引擎开关切换
  const toggleFreeEngine = useCallback((id: string) => {
    const current = useSearchSettingsStore.getState().enabledFreeEngines;
    let next: string[];
    if (current.includes(id)) {
      next = current.filter((e) => e !== id);
    } else {
      next = [...current, id];
    }
    useSearchSettingsStore.getState().setEnabledFreeEngines(next);
  }, []);

  // 12. 查询指定免 Key 引擎是否启用
  const isFreeEngineEnabled = useCallback(
    (id: string): boolean => {
      return freeEnginesOrder.includes(id);
    },
    [freeEnginesOrder]
  );

  // 13. 设置单网页 Token 截断上限
  const setMaxTokens = useCallback((n: number) => {
    useSearchSettingsStore.getState().setMaxTokensPerFetch(n);
  }, []);

  return {
    enabled,
    toggleEnabled,
    modelToolsPreferred,
    toggleModelToolsPreferred,
    selectedProvider,
    selectProvider,
    getMaskedKey,
    saveKey,
    checkProviderHealth,
    testingProviderId,
    healthResults,
    keyPresence,
    freeEnginesOrder,
    moveFreeEngine,
    toggleFreeEngine,
    isFreeEngineEnabled,
    maxTokens,
    setMaxTokens,
    availableProviders: AVAILABLE_BYOK_PROVIDERS,
    availableFreeEngines: AVAILABLE_FREE_ENGINES,
    tokenOptions: TOKEN_LIMIT_OPTIONS,
    refreshKeys,
  };
}
