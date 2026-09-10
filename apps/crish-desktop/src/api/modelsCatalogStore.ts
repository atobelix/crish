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
import { readModelsYamlIpc, writeModelsYamlIpc } from './modelsCatalogIpc';
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

const WRITE_BEFORE_LOAD_ERROR = '模型目录尚未成功加载，拒绝写盘以免覆盖用户文件';

// ── 写串行队列（单飞 save + 最新 tree coalesce）────────────────────────────────
//
// 语义（文档化裁决）：
// 1. 同一时刻最多一个 in-flight save IPC；
// 2. save 在途时，后到的 updateTree 乐观更新内存后 coalesce 为「最新 tree」，
//    等当前 save 结束后由 drain 循环补一次 save（并发双写 → 磁盘只落最新）；
// 3. 失败回滚：save 被拒绝且无更新 tree 顶替时，内存原子回滚到本批次首个
//    乐观更新之前的快照（batchBaseSnapshot），并打 WRITE_REJECTED lastError；
// 4. drain 经 queueMicrotask 延迟启动，保证同一 tick 内连续两次 updateTree
//    能 coalesce 成一次 save（而不是各自抢跑 IPC）。

type WriteResult = { ok: boolean; error?: string };
type WriteWaiter = { resolve: (r: WriteResult) => void };

let saveInFlight = false;
let drainScheduled = false;
let queuedTree: ModelsYamlTree | null = null;
let queuedWaiters: WriteWaiter[] = [];
/** 本批次（未成功落盘的乐观更新链）起点快照，失败时整体回滚用 */
let batchBaseSnapshot: ModelsCatalogState | null = null;

function resetWriteQueueForTesting(): void {
  saveInFlight = false;
  drainScheduled = false;
  queuedTree = null;
  queuedWaiters = [];
  batchBaseSnapshot = null;
}

function applyOptimisticTree(newTree: ModelsYamlTree): void {
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
}

function scheduleDrain(): void {
  if (drainScheduled || saveInFlight) return;
  drainScheduled = true;
  queueMicrotask(() => {
    drainScheduled = false;
    void drainWriteQueue();
  });
}

