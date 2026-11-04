// searchSettingsStore：网页搜索设置状态机与持久化
// 依据方案文档：docs/mobile-web-search-and-sandbox/06-分维-状态机演进与SQLite持久化及设置方案.md §4
//
// 核心职责：
// 1. 全局配置状态维护：全局总开关、原生模型工具偏好、BYOK 供应商、免 Key 引擎列表、Token 提取上限；
// 2. 会话级别 Override 开关与优先级解析：isSearchEnabledForThread(threadId) 支持线程独立覆盖；
// 3. 持久化集成：通过轻量 KV 持久化机制（对齐 SqlSettingsDao / SettingsPersist）实现状态无损保存与启动水合。

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * 网页搜索全局与会话设置状态
 */
export interface SearchSettingsState {
  /** 全局联网总开关 (默认 true) */
  enabled: boolean;
  /** 优先使用模型原生搜索 (默认 true) */
  modelToolsPreferred: boolean;
  /** 选中的商业搜索提供商 (默认 'tavily') */
  selectedByokProvider: string;
  /** 启用的免 Key 引擎有序列表 (默认 ['wikipedia', 'duckduckgo', 'baidu']) */
  enabledFreeEngines: string[];
  /** 单网页提取 Token 上限 (默认 4000) */
  maxTokensPerFetch: number;
  /** 单会话 override 开关 (threadId -> boolean) */
  threadOverrides: Record<string, boolean>;
}

/**
 * 状态机 Actions
 */
export interface SearchSettingsActions {
  setEnabled: (enabled: boolean) => void;
  setModelToolsPreferred: (preferred: boolean) => void;
  setSelectedByokProvider: (provider: string) => void;
  setEnabledFreeEngines: (engines: string[]) => void;
  setMaxTokensPerFetch: (tokens: number) => void;
  setThreadOverride: (
    threadId: string,
    enabled: boolean | null | undefined
  ) => void;
  isSearchEnabledForThread: (threadId?: string | null) => boolean;

  /** 启动水合：从 KV 持久层回填状态 */
  hydrate: (persist?: SearchSettingsPersist) => Promise<void>;
  /** 复位为默认状态 */
  resetToDefaults: () => void;
}

export type SearchSettingsStoreState = SearchSettingsState &
  SearchSettingsActions;

/** 默认设置生成纯函数 */
export function defaultSearchSettingsState(): SearchSettingsState {
  return {
    enabled: true,
    modelToolsPreferred: true,
    selectedByokProvider: 'tavily',
    enabledFreeEngines: ['wikipedia', 'duckduckgo', 'baidu'],
    maxTokensPerFetch: 4000,
    threadOverrides: {},
  };
}

/** KV 持久化接口（对齐 SqlSettingsDao / SettingsPersist 注入模式） */
export interface SearchSettingsPersist {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

/** 持久化 KV 存储键名 */
export const SEARCH_SETTINGS_KV_KEY = 'localchat.websearch_settings';

/** 全局注入的默认持久化实现 */
let defaultPersist: SearchSettingsPersist | null = null;

/**
 * 配置默认持久化实例（应用启动/接线层装配）
 */
export function configureSearchSettingsPersistence(
  persist: SearchSettingsPersist | null
): void {
  defaultPersist = persist;
}

/**
 * 健壮纯函数解码器（Robust Pure Decoder）：过滤无效/脏数据，深合并默认值
 */
export function decodeSearchSettingsState(
  raw: string | null | undefined
): SearchSettingsState {
  const defaults = defaultSearchSettingsState();
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;

    const enabled =
      typeof parsed.enabled === 'boolean' ? parsed.enabled : defaults.enabled;
    const modelToolsPreferred =
      typeof parsed.modelToolsPreferred === 'boolean'
        ? parsed.modelToolsPreferred
        : defaults.modelToolsPreferred;
    const selectedByokProvider =
      typeof parsed.selectedByokProvider === 'string' &&
      parsed.selectedByokProvider.trim()
        ? parsed.selectedByokProvider.trim()
        : defaults.selectedByokProvider;
    const enabledFreeEngines = Array.isArray(parsed.enabledFreeEngines)
      ? parsed.enabledFreeEngines
          .map(String)
          .filter((e: string) => e.length > 0)
      : defaults.enabledFreeEngines;
    const maxTokensPerFetch =
      typeof parsed.maxTokensPerFetch === 'number' &&
      parsed.maxTokensPerFetch > 0
        ? parsed.maxTokensPerFetch
        : defaults.maxTokensPerFetch;

    const threadOverrides: Record<string, boolean> = {};
    if (
      parsed.threadOverrides &&
      typeof parsed.threadOverrides === 'object' &&
      !Array.isArray(parsed.threadOverrides)
    ) {
      for (const [k, v] of Object.entries(parsed.threadOverrides)) {
        if (typeof v === 'boolean') {
          threadOverrides[k] = v;
        }
      }
    }

    return {
      enabled,
      modelToolsPreferred,
      selectedByokProvider,
      enabledFreeEngines,
      maxTokensPerFetch,
      threadOverrides,
    };
  } catch {
    return defaults;
  }
}

