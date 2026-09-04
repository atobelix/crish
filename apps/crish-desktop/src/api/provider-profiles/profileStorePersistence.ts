/**
 * Profile 列表持久化与迁移守卫。
 *
 * 从 profileStore.ts 拆出（T4-11 SR-06-R3）：localStorage 读写、
 * 默认种子、明文迁移守卫（PE-07 T07.4-B），以及 profile 增删改。
 */

import { emitUiEvent } from '../uiEvents';
import {
  DEFAULT_PROFILES,
  type ProviderProfile,
} from './profileCatalog';
import {
  isEmptyModelCatalog,
  normalizeModelIds,
  normalizeProviderProfile,
  normalizeProviderProfiles,
  profileHasKey,
  stripLegacySeedModels,
  mergeModelIds,
} from './profileValidation';
import {
  ensureLegacyProfilesMigration,
  LEGACY_MIGRATION_FLAG_KEY,
} from './migrateLegacyProfiles';
import { recordPendingContextState } from './contextStatePending';
import { purgeMetaForProfile, purgeOrphanMetaKeys } from '../modelCatalogMeta';
import {
  getActiveProfileId,
  clearActiveProfileId,
  clearActiveModelId,
  getActiveModelId,
  setActiveModelId,
  sanitizeGhostActiveModel,
} from './profileActiveSelection';
import { normalizeProfile } from './profileKeySecret';

const PROFILES_KEY = 'crish_provider_profiles_v1';

export function saveProfiles(list: ProviderProfile[]) {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify(list.map((p) => normalizeProfile(p)))
  );
  try {
    emitUiEvent('profiles-changed');
  } catch {
    /* swallow-ok: 变更事件分发失败不影响已落盘的 profile */
  }
  // I1-α②（扩展点 A）：context-state 感知注入产生器——状态切换（模型/
  // 服务商/权限/思考档位）的快照文本暂存，下一次 run-task 携带排入
  // PendingMessageQueue（group_id=context-state 去重）→ 时间线注入。
  // 17 审计纪律：仅「切换发生」感知进 seq；配置/偏好本身留在配置带。
  recordPendingContextState();
}

export function loadProfiles(): ProviderProfile[] {
  // PE-07 T07.4-B：首次 loadProfiles 前置钩子——幂等标记未置时触发一次性
  // 明文迁移（模块级门控；失败不阻断启动）。迁移完成前不写回 LS，
  // 防止「剥离明文时未落 DPAPI」造成密钥丢失（见下方 changed 写回守卫）。
  void ensureLegacyProfilesMigration();
  const migrationPending = () => {
    try {
      return localStorage.getItem(LEGACY_MIGRATION_FLAG_KEY) !== '1';
    } catch {
      return false;
    }
  };
  const rawHasPlaintextKey = () => {
    try {
      const raw = localStorage.getItem(PROFILES_KEY);
      return Boolean(raw && /"apiKey"\s*:/.test(raw));
    } catch {
      return false;
    }
  };

  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) {
      saveProfiles(DEFAULT_PROFILES);
      const seeded = DEFAULT_PROFILES.map((p) => ({
        ...p,
        models: [...p.models],
      }));
      sanitizeGhostActiveModel(seeded);
      return seeded;
    }
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) {
      const seeded = DEFAULT_PROFILES.map((p) => ({
        ...p,
        models: [...p.models],
      }));
      sanitizeGhostActiveModel(seeded);
      return seeded;
    }
    const normalized = normalizeProviderProfiles(arr);
    if (normalized.length === 0) {
      const seeded = DEFAULT_PROFILES.map((p) => ({
        ...p,
        models: [...p.models],
      }));
      sanitizeGhostActiveModel(seeded);
      return seeded;
    }
    let changed = false;
    if (normalized.length !== arr.length) changed = true;
    const migrated = normalized.map((p) => {
      const next = stripLegacySeedModels(p);
      if (next.models.length !== p.models.length) changed = true;
      return next;
    });
    if (!changed) {
      for (let i = 0; i < arr.length; i++) {
        const rawModels = (arr[i] as { models?: unknown })?.models;
        if (Array.isArray(rawModels)) {
          const cleaned = normalizeModelIds(rawModels);
          if (cleaned.length !== rawModels.length) {
            changed = true;
            break;
          }
        }
      }
    }
    if (changed) {
      // 明文迁移守卫：存量仍含 apiKey 且未置幂等标记 → 本次写回交给迁移负责
      // （迁移确认 DPAPI 落盘后自行剥离写回），此处跳过防密钥丢失。
      if (!(migrationPending() && rawHasPlaintextKey())) {
        localStorage.setItem(
          PROFILES_KEY,
          JSON.stringify(migrated.map((p) => normalizeProviderProfile(p)))
        );
        try {
          emitUiEvent('profiles-changed');
        } catch {
          /* swallow-ok: 迁移后事件分发失败不影响迁移结果 */
        }
      }
    }
    sanitizeGhostActiveModel(migrated);
    // 孤儿 meta 清扫：档案已删除的 meta 键（profileId::model 前缀）一次性收敛
    purgeOrphanMetaKeys(new Set(migrated.map((p) => p.id)));
    return migrated;
  } catch {
    const seeded = DEFAULT_PROFILES.map((p) => ({
      ...p,
      models: [...p.models],
    }));
    sanitizeGhostActiveModel(seeded);
    return seeded;
  }
}