async function drainWriteQueue(): Promise<void> {
  if (saveInFlight) return;
  saveInFlight = true;
  try {
    while (queuedTree) {
      const treeToSave = queuedTree;
      const waiters = queuedWaiters;
      const baseForRollback = batchBaseSnapshot;
      queuedTree = null;
      queuedWaiters = [];

      let writeRes: { ok: boolean; error?: string };
      try {
        writeRes = await writeModelsYamlIpc(treeToSave);
      } catch (e) {
        writeRes = {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      if (!writeRes.ok) {
        // 无更新 tree 顶替时回滚到批次基线；有则保留 base 给下一轮（整条未确认链共享锚点）
        if (state.tree === treeToSave && baseForRollback) {
          state = {
            ...baseForRollback,
            lastError: {
              kind: 'WRITE_REJECTED',
              message: writeRes.error || '写入磁盘被拒绝',
            },
          };
          notify();
          batchBaseSnapshot = null;
        }
        for (const w of waiters) w.resolve({ ok: false, error: writeRes.error });
      } else {
        // 成功：磁盘已与 treeToSave 一致。
        // 若还有排队 tree，下一轮回滚锚点设为「已落盘 treeToSave 的干净镜像」
        // （不含排队者的乐观更新——失败时可精确回退到磁盘现状）。
        if (queuedTree) {
          const cleanIndexes = buildIndexes(treeToSave);
          batchBaseSnapshot = {
            ...state,
            tree: treeToSave,
            providerMap: cleanIndexes.providerMap,
            modelIndex: cleanIndexes.modelIndex,
            globalModelIndex: cleanIndexes.globalModelIndex,
            lastError: null,
          };
        } else {
          batchBaseSnapshot = null;
        }
        for (const w of waiters) w.resolve({ ok: true });
        emitUiEvent('models-catalog-changed', undefined);
      }
    }
  } finally {
    saveInFlight = false;
  }
}

/** 读 IPC 成功载荷：只认 providers 对象。data.tree 无论有没有都不得当成功源。 */
interface ModelsYamlReadPayload {
  path?: string;
  providers?: unknown;
}

function isProvidersObject(value: unknown): value is Record<string, ProviderSpec> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function treeFromReadPayload(data: ModelsYamlReadPayload): ModelsYamlTree | null {
  if (isProvidersObject(data.providers)) {
    return { version: 2, providers: data.providers };
  }
  return null;
}

function refuseWriteIfNotLoaded(): { ok: false; error: string } | null {
  if (state.loaded !== true) {
    return { ok: false, error: WRITE_BEFORE_LOAD_ERROR };
  }
  return null;
}

function applyLoadFailure(kind: ModelsCatalogError['kind'], message: string): false {
  // 失败不得用空 providers 覆盖上一份成功快照；显式把 loaded 打回 false
  state = {
    ...state,
    loaded: false,
    version: state.version + 1,
    lastError: { kind, message },
  };
  notify();
  emitUiEvent('models-catalog-changed', undefined);
  return false;
}

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
    resetWriteQueueForTesting();
  },

  async ensureLoaded(force = false): Promise<boolean> {
    if (inflightLoadPromise) return inflightLoadPromise;
    if (state.loaded && !force) return true;

    inflightLoadPromise = (async () => {
      const result = await readModelsYamlIpc();
      if (!result.ok) {
        const kind =
          result.kind === 'PARSE_ERROR' ? 'PARSE_FAILURE' : 'IPC_DISCONNECTED';
        return applyLoadFailure(kind, result.error);
      }

      const loadedTree = treeFromReadPayload(result.data as ModelsYamlReadPayload);
      if (!loadedTree) {
        return applyLoadFailure(
          'IPC_DISCONNECTED',
          '读 IPC 未返回 providers 对象（协议漂移，拒绝空树冒充已加载）'
        );
      }

      const { providerMap, modelIndex, globalModelIndex } = buildIndexes(loadedTree);

      state = {
        tree: loadedTree,
        providerMap,
        modelIndex,
        globalModelIndex,
        version: state.version + 1,
        loaded: true,
        filePath: result.data.path || state.filePath,
        lastError: null,
      };

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

  /**
   * 写入口：乐观更新内存 + 经单飞写队列 coalesce 落盘。
   * 并发双写时后到请求 coalesce 为最新 tree，最终磁盘与内存一致。
   */
  async updateTree(newTree: ModelsYamlTree): Promise<WriteResult> {
    const refused = refuseWriteIfNotLoaded();
    if (refused) return refused;

    // 批次回滚锚点：仅在完全空闲（无排队 tree、无 in-flight save）时取当前快照。
    // in-flight / 排队链保持既有锚点（整条未确认链共享同一回滚目标）；
    // 成功落盘且仍有排队时，由 drain 将锚点更新为「已落盘 tree 的干净镜像」。
    if (!queuedTree && !saveInFlight) {
      batchBaseSnapshot = state;
    }

    applyOptimisticTree(newTree);

    return new Promise<WriteResult>((resolve) => {
      // coalesce：最新 tree 覆盖先前排队者；所有 waiter 共享下一次 save 的结果
      queuedTree = newTree;
      queuedWaiters.push({ resolve });
      scheduleDrain();
    });
  },

  async addProvider(providerId: string, provider: ProviderSpec): Promise<{ ok: boolean; error?: string }> {
    const refused = refuseWriteIfNotLoaded();
    if (refused) return refused;
    return this.updateTree(addProvider(state.tree, providerId, provider));
  },

  async updateProvider(providerId: string, patch: Partial<ProviderSpec>): Promise<{ ok: boolean; error?: string }> {
    const refused = refuseWriteIfNotLoaded();
    if (refused) return refused;
    return this.updateTree(updateProvider(state.tree, providerId, patch));
  },

  async removeProvider(providerId: string): Promise<{ ok: boolean; error?: string }> {
    const refused = refuseWriteIfNotLoaded();
    if (refused) return refused;
    return this.updateTree(removeProvider(state.tree, providerId));
  },

  async addModel(providerId: string, modelInput: Partial<ModelSpec> & { id: string }): Promise<{ ok: boolean; error?: string }> {
    const refused = refuseWriteIfNotLoaded();
    if (refused) return refused;
    return this.updateTree(addModel(state.tree, providerId, modelInput));
  },

  async updateModel(providerId: string, modelId: string, patch: Partial<ModelSpec>): Promise<{ ok: boolean; error?: string }> {
    const refused = refuseWriteIfNotLoaded();
    if (refused) return refused;
    return this.updateTree(updateModel(state.tree, providerId, modelId, patch));
  },

  async removeModel(providerId: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    const refused = refuseWriteIfNotLoaded();
    if (refused) return refused;
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
