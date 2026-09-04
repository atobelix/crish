/**
 * 模型元数据存储（拆自 modelCatalog.ts）：localStorage 读写 + get/set 元信息。
 * 引入 memoryMetaCache 单例内存镜像，杜绝 O(N*M) 同步反序列化雪崩（耗时从 200ms 骤降至 <0.2ms）。
 * 写入操作自动同步内存与 LocalStorage，并通过 uiEvents 广播 'model-meta-changed'。
 */

import { guessContextLength } from './modelCatalogPure';
import type {
  ModelCapabilityKey,
  ModelMeta,
} from './modelCatalogTypes';
import { emitUiEvent } from './uiEvents';

const META_KEY = 'crish_model_meta_v1';

type MetaMap = Record<string, ModelMeta>;

/** 模块级单例内存镜像缓存 */
let memoryMetaCache: MetaMap | null = null;

function metaKey(profileId: string, model: string): string {
  return `${profileId}::${model}`;
}

/**
 * 存量数据一次性收敛迁移：历史能力键 `vision` 已被 `image` 取代。
 * 读时搬移（vision → image 取或）并删除旧键，随后写回存储；迁移幂等——
 * 迁移过的数据不再含 vision 键，二次加载零改动。
 */
function migrateLegacyCapabilities(map: MetaMap): boolean {
  let changed = false;
  for (const meta of Object.values(map)) {
    const caps = meta.capabilities as Record<string, unknown> | undefined;
    if (caps && 'vision' in caps) {
      caps.image = Boolean(caps.image) || caps.vision === true;
      delete caps.vision;
      changed = true;
    }
  }
  return changed;
}

/**
 * 加载元数据字典（优先命中内存单例镜像；首次加载触发存量迁移）
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
    const map = o && typeof o === 'object' ? (o as MetaMap) : {};
    const migrated = migrateLegacyCapabilities(map);
    memoryMetaCache = map;
    if (migrated) {
      saveMap(map);
    }
    return map;
  } catch {
    memoryMetaCache = {};
    return memoryMetaCache;
  }
}

/**
 * 保存元数据字典（同步写穿透：立即更新内存镜像 + 持久化 LocalStorage）
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
 * 读取模型元数据（O(1) 内存直读）
 */
export function getModelMeta(profileId: string, model: string): ModelMeta {
  const map = loadMap();
  const k = metaKey(profileId, model);
  const stored = map[k];
  if (stored) {
    return {
      ...stored,
      enabled: stored.enabled !== false,
      contextLength: stored.contextLength ?? guessContextLength(model),
    };
  }
  return {
    profileId,
    model,
    enabled: true,
    contextLength: guessContextLength(model),
  };
}

/**
 * 内部更新元信息：更新内存镜像、落盘 LocalStorage 并广播 uiEvents
 */
function upsertModelMeta(
  profileId: string,
  model: string,
  patch: Partial<
    Pick<
      ModelMeta,
      | 'enabled'
      | 'contextLength'
      | 'maxOutputTokens'
      | 'lastTest'
      | 'displayName'
      | 'capabilities'
      | 'defaultThinkingLevel'
      | 'protocol'
    >
  >
): ModelMeta {
  const map = loadMap();
  const k = metaKey(profileId, model);
  const prev = getModelMeta(profileId, model);
  const next: ModelMeta = {
    ...prev,
    ...patch,
    profileId,
    model,
    capabilities:
      patch.capabilities !== undefined
        ? { ...(prev.capabilities || {}), ...patch.capabilities }
        : prev.capabilities,
  };
  // 空展示名不落盘
  if (typeof next.displayName === 'string') {
    const dn = next.displayName.trim();
    next.displayName = dn || undefined;
  }
  map[k] = next;
  saveMap(map);

  // 广播 UI 事件
  emitUiEvent('model-meta-changed', {
    profileId,
    model,
    enabled: next.enabled !== false,
    displayName: next.displayName,
  });

  return next;
}

/**
 * 设置模型启用/停用状态
 */
export function setModelEnabled(
  profileId: string,
  model: string,
  enabled: boolean
): ModelMeta {
  return upsertModelMeta(profileId, model, { enabled });
}

/**
 * 设置模型上下文长度
 */
export function setModelContextLength(
  profileId: string,
  model: string,
  contextLength: number | undefined
): ModelMeta {
  return upsertModelMeta(profileId, model, { contextLength });
}

/**
 * 设置模型最大输出 token 上限
 */
export function setModelMaxOutputTokens(
  profileId: string,
  model: string,
  maxOutputTokens: number | undefined
): ModelMeta {
  return upsertModelMeta(profileId, model, { maxOutputTokens });
}

/**
 * 设置模型展示名
 */
export function setModelDisplayName(
  profileId: string,
  model: string,
  displayName: string | undefined
): ModelMeta {
  return upsertModelMeta(profileId, model, {
    displayName: displayName?.trim() || undefined,
  });
}

/**
 * 设置模型单项能力标签
 */
export function setModelCapability(
  profileId: string,
  model: string,
  key: ModelCapabilityKey,
  on: boolean
): ModelMeta {
  const prev = getModelMeta(profileId, model);
  return upsertModelMeta(profileId, model, {
    capabilities: { ...(prev.capabilities || {}), [key]: on },
  });
}

/**
 * 设置模型默认思考档位
 */
export function setModelThinkingLevel(
  profileId: string,
  model: string,
  defaultThinkingLevel: string | undefined
): ModelMeta {
  return upsertModelMeta(profileId, model, { defaultThinkingLevel });
}

/**
 * 设置模型调用协议（'openai/chat' | 'openai/responses' | 'anthropic/messages'）
 */
export function setModelProtocol(
  profileId: string,
  model: string,
  protocol: 'openai/chat' | 'openai/responses' | 'anthropic/messages' | undefined
): ModelMeta {
  return upsertModelMeta(profileId, model, { protocol });
}

/** 展示名：优先 displayName，否则 model id */
export function formatModelDisplayName(
  profileId: string,
  model: string,
  meta?: ModelMeta | null
): string {
  const m = meta || getModelMeta(profileId, model);
  const dn = typeof m.displayName === 'string' ? m.displayName.trim() : '';
  return dn || model;
}

/** upsert 暴露给 IPC 面（扫描连通测试写回 lastTest / contextWindow） */
export function upsertModelMetaExport(
  profileId: string,
  model: string,
  patch: Partial<
    Pick<
      ModelMeta,
      'enabled' | 'contextLength' | 'lastTest' | 'displayName' | 'capabilities'
    >
  >
): ModelMeta {
  return upsertModelMeta(profileId, model, patch);
}
