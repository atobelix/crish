/**
 * 本地与磁盘配置加密读写与引擎同步 Store 机制。
 *
 * PE-07 T07.4（K-01）改造：明文 key 下线——
 * - key 读写改走 config_secret_* / config_profile_apply（DPAPI），不再明文落 LS；
 * - 本地仅存 hasKey 布尔标记与元数据；
 * - 展示用 last4 掩码（maskSecretLast4 / rustProfileStore 返回的 apiKeyLast4）。
 */

import { pushRecentModel } from '../engineConfig';
import { emitUiEvent } from '../uiEvents';
import { maskSecretLast4 } from '../../utils/redact';
import {
  configProfileApply,
  configSecretClear,
  configSecretSet,
} from './rustProfileStore';
import {
  DEFAULT_PROFILES,
  type FlatModelChoice,
  type ProviderProfile,
  type ResolvedModelSelection,
} from './profileCatalog';
import {
  flattenModelChoicesFrom,
  isEmptyModelCatalog,
  isLegacySeedModelId,
  mergeModelIds,
  normalizeModelIds,
  normalizeProviderProfile,
  normalizeProviderProfiles,
  pickDefaultModelSelection,
  profileHasKey,
  stripLegacySeedModels,
} from './profileValidation';
import { ensureLegacyProfilesMigration, LEGACY_MIGRATION_FLAG_KEY } from './migrateLegacyProfiles';

const PROFILES_KEY = 'crish_provider_profiles_v1';
const ACTIVE_PROFILE_KEY = 'crish_active_profile_id';
const ACTIVE_MODEL_KEY = 'crish_active_model_id';

/**
 * 会话内密钥内存缓存（K-01 明文下线的唯一例外持有面）：
 * 仅用户主动输入密钥（saveProfileKey / setProfileKey）时写入，
 * 供模型扫描 / 连通测试（modelCatalog）使用；永不落 localStorage。
 */
const profileKeyCache = new Map<string, string>();

/** 读取会话内密钥内存缓存（无 → undefined；仅限模型扫描/连通测试等必需场景） */
export function getProfileKeyInMemory(profileId: string): string | undefined {
  return profileKeyCache.get(profileId);
}

/** 展示用密钥掩码（last4 风格；无密钥 → 空串） */
export function maskProfileKeyForDisplay(apiKeyLast4?: string | null): string {
  const last = (apiKeyLast4 || '').trim();
  if (!last) return '';
  return maskSecretLast4(`sk-...${last}`);
}

/** @internal 兼容旧内部名 */
function normalizeProfile(
  p: Partial<ProviderProfile> & { id: string }
): ProviderProfile {
  return normalizeProviderProfile(p);
}

/** 清空本机活动模型 id（删除/禁用/迁移后防幽灵展示） */
export function clearActiveModelId(): void {
  try {
    localStorage.removeItem(ACTIVE_MODEL_KEY);
  } catch {
    /* swallow-ok: 活跃模型标记清理失败仅影响重启默认选中 */
  }
}

/** 清空本机活动 profile id */
export function clearActiveProfileId(): void {
  try {
    localStorage.removeItem(ACTIVE_PROFILE_KEY);
  } catch {
    /* swallow-ok: 活跃 profile 标记清理失败仅影响重启默认选中 */
  }
}

export function getActiveProfileId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROFILE_KEY);
  } catch {
    return null;
  }
}

export function setActiveProfileId(id: string) {
  localStorage.setItem(ACTIVE_PROFILE_KEY, id);
}

export function getActiveModelId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_MODEL_KEY);
  } catch {
    return null;
  }
}

export function setActiveModelId(model: string) {
  localStorage.setItem(ACTIVE_MODEL_KEY, model.trim());
}

/**
 * 清除「幽灵」活动 model：已知旧种子/演示 id，且当前未出现在任何启用供应商的 models 列表中。
 * - 用户通过 activate / 扫描把 mimo 等写进列表 → 保留（真实选择）
 * - 列表已空或已剥离种子，但 LS 仍挂着 mimo-v2.5 → 清掉，避免空 catalog 手填路径冒充已就绪
 * 返回是否清除了 active model。
 */
export function sanitizeGhostActiveModel(
  profiles: readonly ProviderProfile[] | null | undefined
): boolean {
  const mid = (getActiveModelId() || '').trim();
  if (!mid || !isLegacySeedModelId(mid)) return false;
  const listed = (profiles || []).some(
    (p) => p && p.enabled !== false && normalizeModelIds(p.models).includes(mid)
  );
  if (listed) return false;
  clearActiveModelId();
  return true;
}

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

/**
 * 首次 / 底栏共用的配置就绪态（本地优先）。
 */
