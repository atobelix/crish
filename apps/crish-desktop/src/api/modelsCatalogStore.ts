/**
 * modelsCatalogStore.ts —— Provider-Centric 树状单源状态中枢
 *
 * 架构裁决（SSOT）：
 * 1. 磁盘 ~/.conex/models.yaml 为全系统绝对唯一真源；
 * 2. 彻底消灭 LocalStorage 双轨分裂与 KNOWN_CONTEXT 128K 假上限；
 * 3. 维护 version: 2, providers: Record<string, ProviderSpec>；
 * 4. 建立双层双向 O(1) 索引（providerMap, modelIndex, globalModelIndex）；
 * 5. 提供极简纯函数 action 与选择器；
 * 6. 保持对既有消费方的向后兼容门面（listCatalogModels, findCatalogModel 等）。
 */

import { emitUiEvent } from './uiEvents';
import type {
  ModelsYamlTree,
  ProviderSpec,
  ModelSpec,
  ModelProtocol,
  PricingConfig,
  ModelsCatalogError,
  IndexedModelEntry,
  ModelsCatalogState,
} from './modelsCatalogTypes';
import { readModelsYamlIpc, writeModelsYamlIpc, setupModelsYamlHotReloadListener } from './modelsCatalogIpc';
import { applyIncrementalProbe, type IncrementalProbeResult } from './probeIncremental';
import {
  addProvider,
  updateProvider,
  removeProvider,
  addModel,
  updateModel,
  removeModel,
} from './modelsCatalogActions';
import { createSelectors } from './modelsCatalogSelectors';
import {
  setCatalogStateAccessor,
  listCatalogModels,
  findCatalogModel,
  searchCatalogModels,
  getPresetPricingList,
  type CatalogModelProtocol,
  type CatalogModelSpec,
} from './modelsCatalogQuery';

// 重导出纯函数 action 与类型
export {
  addProvider,
  updateProvider,
  removeProvider,
  addModel,
  updateModel,
  removeModel,
};
export type {
  ModelsYamlTree,
  ProviderSpec,
  ModelSpec,
  ModelProtocol,
  PricingConfig,
  ModelsCatalogError,
  IndexedModelEntry,
  ModelsCatalogState,
  CatalogModelProtocol,
  CatalogModelSpec,
};
export {
  listCatalogModels,
  findCatalogModel,
  searchCatalogModels,
  getPresetPricingList,
};

export type ModelsCatalogLoadResult = { ok: true; path: string } | { ok: false; error: string };

type StoreListener = (state: ModelsCatalogState) => void;

// ── 内部响应式状态定义 ──────────────────────────────────────────────────────────

let state: ModelsCatalogState = {
  tree: { version: 2, providers: {} },
  providerMap: new Map(),
  modelIndex: new Map(),
  globalModelIndex: new Map(),
  version: 0,
  loaded: false,
  filePath: '~/.conex/models.yaml',
  lastError: null,
};

setCatalogStateAccessor(() => state);

const listeners = new Set<StoreListener>();
let inflightLoadPromise: Promise<boolean> | null = null;
let hotReloadCleanup: (() => void) | null = null;

function buildIndexes(tree: ModelsYamlTree): {
  providerMap: Map<string, ProviderSpec>;
  modelIndex: Map<string, IndexedModelEntry>;
  globalModelIndex: Map<string, IndexedModelEntry[]>;
} {
  const providerMap = new Map<string, ProviderSpec>();
  const modelIndex = new Map<string, IndexedModelEntry>();
  const globalModelIndex = new Map<string, IndexedModelEntry[]>();

  for (const [pId, provider] of Object.entries(tree.providers || {})) {
    const normPId = pId.trim().toLowerCase();
    providerMap.set(normPId, provider);

    for (const model of provider.models || []) {
      const normMId = (model.id || '').trim().toLowerCase();
      if (!normMId) continue;

      const entry: IndexedModelEntry = { providerId: normPId, provider, model };
      modelIndex.set(`${normPId}::${normMId}`, entry);

      const list = globalModelIndex.get(normMId) || [];
      list.push(entry);
      globalModelIndex.set(normMId, list);
    }
  }

  return { providerMap, modelIndex, globalModelIndex };
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      console.error('[ModelsCatalogStore] 监听器执行异常:', err);
    }
  }
}

// ── 核心 Store 单例 ────────────────────────────────────────────────────────────

