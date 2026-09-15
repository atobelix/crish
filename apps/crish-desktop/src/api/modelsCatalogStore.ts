/** 已提交模型配置镜像。所有写操作串行，回执成功后才发布新快照。 */
import { emitUiEvent } from './uiEvents';
import { logger, toErrMeta } from '../services/LoggerService';
import { modelRefKey, formatParseError } from './modelsCatalogTypes';
import type {
  IndexedModelEntry,
  ModelRef,
  ModelSpec,
  ModelsCatalogError,
  ModelsCatalogSnapshot,
  ModelsCatalogState,
  ModelsYamlTree,
  ProviderSpec,
} from './modelsCatalogTypes';
import { readModelsYamlIpc, writeModelsYamlIpc } from './modelsCatalogIpc';
import {
  addProvider,
  updateProvider,
  removeProvider,
  addModel,
  updateModel,
  removeModel,
  normalizeModelsTree,
  setActiveModel,
} from './modelsCatalogActions';
import { createSelectors } from './modelsCatalogSelectors';
import { createCatalogQueries } from './modelsCatalogQuery';

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
  IndexedProviderEntry,
  ModelsCatalogState,
  ModelsCatalogSnapshot,
  ModelRef,
} from './modelsCatalogTypes';

export type ModelsCatalogLoadResult =
  { ok: true; path: string } | { ok: false; error: string };
export type ModelsCatalogWriteResult =
  { ok: true } | { ok: false; error: string };
type StoreListener = (snapshot: ModelsCatalogState) => void;

function emptyState(): ModelsCatalogState {
  return {
    tree: { version: 2, activeModel: null, providers: {} },
    providerMap: new Map(),
    modelIndex: new Map(),
    revision: '',
    credentialStates: {},
    version: 0,
    loaded: false,
    filePath: '',
    lastError: null,
    warning: null,
  };
}

let state = emptyState();
const listeners = new Set<StoreListener>();
let operationTail: Promise<unknown> = Promise.resolve();
let inflightLoadPromise: Promise<boolean> | null = null;
let generation = 0;

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = operationTail.then(operation, operation);
  operationTail = next;
  return next;
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      logger.error('模型目录监听器执行失败', {
        module: 'models-catalog',
        err: toErrMeta(error),
      });
    }
  }
}