export type ProviderSetupStatus = {
  hasLocalKey: boolean;
  hasEngineKey: boolean;
  hasKey: boolean;
  hasLocalModel: boolean;
  resolvedModel: string | null;
  resolvedProfileId: string | null;
  needsKeySetup: boolean;
  needsModelSetup: boolean;
  showModelPicker: boolean;
};

export function getProviderSetupStatus(opts?: {
  engineHasApiKey?: boolean | null;
  engineModel?: string | null;
  engineOk?: boolean | null;
}): ProviderSetupStatus {
  const hasLocalKey = anyProfileHasKey();
  const engineOk = opts?.engineOk !== false;
  const hasEngineKey = Boolean(engineOk && opts?.engineHasApiKey === true);
  const hasKey = hasLocalKey || hasEngineKey;
  const hasLocalModel = anyProfileHasModel();
  const resolved = resolvePreferredModelSelection({
    ...(opts?.engineModel !== undefined ? { engineModel: opts.engineModel } : {}),
  });
  const resolvedModel = resolved?.model || null;
  const resolvedProfileId = resolved?.profileId || null;

  const needsKeySetup = !hasKey;
  const needsModelSetup = hasKey && !resolvedModel && !hasLocalModel;

  return {
    hasLocalKey,
    hasEngineKey,
    hasKey,
    hasLocalModel,
    resolvedModel,
    resolvedProfileId,
    needsKeySetup,
    needsModelSetup,
    showModelPicker: hasKey,
  };
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

/**
 * 保存密钥（K-01）：明文经 config_secret_set 落 DPAPI 凭据槽，
 * 本地仅写 hasKey 标记（不再写 p.apiKey 明文）；
 * 会话内同时写入内存缓存（模型扫描/连通测试用）。
 * 返回：DPAPI 结果 ok → hasKey=true；invoke missing（非 Tauri 环境）→
 * 降级为本地草稿标记（不落明文）；invoke 错误 → hasKey=false（不谎报已保存）。
 */
export async function setProfileKey(
  profileId: string,
  apiKey: string
): Promise<ProviderProfile[]> {
  const key = apiKey.trim();
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);
  if (!p) return list;

  if (key) profileKeyCache.set(profileId, key);
  else profileKeyCache.delete(profileId);

  const res = key
    ? await configSecretSet(profileId, key)
    : await configSecretClear(profileId);
  if (res.status === 'ok') {
    p.hasKey = Boolean(res.data?.hasKey);
  } else if (res.status === 'missing') {
    // 非 Tauri 环境（浏览器 dev）：降级为本地草稿标记（25-audit 允许）
    p.hasKey = Boolean(key);
  } else {
    p.hasKey = false;
  }
  saveProfiles(list);
  return list;
}

/**
 * 保存 Base URL；若该 profile 为当前活动项，同步到引擎（保存即生效）。
 * K-01：同步走 config_profile_apply（密钥由 Rust 从 DPAPI 槽读取），
 * 不再携带明文 key。
 */
export async function saveProfileBaseUrl(
  profileId: string,
  baseUrl: string
): Promise<{ ok: boolean; error?: string; synced: boolean }> {
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);
  if (!p) return { ok: false, error: 'profile_not_found', synced: false };

  p.baseUrl = baseUrl.trim();
  saveProfiles(list);

  if (getActiveProfileId() !== profileId) {
    return { ok: true, synced: false };
  }

  const model = (getActiveModelId() || p.models[0] || '').trim();
  const res = await configProfileApply({
    profileId,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    ...(model ? { model } : {}),
  });
  if (res.status !== 'ok' || res.data?.ok !== true) {
    const error =
      res.status === 'missing'
        ? 'engine_unavailable'
        : res.status === 'error'
          ? res.message
          : 'apply_failed';
    return { ok: false, ...(error ? { error } : {}), synced: false };
  }
  return { ok: true, synced: true };
}

/**
 * 保存密钥；若该 profile 已是活动项（或尚无活动项），同步到引擎。
 * K-01：密钥落 DPAPI（setProfileKey），同步走 config_profile_apply，
 * 全程无明文经 webview。
 */