export const modelsCatalogStore = {
  getState(): ModelsCatalogState {
    return state;
  },

  subscribe(listener: StoreListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  resetForTesting(): void {
    state = {
      tree: { version: 2, providers: {} },
      providerMap: new Map(),
      modelIndex: new Map(),
      globalModelIndex: new Map(),
      version: 0,
      loaded: false,
      filePath: '~/.conex/models.yaml',
      lastError: null,
    };
    listeners.clear();
    inflightLoadPromise = null;
    if (hotReloadCleanup) {
      hotReloadCleanup();
      hotReloadCleanup = null;
    }
  },

  async ensureLoaded(force = false): Promise<boolean> {
    if (inflightLoadPromise) return inflightLoadPromise;
    if (state.loaded && !force) return true;

    inflightLoadPromise = (async () => {
      const result = await readModelsYamlIpc();
      if (!result.ok) {
        state = {
          ...state,
          tree: { version: 2, providers: {} },
          providerMap: new Map(),
          modelIndex: new Map(),
          globalModelIndex: new Map(),
          version: state.version + 1,
          lastError: {
            kind: result.kind === 'PARSE_ERROR' ? 'PARSE_FAILURE' : 'IPC_DISCONNECTED',
            message: result.error,
          },
        };
        notify();
        emitUiEvent('models-catalog-changed', undefined);
        return false;
      }

      const rawTree = result.data.tree || { version: 2 as const, providers: {} };
      const normalizedTree: ModelsYamlTree = {
        version: 2,
        providers: rawTree.providers || {},
      };

      const { providerMap, modelIndex, globalModelIndex } = buildIndexes(normalizedTree);

      state = {
        tree: normalizedTree,
        providerMap,
        modelIndex,
        globalModelIndex,
        version: state.version + 1,
        loaded: true,
        filePath: result.data.path || state.filePath,
        lastError: null,
      };

      if (!hotReloadCleanup) {
        hotReloadCleanup = setupModelsYamlHotReloadListener(async () => {
          await modelsCatalogStore.ensureLoaded(true);
        });
      }

      notify();
      emitUiEvent('models-catalog-changed', undefined);
      return true;
    })();

    try {
      return await inflightLoadPromise;
    } finally {
      inflightLoadPromise = null;
    }
  },

  async updateTree(newTree: ModelsYamlTree): Promise<{ ok: boolean; error?: string }> {
    const prevSnapshot = state;
    const { providerMap, modelIndex, globalModelIndex } = buildIndexes(newTree);

    state = {
      ...state,
      tree: newTree,
      providerMap,
      modelIndex,
      globalModelIndex,
      version: state.version + 1,
      lastError: null,
    };
    notify();

    const writeRes = await writeModelsYamlIpc(newTree);
    if (!writeRes.ok) {
      state = {
        ...prevSnapshot,
        lastError: {
          kind: 'WRITE_REJECTED',
          message: writeRes.error || '写入磁盘被拒绝',
        },
      };
      notify();
      return { ok: false, error: writeRes.error };
    }

    emitUiEvent('models-catalog-changed', undefined);
    return { ok: true };
  },

  async addProvider(providerId: string, provider: ProviderSpec): Promise<{ ok: boolean; error?: string }> {
    return this.updateTree(addProvider(state.tree, providerId, provider));
  },

  async updateProvider(providerId: string, patch: Partial<ProviderSpec>): Promise<{ ok: boolean; error?: string }> {
    return this.updateTree(updateProvider(state.tree, providerId, patch));
  },

  async removeProvider(providerId: string): Promise<{ ok: boolean; error?: string }> {
    return this.updateTree(removeProvider(state.tree, providerId));
  },

  async addModel(providerId: string, modelInput: Partial<ModelSpec> & { id: string }): Promise<{ ok: boolean; error?: string }> {
    return this.updateTree(addModel(state.tree, providerId, modelInput));
  },

  async updateModel(providerId: string, modelId: string, patch: Partial<ModelSpec>): Promise<{ ok: boolean; error?: string }> {
    return this.updateTree(updateModel(state.tree, providerId, modelId, patch));
  },

  async removeModel(providerId: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    return this.updateTree(removeModel(state.tree, providerId, modelId));
  },

  async probeAndAppendModels(providerId: string, probedRawIds: string[]): Promise<IncrementalProbeResult> {
    return applyIncrementalProbe(providerId, probedRawIds);
  },
};

// ── 选择器导出 ─────────────────────────────────────────────────────────────────

const selectors = createSelectors(() => modelsCatalogStore.getState());

export const selectProvider = selectors.selectProvider.bind(selectors);
export const selectModel = selectors.selectModel.bind(selectors);
export const selectModelGlobally = selectors.selectModelGlobally.bind(selectors);
export const selectEffectiveProtocol = selectors.selectEffectiveProtocol.bind(selectors);
export const selectEffectiveContextWindow = selectors.selectEffectiveContextWindow.bind(selectors);
export const selectSupportsThinking = selectors.selectSupportsThinking.bind(selectors);
export const selectThinkingLevelsMap = selectors.selectThinkingLevelsMap.bind(selectors);
export const selectEstimatedCost = selectors.selectEstimatedCost.bind(selectors);

// ── 向后兼容门面函数 ───────────────────────────────────────────────────────────

export function getModelsCatalogPath(): string {
  return state.filePath;
}

export function getModelsCatalogVersion(): number {
  return state.version;
}

export function resetModelsCatalogMirror(): void {
  modelsCatalogStore.resetForTesting();
}

export async function ensureModelsCatalogLoaded(force = false): Promise<ModelsCatalogLoadResult> {
  const ok = await modelsCatalogStore.ensureLoaded(force);
  if (ok) {
    return { ok: true, path: state.filePath };
  }
  return {
    ok: false,
    error: state.lastError?.message || '加载 models.yaml 失败',
  };
}