function indexes(tree: ModelsYamlTree) {
  const providerMap = new Map<string, ProviderSpec>();
  const modelIndex = new Map<string, IndexedModelEntry>();
  for (const [providerId, provider] of Object.entries(tree.providers)) {
    providerMap.set(providerId, provider);
    for (const model of provider.models) {
      modelIndex.set(modelRefKey({ providerId, modelId: model.id }), {
        providerId,
        provider,
        model,
      });
    }
  }
  return { providerMap, modelIndex };
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

/** 凭据写入等同轨命令也通过此入口安装已接受快照。 */
function acceptSnapshot(snapshot: ModelsCatalogSnapshot): void {
  if (!snapshot.tree || snapshot.parseError)
    throw new Error(
      snapshot.parseError
        ? formatParseError(snapshot.parseError)
        : '模型配置无法解析'
    );
  if (!snapshot.revision || !snapshot.path)
    throw new Error('配置回执缺少修订号或真实路径');
  const tree = freezeTree(normalizeModelsTree(snapshot.tree));
  state = {
    tree,
    ...indexes(tree),
    revision: snapshot.revision,
    credentialStates: structuredClone(snapshot.credentialStates),
    filePath: snapshot.path,
    version: state.version + 1,
    loaded: true,
    lastError: null,
    warning: snapshot.notificationError ?? null,
  };
  notify();
  emitUiEvent('models-catalog-changed', undefined);
}

function fail(
  kind: ModelsCatalogError['kind'],
  message: string,
  unreadable = false
): ModelsCatalogWriteResult {
  state = {
    ...state,
    loaded: unreadable ? false : state.loaded,
    version: state.version + 1,
    lastError: { kind, message },
  };
  notify();
  return { ok: false, error: message };
}

const NOT_LOADED = '模型目录尚未成功加载，拒绝写盘以免覆盖用户文件';
const CONFLICT = '配置已被外部修改，保存已取消，请重新确认';

/** 函数操作在队首读取最新已接受树，不能在排队前拼一份陈旧全树。 */
function mutate(
  action: (tree: ModelsYamlTree) => ModelsYamlTree,
  expectedRevision?: string
): Promise<ModelsCatalogWriteResult> {
  const token = generation;
  return enqueue(async () => {
    if (token !== generation) return { ok: false, error: '配置操作已失效' };
    if (!state.loaded) return { ok: false, error: NOT_LOADED };
    if (expectedRevision !== undefined && expectedRevision !== state.revision) {
      return fail('REVISION_CONFLICT', CONFLICT);
    }
    let candidate: ModelsYamlTree;
    try {
      candidate = normalizeModelsTree(action(state.tree));
    } catch (error) {
      return fail(
        'VALIDATION_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
    try {
      const requestRevision = state.revision;
      const result = await writeModelsYamlIpc(candidate, requestRevision);
      if (token !== generation) return { ok: false, error: '配置操作已失效' };
      if (!result.ok) {
        return fail(
          result.kind === 'REVISION_CONFLICT'
            ? 'REVISION_CONFLICT'
            : 'WRITE_REJECTED',
          result.error,
          result.kind === 'REVISION_CONFLICT' ||
            result.code === 'CONTRACT_MISMATCH'
        );
      }
      if (
        state.revision !== requestRevision &&
        state.revision !== result.data.revision
      ) {
        return fail(
          'REVISION_CONFLICT',
          '配置已收到更新回执，拒绝安装过期保存结果'
        );
      }
      try {
        acceptSnapshot(result.data);
      } catch (error) {
        return fail(
          'PARSE_FAILURE',
          error instanceof Error ? error.message : String(error),
          true
        );
      }
      return { ok: true };
    } catch (error) {
      if (token !== generation) return { ok: false, error: '配置操作已失效' };
      return fail(
        'WRITE_REJECTED',
        error instanceof Error ? error.message : String(error)
      );
    }
  });
}

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

  acceptSnapshot,

  resetForTesting(): void {
    generation += 1;
    state = emptyState();
    listeners.clear();
    operationTail = Promise.resolve();
    inflightLoadPromise = null;
  },

  async ensureLoaded(force = false): Promise<boolean> {
    if (inflightLoadPromise) return inflightLoadPromise;
    if (state.loaded && !force) return true;
    const token = generation;
    inflightLoadPromise = enqueue(async () => {
      try {
        const result = await readModelsYamlIpc();
        if (token !== generation) return false;
        if (!result.ok) {
          fail(
            result.kind === 'PARSE_ERROR'
              ? 'PARSE_FAILURE'
              : 'IPC_DISCONNECTED',
            result.error,
            true
          );
          return false;
        }
        try {
          acceptSnapshot(result.data);
          return true;
        } catch (error) {
          fail(
            'PARSE_FAILURE',
            error instanceof Error ? error.message : String(error),
            true
          );
          return false;
        }
      } catch (error) {
        if (token !== generation) return false;
        fail(
          'IPC_DISCONNECTED',
          error instanceof Error ? error.message : String(error),
          true
        );
        return false;
      }
    });
    try {
      return await inflightLoadPromise;
    } finally {
      if (token === generation) inflightLoadPromise = null;
    }
  },

  /** 整树编辑必须携带读取该树时的修订，拒绝覆盖排队期间的新配置。 */
  updateTree(tree: ModelsYamlTree, expectedRevision = state.revision) {
    const candidate = structuredClone(tree);
    return mutate(() => candidate, expectedRevision);
  },

  addProvider(providerId: string, provider: ProviderSpec) {
    const input = structuredClone(provider);
    return mutate((tree) => addProvider(tree, providerId, input));
  },
  updateProvider(providerId: string, patch: Partial<ProviderSpec>) {
    const input = structuredClone(patch);
    return mutate((tree) => updateProvider(tree, providerId, input));
  },
  removeProvider(providerId: string) {
    return mutate((tree) => removeProvider(tree, providerId));
  },
  addModel(providerId: string, model: Partial<ModelSpec> & { id: string }) {
    const input = structuredClone(model);
    return mutate((tree) => addModel(tree, providerId, input));
  },
  updateModel(
    providerId: string,
    modelId: string,
    patch: Partial<ModelSpec>,
    expectedRevision?: string
  ) {
    const input = structuredClone(patch);
    return mutate(
      (tree) => updateModel(tree, providerId, modelId, input),
      expectedRevision
    );
  },
  removeModel(providerId: string, modelId: string) {
    return mutate((tree) => removeModel(tree, providerId, modelId));
  },
  setActiveModel(ref: ModelRef | null) {
    const input = ref === null ? null : { ...ref };
    return mutate((tree) => setActiveModel(tree, input));
  },
  async probeAndAppendModels(providerId: string, modelIds: string[]) {
    const id = providerId.trim();
    const uniqueIds = [
      ...new Set(modelIds.map((model) => model.trim()).filter(Boolean)),
    ];
    let existingRetained = 0;
    let appendedModelIds: string[] = [];
    const result = await mutate((tree) => {
      const provider = tree.providers[id];
      if (!provider) throw new Error(`供应商不存在：${id}`);
      const existing = new Set(provider.models.map((model) => model.id));
      existingRetained = existing.size;
      appendedModelIds = uniqueIds.filter((model) => !existing.has(model));
      return updateProvider(tree, id, {
        models: [
          ...provider.models,
          ...appendedModelIds.map((model) => ({ id: model, enabled: true })),
        ],
      });
    });
    if (!result.ok) throw new Error(result.error);
    return {
      providerId: id,
      totalProbed: uniqueIds.length,
      existingRetained,
      newAppended: appendedModelIds.length,
      appendedModelIds,
    };
  },
};

const selectors = createSelectors(() => state);
export const selectProvider = selectors.selectProvider;
export const selectModel = selectors.selectModel;
export const listCatalogProviders = selectors.listProviders;
export const selectEffectiveProtocol = selectors.selectEffectiveProtocol;
export const selectEffectiveContextWindow =
  selectors.selectEffectiveContextWindow;
export const selectEffectiveCompat = selectors.selectEffectiveCompat;
export const selectSupportsThinking = selectors.selectSupportsThinking;
export const selectThinkingLevelsMap = selectors.selectThinkingLevelsMap;
export const getActiveModelRef = selectors.getActiveModelRef;

const queries = createCatalogQueries(() => state);
export const listCatalogModels = queries.listCatalogModels;
export const findCatalogModel = queries.findCatalogModel;
export const searchCatalogModels = queries.searchCatalogModels;

export function getModelsCatalogPath(): string {
  return state.filePath;
}
export function getModelsCatalogVersion(): number {
  return state.version;
}
export function resetModelsCatalogMirror(): void {
  modelsCatalogStore.resetForTesting();
}

export async function ensureModelsCatalogLoaded(
  force = false
): Promise<ModelsCatalogLoadResult> {
  const ok = await modelsCatalogStore.ensureLoaded(force);
  return ok
    ? { ok: true, path: state.filePath }
    : { ok: false, error: state.lastError?.message || '加载模型配置失败' };
}
