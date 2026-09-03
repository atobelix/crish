/**
 * 模型元数据存储（拆自 modelCatalog.ts）：localStorage 读写 + get/set 元信息。
 * 纯 LS 操作，无网络副作用。
 */

import { guessContextLength } from './modelCatalogPure';
import type {
  ModelCapabilityKey,
  ModelMeta,
} from './modelCatalogTypes';

const META_KEY = 'crish_model_meta_v1';

type MetaMap = Record<string, ModelMeta>;

function metaKey(profileId: string, model: string): string {
  return `${profileId}::${model}`;
}

function loadMap(): MetaMap {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? (o as MetaMap) : {};
  } catch {
    return {};
  }
}

function saveMap(map: MetaMap) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

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

function upsertModelMeta(
  profileId: string,
  model: string,
  patch: Partial<
    Pick<
      ModelMeta,
      'enabled' | 'contextLength' | 'lastTest' | 'displayName' | 'capabilities' | 'defaultThinkingLevel'
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
  return next;
}

export function setModelEnabled(
  profileId: string,
  model: string,
  enabled: boolean
): ModelMeta {
  return upsertModelMeta(profileId, model, { enabled });
}

export function setModelContextLength(
  profileId: string,
  model: string,
  contextLength: number | undefined
): ModelMeta {
  return upsertModelMeta(profileId, model, { contextLength });
}

export function setModelDisplayName(
  profileId: string,
  model: string,
  displayName: string | undefined
): ModelMeta {
  return upsertModelMeta(profileId, model, {
    displayName: displayName?.trim() || undefined,
  });
}

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

export function setModelThinkingLevel(
  profileId: string,
  model: string,
  defaultThinkingLevel: string | undefined
): ModelMeta {
  return upsertModelMeta(profileId, model, { defaultThinkingLevel });
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