export async function saveProfileKey(
  profileId: string,
  apiKey: string,
  opts?: { activateModel?: string }
): Promise<{ ok: boolean; error?: string; synced: boolean }> {
  const key = apiKey.trim();
  if (!key) return { ok: false, error: 'empty_key', synced: false };

  await setProfileKey(profileId, key);
  const profile = loadProfiles().find((p) => p.id === profileId);
  if (!profile) return { ok: false, error: 'profile_not_found', synced: false };
  if (!profile.hasKey) return { ok: false, error: 'key_save_failed', synced: false };

  const activeId = getActiveProfileId();
  const shouldSync =
    activeId === profileId || !activeId || Boolean(opts?.activateModel);

  if (!shouldSync) {
    return { ok: true, synced: false };
  }

  const model = (
    opts?.activateModel ||
    getActiveModelId() ||
    profile.models[0] ||
    ''
  ).trim();
  if (!model) {
    const res = await configProfileApply({
      profileId,
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    });
    if (res.status === 'ok' && res.data?.ok === true) {
      setActiveProfileId(profileId);
      return { ok: true, synced: true };
    }
    const error =
      res.status === 'missing'
        ? 'engine_unavailable'
        : res.status === 'error'
          ? res.message
          : 'apply_failed';
    return { ok: false, ...(error ? { error } : {}), synced: false };
  }

  const res = await activateProfileModel(profileId, model);
  return { ok: res.ok, ...(res.error ? { error: res.error } : {}), synced: res.ok };
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

/**
 * 本地优先的活动模型解析（对话底栏 / 启动同步共用）。
 */
export function resolvePreferredModelSelection(opts?: {
  engineModel?: string | null;
  requireInList?: boolean;
}): ResolvedModelSelection | null {
  return pickDefaultModelSelection(loadProfiles(), {
    storedProfileId: getActiveProfileId(),
    storedModel: getActiveModelId(),
    engineModel: opts?.engineModel,
    requireInList: opts?.requireInList,
  });
}

/** 展示用：本机活动模型 id（解析后），无则空串 */
export function resolveDisplayModelId(engineModel?: string | null): string {
  const resolved = resolvePreferredModelSelection(
    engineModel !== undefined ? { engineModel } : {}
  );
  if (resolved) return resolved.model;
  return (getActiveModelId() || '').trim();
}

/** 将活动选择写入 Settings.defaultModel/defaultProvider */
async function persistSelectionToAppSettings(
  profileId: string,
  model: string
): Promise<void> {
  try {
    const { clientApi } = await import('../clientApi');
    const merged = await clientApi.updateSettings({
      defaultProvider: profileId,
      defaultModel: model,
    });
    try {
      const { useSettingsStore } = await import('../../store');
      useSettingsStore.getState().setAppSettings(merged);
    } catch {
      /* swallow-ok: store 未就绪时跳过设置同步 */
    }
  } catch {
    /* swallow-ok: settings 写失败不阻断引擎切换 */
  }
}

function notifyModelChanged(profileId: string, model: string) {
  try {
    emitUiEvent('model-changed', { profileId, model });
  } catch {
    /* swallow-ok: 模型切换事件分发失败不影响已切换状态 */
  }
}

/**
 * 将指定 profile + 模型应用到引擎。
 * K-01：密钥由 Rust 从 DPAPI 槽读取（config_profile_apply），
 * webview 不再持有明文（hasLocalKey 仅由 hasKey 标记判定）。
 */
export async function activateProfileModel(
  profileId: string,
  model: string
): Promise<{
  ok: boolean;
  error?: string;
  warning?: 'no_local_key' | 'model_mismatch';
}> {
  const p = loadProfiles().find((x) => x.id === profileId);
  if (!p) return { ok: false, error: 'profile_not_found' };

  const m = model.trim();
  if (!m) return { ok: false, error: 'empty_model' };

  if (!p.models.includes(m)) {
    addModelToProfile(profileId, m);
  }

  const fresh = loadProfiles().find((x) => x.id === profileId) || p;
  const hasLocalKey = profileHasKey(fresh);

  const res = await configProfileApply({
    profileId,
    ...(fresh.baseUrl ? { baseUrl: fresh.baseUrl } : {}),
    model: m,
  });
  if (res.status !== 'ok' || res.data?.ok !== true) {
    const error =
      res.status === 'missing'
        ? 'engine_unavailable'
        : res.status === 'error'
          ? res.message
          : 'apply_failed';
    return { ok: false, ...(error ? { error } : {}) };
  }
  const applied = res.data;

  setActiveProfileId(profileId);
  setActiveModelId(m);
  pushRecentModel(m);
  notifyModelChanged(profileId, m);
  void persistSelectionToAppSettings(profileId, m);
  try {
    const { fetchEngineStatus } = await import('../engineConfig');
    const status = await fetchEngineStatus();
    if (status.ok && status.model && status.model !== m) {
      return { ok: true, warning: 'model_mismatch' };
    }
    if (!hasLocalKey || (status.ok && status.hasApiKey === false)) {
      return { ok: true, ...(!hasLocalKey ? { warning: 'no_local_key' as const } : {}) };
    }
} catch {
  /* swallow-ok: 引擎状态核验失败时按乐观路径返回，不阻断切换 */
}
return {
  ok: true,
  ...(!hasLocalKey ? { warning: 'no_local_key' as const } : {}),
  ...(applied.apiKeyLast4 ? { apiKeyLast4: applied.apiKeyLast4 } : {}),
};
}

/**
 * 扁平化「真实配置过的」模型。
 */
export function flattenModelChoices(): FlatModelChoice[] {
  return flattenModelChoicesFrom(loadProfiles());
}