/** 提取纯数据切片，避免把 Actions 写入存储 */
function extractPureState(state: SearchSettingsState): SearchSettingsState {
  return {
    enabled: state.enabled,
    modelToolsPreferred: state.modelToolsPreferred,
    selectedByokProvider: state.selectedByokProvider,
    enabledFreeEngines: [...state.enabledFreeEngines],
    maxTokensPerFetch: state.maxTokensPerFetch,
    threadOverrides: { ...state.threadOverrides },
  };
}

/** 异步尽力写入持久层（失败静默，不阻断交互） */
function persistState(
  state: SearchSettingsState,
  persist?: SearchSettingsPersist
): void {
  const p = persist ?? defaultPersist;
  if (!p) return;
  const payload = JSON.stringify(extractPureState(state));
  void p.set(SEARCH_SETTINGS_KV_KEY, payload).catch(() => {
    // 写入失败静默
  });
}

/**
 * Zustand 搜索设置 Hook 与 Store
 */
export const useSearchSettingsStore = create<SearchSettingsStoreState>()(
  immer((set, get) => ({
    ...defaultSearchSettingsState(),

    setEnabled: (enabled: boolean) => {
      set((s) => {
        s.enabled = enabled;
      });
      persistState(get());
    },

    setModelToolsPreferred: (preferred: boolean) => {
      set((s) => {
        s.modelToolsPreferred = preferred;
      });
      persistState(get());
    },

    setSelectedByokProvider: (provider: string) => {
      set((s) => {
        s.selectedByokProvider = provider;
      });
      persistState(get());
    },

    setEnabledFreeEngines: (engines: string[]) => {
      set((s) => {
        s.enabledFreeEngines = [...engines];
      });
      persistState(get());
    },

    setMaxTokensPerFetch: (tokens: number) => {
      set((s) => {
        s.maxTokensPerFetch = tokens;
      });
      persistState(get());
    },

    setThreadOverride: (
      threadId: string,
      enabled: boolean | null | undefined
    ) => {
      set((s) => {
        if (enabled === null || enabled === undefined) {
          delete s.threadOverrides[threadId];
        } else {
          s.threadOverrides[threadId] = enabled;
        }
      });
      persistState(get());
    },

    /**
     * 计算某线程是否应当激活网页搜索（会话 override 优先级）：
     * - 若该会话设置了 explicit override (true / false)，以会话 override 为准；
     * - 若未设置 override 或未提供 threadId，以全局 enabled 开关为准。
     */
    isSearchEnabledForThread: (threadId?: string | null): boolean => {
      const state = get();
      if (threadId && typeof state.threadOverrides[threadId] === 'boolean') {
        return state.threadOverrides[threadId];
      }
      return state.enabled;
    },

    hydrate: async (persist?: SearchSettingsPersist) => {
      const p = persist ?? defaultPersist;
      if (!p) return;
      try {
        const raw = await p.get(SEARCH_SETTINGS_KV_KEY);
        if (!raw) return;
        const decoded = decodeSearchSettingsState(raw);
        set((s) => {
          s.enabled = decoded.enabled;
          s.modelToolsPreferred = decoded.modelToolsPreferred;
          s.selectedByokProvider = decoded.selectedByokProvider;
          s.enabledFreeEngines = decoded.enabledFreeEngines;
          s.maxTokensPerFetch = decoded.maxTokensPerFetch;
          s.threadOverrides = decoded.threadOverrides;
        });
      } catch {
        // 解码异常静默保持现状
      }
    },

    resetToDefaults: () => {
      const defaults = defaultSearchSettingsState();
      set((s) => {
        s.enabled = defaults.enabled;
        s.modelToolsPreferred = defaults.modelToolsPreferred;
        s.selectedByokProvider = defaults.selectedByokProvider;
        s.enabledFreeEngines = defaults.enabledFreeEngines;
        s.maxTokensPerFetch = defaults.maxTokensPerFetch;
        s.threadOverrides = defaults.threadOverrides;
      });
      persistState(get());
    },
  }))
);

/** 兼容传统 store 命名 */
export const searchSettingsStore = useSearchSettingsStore;

/** 测试环境重置辅助 */
export function resetSearchSettingsForTest(): void {
  defaultPersist = null;
  useSearchSettingsStore.getState().resetToDefaults();
}