export function getActiveProfile(): ProviderProfile | null {
  const id = getActiveProfileId();
  if (!id) return null;
  return loadProfiles().find((p) => p.id === id) || null;
}

/** 是否至少有一个服务商已配置密钥（用于首次引导） */
export function anyProfileHasKey(): boolean {
  return loadProfiles().some((p) => profileHasKey(p));
}

/** 任一启用供应商在本地列表中有模型 id（扫描或手填） */
export function anyProfileHasModel(): boolean {
  return !isEmptyModelCatalog(loadProfiles());
}

export function upsertProfile(profile: ProviderProfile) {
  const list = loadProfiles();
  const next = normalizeProfile(profile);
  const i = list.findIndex((p) => p.id === next.id);
  if (i >= 0) list[i] = next;
  else list.push(next);
  saveProfiles(list);
  return list;
}

export function createCustomProfile(input: {
  name: string;
  baseUrl?: string;
  models?: string[];
}): ProviderProfile {
  const name = input.name.trim() || '自定义服务商';
  const id = `custom-${Date.now().toString(36)}`;
  const entry = normalizeProfile({
    id,
    name,
    baseUrl: (input.baseUrl || 'https://api.openai.com/v1').trim(),
    models: input.models?.length ? input.models : [],
    hasKey: false,
  });
  upsertProfile(entry);
  return entry;
}

export function removeProfile(profileId: string): ProviderProfile[] {
  const list = loadProfiles().filter((p) => p.id !== profileId);
  const next =
    list.length > 0
      ? list
      : DEFAULT_PROFILES.map((p) => ({ ...p, models: [...p.models] }));
  saveProfiles(next);
  if (getActiveProfileId() === profileId) {
    clearActiveProfileId();
    clearActiveModelId();
  }
  // 档案删除即 GC：该档案的模型元数据键一并清扫（避免孤儿残留）
  purgeMetaForProfile(profileId);
  return next;
}

/**
 * 启用/禁用供应商。禁用当前活动供应商时清空活动选择，避免幽灵 id。
 */
export function setProfileEnabled(
  profileId: string,
  enabled: boolean
): ProviderProfile[] {
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);
  if (!p) return list;
  p.enabled = enabled;
  saveProfiles(list);
  if (!enabled && getActiveProfileId() === profileId) {
    clearActiveProfileId();
    clearActiveModelId();
  }
  return loadProfiles();
}

export function addModelToProfile(profileId: string, model: string) {
  const m = String(model ?? '').trim();
  if (!m) return loadProfiles();
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);
  if (!p) return list;
  const next = mergeModelIds(p.models, [m]);
  if (next.length === p.models.length && p.models.includes(m)) return list;
  p.models = next;
  saveProfiles(list);
  return list;
}

export function removeModelFromProfile(profileId: string, model: string) {
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);
  if (!p) return list;
  p.models = p.models.filter((x) => x !== model);
  saveProfiles(list);
  if (getActiveProfileId() === profileId && getActiveModelId() === model) {
    clearActiveModelId();
  }
  return list;
}

/**
 * 重命名 profile 内模型 id（保序）。
 * 新 id 已存在则合并去重；活动模型一并迁移。
 */
export function renameModelInProfile(
  profileId: string,
  oldModel: string,
  newModel: string
): ProviderProfile[] {
  const from = String(oldModel ?? '').trim();
  const to = String(newModel ?? '').trim();
  if (!from || !to || from === to) return loadProfiles();
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);
  if (!p) return list;
  const models = normalizeModelIds(p.models);
  const idx = models.indexOf(from);
  if (idx < 0) return list;
  const next = models.slice();
  next[idx] = to;
  p.models = normalizeModelIds(next);
  saveProfiles(list);
  if (getActiveProfileId() === profileId && getActiveModelId() === from) {
    setActiveModelId(to);
  }
  return list;
}

export function renameProfile(profileId: string, name: string) {
  const n = name.trim();
  if (!n) return loadProfiles();
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);
  if (!p) return list;
  p.name = n;
  saveProfiles(list);
  return list;
}