/**
 * 模型探测结果面（LS，键 = modelRefKey）：只存连通测试结果 `lastTest`。
 *
 * 单轨口径（身份键 D5）：本键 `crish_model_meta_v1` 是探测结果的**私有展示面**，
 * 不是配置真源；键形与身份键 `modelRefKey`（JSON 二元组）统一，禁止第三种拼接。
 * `enabled` / `contextWindow` 等配置声明的权威源 = 统一树（modelsCatalogStore）。
 *
 * 引入内存镜像单例，杜绝 O(N*M) 同步反序列化；写入同步内存与 LS，
 * 跨窗口经 storage 事件失效镜像。
 */

import { modelRefKey, parseModelRefKey } from './modelsCatalogTypes';
import { emitUiEvent } from './uiEvents';
import {
  ScopedLifecycleRegistry,
  type Disposer,
} from '../utils/lifecycle/ScopedLifecycleRegistry';

const META_KEY = 'crish_model_meta_v1';

/** 连通测试结果 */
export type ProbeTestResult = {
  ok: boolean;
  latencyMs?: number | undefined;
  at: number;
  error?: string | undefined;
};

type MetaMap = Record<string, { lastTest: ProbeTestResult }>;

/** 模块级单例内存镜像缓存 */
let memoryMetaCache: MetaMap | null = null;

function loadMap(): MetaMap {
  if (memoryMetaCache !== null) return memoryMetaCache;
  try {
    const raw =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(META_KEY)
        : null;
    if (!raw) {
      memoryMetaCache = {};
      return memoryMetaCache;
    }
    const o = JSON.parse(raw);
    memoryMetaCache = o && typeof o === 'object' ? (o as MetaMap) : {};
    return memoryMetaCache;
  } catch {
    memoryMetaCache = {};
    return memoryMetaCache;
  }
}

function saveMap(map: MetaMap): void {
  memoryMetaCache = map;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(META_KEY, JSON.stringify(map));
    }
  } catch {
    /* ignore storage quota or disabled errors */
  }
}

const storageLifecycleRegistry = new ScopedLifecycleRegistry();
let activeStorageListenerDisposer: Disposer | null = null;

function handleModelMetaStorageEvent(e: StorageEvent): void {
  if (e.key === META_KEY) {
    memoryMetaCache = null;
  }
}

/**
 * 挂载跨窗口 StorageEvent 监听（经 ScopedLifecycleRegistry 统一托管，幂等防重复堆积）。
 */
export function setupModelMetaStorageListener(
  slr: ScopedLifecycleRegistry = storageLifecycleRegistry
): Disposer {
  if (activeStorageListenerDisposer) {
    activeStorageListenerDisposer();
    activeStorageListenerDisposer = null;
  }
  if (slr === storageLifecycleRegistry && storageLifecycleRegistry.isDisposed) {
    storageLifecycleRegistry.reset();
  }
  if (
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return () => {};
  }
  const disposer = slr.listen(window, 'storage', handleModelMetaStorageEvent);
  activeStorageListenerDisposer = disposer;
  return () => {
    disposer();
    if (activeStorageListenerDisposer === disposer) {
      activeStorageListenerDisposer = null;
    }
  };
}

/** 注销跨窗口 StorageEvent 监听并释放模块级生命周期注册表。 */
export function disposeModelMetaStorageListener(): void {
  if (activeStorageListenerDisposer) {
    activeStorageListenerDisposer();
    activeStorageListenerDisposer = null;
  }
  storageLifecycleRegistry.dispose();
}

// 模块初始化时通过受控 SLR 绑定单实例监听，并在 HMR 卸载时自动回收
setupModelMetaStorageListener();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeModelMetaStorageListener();
  });
}

/** 读取某模型的连通测试结果（无记录 → null）。 */
export function getProbeResult(
  providerId: string,
  model: string
): ProbeTestResult | null {
  const stored = loadMap()[modelRefKey({ providerId, modelId: model })];
  return stored?.lastTest ?? null;
}

/** 记录连通测试结果（同步写内存 + LS，并广播 model-meta-changed）。 */
export function recordProbeResult(
  providerId: string,
  model: string,
  lastTest: ProbeTestResult
): void {
  const map = loadMap();
  map[modelRefKey({ providerId, modelId: model })] = { lastTest };
  saveMap(map);
  emitUiEvent('model-meta-changed', {
    profileId: providerId,
    model,
    enabled: true,
  });
}

/** 解析 meta 键身份（测试与诊断用）：非法键 → null。 */
export function parseMetaKey(raw: string): {
  providerId: string;
  modelId: string;
} | null {
  return parseModelRefKey(raw);
}
