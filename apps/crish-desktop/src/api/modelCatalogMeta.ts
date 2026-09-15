/**
 * 模型**探测结果**存储（拆自 modelCatalog.ts）：localStorage 读写 + get/set 探测信息。
 *
 * 语义边界（轨 ⑤ 收敛，`docs/provider-single-track-convergence/04-…§9` R-4）：
 * - 本键 `crish_model_meta_v1` **只存探测结果**（`lastTest`：连通测试的
 *   ok / latencyMs / at / error）。它是「探测结果面」，**不是配置声明真源**；
 *   禁止用 lastTest 决定 enabled / 能力 / 协议。
 * - `enabled` / `contextLength` 的权威来源是统一配置树（`models.yaml` →
 *   `modelsCatalogStore`）：读经 `selectModel` / `selectEffectiveContextWindow`，
 *   写经 `modelsCatalogStore.updateModel`。本键不再持久化这两个字段，
 *   以消除「LS 与树双写漂移」。
 * - 键形状沿用本键**历史形状** `providerId::modelId`（登记于
 *   `scripts/check-provider-single-track.mjs` D5_WHITELIST 的「LS meta 键空间」）。
 *   **注意**：它与模型身份键 `modelRefKey`（JSON 二元组）**不同形**——本键只是
 *   本探测结果面的私有 localStorage 键空间，不参与身份决议；任何**身份**语义
 *   一律走 `modelRefKey`，裸 `modelId` 不参与身份解析（裁决 ③）。
 *
 * 引入 memoryMetaCache 单例内存镜像，杜绝 O(N*M) 同步反序列化雪崩
 * （耗时从 200ms 骤降至 <0.2ms）。写入操作自动同步内存与 LocalStorage，
 * 并通过 uiEvents 广播 'model-meta-changed'。
 */

import { guessContextLength } from './modelCatalogPure';
import type { ModelMeta } from './modelCatalogTypes';
import { modelRefKey } from './modelsCatalogTypes';
import { modelsCatalogStore } from './modelsCatalogStore';
import { emitUiEvent } from './uiEvents';

const META_KEY = 'crish_model_meta_v1';

/** 持久化记录：仅探测结果（配置声明字段一律不落本键） */
type MetaRecord = Pick<ModelMeta, 'lastTest'>;
type MetaMap = Record<string, MetaRecord>;

/** 模块级单例内存镜像缓存 */
let memoryMetaCache: MetaMap | null = null;

function metaKey(profileId: string, model: string): string {
  return `${profileId}::${model}`;
}

/**
 * 加载探测结果字典（优先命中内存单例镜像）
 */
function loadMap(): MetaMap {
  if (memoryMetaCache !== null) {
    return memoryMetaCache;
  }
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(META_KEY) : null;
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

/**
 * 保存探测结果字典（同步写穿透：立即更新内存镜像 + 持久化 LocalStorage）
 */
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

/**
 * 监听跨窗口/跨标签页 StorageEvent，自动失效内存缓存
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === META_KEY) {
      memoryMetaCache = null;
    }
  });
}

/**
 * 重置内存镜像缓存（供单测与生命周期管理使用）
 */
export function resetModelMetaCache(): void {
  memoryMetaCache = null;
}

/**
 * 获取当前内存镜像快照（内部调试与测试专用）
 */
export function _getMemoryMetaCacheSnapshot(): MetaMap | null {
  return memoryMetaCache;
}

/**
 * 删除某服务商档案的全部探测结果键（档案删除后的孤儿清扫）。
 * 幂等：目标键不存在则零写回零广播。
 */
export function purgeMetaForProfile(profileId: string): void {
  if (!profileId) return;
  const map = loadMap();
  const prefix = `${profileId}::`;
  const keys = Object.keys(map).filter((k) => k.startsWith(prefix));
  if (keys.length === 0) return;
  for (const k of keys) delete map[k];
  saveMap(map);
  emitUiEvent('model-meta-changed', {
    profileId,
    model: '',
    enabled: true,
  });
}

/**
 * 孤儿探测键清扫：删除所有「档案已不存在」的 `profileId::model` 键
 * （档案删除 / 历史迁移残留的孤立数据）。
 * 幂等：无孤儿则零写回零广播。
 */
export function purgeOrphanMetaKeys(validProfileIds: ReadonlySet<string>): void {
  const map = loadMap();
  const doomed = Object.keys(map).filter((k) => {
    const sep = k.indexOf('::');
    if (sep <= 0) return true; // 无档案前缀的畸形键，一并清
    return !validProfileIds.has(k.slice(0, sep));
  });
  if (doomed.length === 0) return;
  for (const k of doomed) delete map[k];
  saveMap(map);
  emitUiEvent('model-meta-changed', {
    profileId: '',
    model: '',
    enabled: true,
  });
}

/**
 * 读取模型元数据。
 *
 * - `enabled` / `contextLength`：**统一树为唯一权威**（`model.enabled` /
 *   `model.contextWindow`）；树未加载或无该模型 → enabled 视为 true（无声明即启用），
 *   contextLength 回落纯启发式 `guessContextLength`（非配置声明）。
 * - `lastTest`：来自本探测结果面。
 */
export function getModelMeta(profileId: string, model: string): ModelMeta {
  const stored = loadMap()[metaKey(profileId, model)];
  const spec = modelsCatalogStore.getState().loaded
    ? modelsCatalogStore
        .getState()
        .modelIndex.get(modelRefKey({ providerId: profileId, modelId: model }))
        ?.model
    : undefined;
  return {
    profileId,
    model,
    enabled: spec ? spec.enabled !== false : true,
    contextLength: spec?.contextWindow ?? guessContextLength(model),
    ...(stored?.lastTest !== undefined ? { lastTest: stored.lastTest } : {}),
  };
}

/**
 * 内部更新探测结果：更新内存镜像、落盘 LocalStorage 并广播 uiEvents。
 *
 * 配置声明字段（enabled / contextLength）经 `modelsCatalogStore.updateModel`
 * 路由到统一树（唯一权威），不落本键。
 */
function upsertModelMeta(
  profileId: string,
  model: string,
  patch: Partial<Pick<ModelMeta, 'enabled' | 'contextLength' | 'lastTest'>>
): ModelMeta {
  if (patch.enabled !== undefined || patch.contextLength !== undefined) {
    const treePatch = {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.contextLength !== undefined
        ? { contextWindow: patch.contextLength }
        : {}),
    };
    // 树写盘为异步 IPC；探测/扫描调用方为同步面，失败由 store 自身记录 lastError。
    void modelsCatalogStore
      .updateModel(profileId, model, treePatch)
      .catch(() => undefined);
  }

  const map = loadMap();
  const k = metaKey(profileId, model);
  if (patch.lastTest !== undefined) {
    map[k] = { lastTest: patch.lastTest };
    saveMap(map);
  }
  const next = getModelMeta(profileId, model);

  // 广播 UI 事件
  emitUiEvent('model-meta-changed', {
    profileId,
    model,
    enabled: next.enabled !== false,
  });

  return next;
}

/**
 * upsert 暴露给 IPC 面（扫描连通测试写回 lastTest / contextWindow）。
 * `contextLength` 写入统一树 `contextWindow`；`lastTest` 写入探测结果面。
 */
export function upsertModelMetaExport(
  profileId: string,
  model: string,
  patch: Partial<Pick<ModelMeta, 'enabled' | 'contextLength' | 'lastTest'>>
): ModelMeta {
  return upsertModelMeta(profileId, model, patch);
}
