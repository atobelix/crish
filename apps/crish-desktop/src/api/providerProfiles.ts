/**
 * 多服务商配置（正式版）
 *
 * - 本地保存多组 profile（地址 / 密钥 / 模型列表）
 * - 引擎侧同一时刻只有一组生效，通过 update-config 切换
 * - 打开应用时尽量把当前活动 profile 同步回引擎
 */

import { updateEngineConfig, pushRecentModel, type EngineConfigUpdate } from './engineConfig';

export type ProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  /** 是否已保存密钥（不回显完整密钥） */
  hasKey: boolean;
  /** 仅本机桌面单用户存储 */
  apiKey?: string;
  enabled?: boolean;
};

const PROFILES_KEY = 'crish_provider_profiles_v1';
const ACTIVE_PROFILE_KEY = 'crish_active_profile_id';
const ACTIVE_MODEL_KEY = 'crish_active_model_id';

const DEFAULT_PROFILES: ProviderProfile[] = [
  {
    id: 'flowbit',
    name: 'Flowbit / 默认',
    baseUrl: 'https://api.flowbit.me',
    models: ['mimo-v2.5'],
    hasKey: false,
  },
  {
    id: 'openai',
    name: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
    hasKey: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-v4-flash'],
    hasKey: false,
  },
  {
    id: 'anthropic',
    name: 'Anthropic 兼容',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5', 'claude-opus-4'],
    hasKey: false,
  },
];

function normalizeProfile(p: Partial<ProviderProfile> & { id: string }): ProviderProfile {
  return {
    id: p.id,
    name: (p.name || p.id).trim() || p.id,
    baseUrl: (p.baseUrl || '').trim(),
    models: Array.isArray(p.models)
      ? p.models.map((m) => String(m).trim()).filter(Boolean)
      : [],
    hasKey: Boolean(p.hasKey || (p.apiKey && String(p.apiKey).trim())),
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : undefined,
    enabled: p.enabled !== false,
  };
}

export function loadProfiles(): ProviderProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) {
      saveProfiles(DEFAULT_PROFILES);
      return DEFAULT_PROFILES.map((p) => ({ ...p }));
    }
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) {
      return DEFAULT_PROFILES.map((p) => ({ ...p }));
    }
    return arr.map((p: ProviderProfile) => normalizeProfile(p));
  } catch {
    return DEFAULT_PROFILES.map((p) => ({ ...p }));
  }
}

export function saveProfiles(list: ProviderProfile[]) {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify(list.map((p) => normalizeProfile(p))),
  );
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
  localStorage.setItem(ACTIVE_MODEL_KEY, model);
}

export function getActiveProfile(): ProviderProfile | null {
  const id = getActiveProfileId();
  if (!id) return null;
  return loadProfiles().find((p) => p.id === id) || null;
}

/** 是否至少有一个服务商已配置密钥（用于首次引导） */
export function anyProfileHasKey(): boolean {
  return loadProfiles().some((p) => p.hasKey || Boolean(p.apiKey?.trim()));
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
  // 至少保留一组默认，避免空列表
  const next = list.length > 0 ? list : DEFAULT_PROFILES.map((p) => ({ ...p }));
  saveProfiles(next);
  if (getActiveProfileId() === profileId) {
    try {
      localStorage.removeItem(ACTIVE_PROFILE_KEY);
    } catch {
      /* ignore */
    }
  }
  return next;
}

export function setProfileKey(profileId: string, apiKey: string) {
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);
  if (!p) return list;
  p.apiKey = apiKey;
  p.hasKey = Boolean(apiKey.trim());
  saveProfiles(list);
  return list;
}

/**
 * 保存密钥；若该 profile 已是活动项（或尚无活动项），同步到引擎。
 */
export async function saveProfileKey(
  profileId: string,
  apiKey: string,
  opts?: { activateModel?: string },
): Promise<{ ok: boolean; error?: string; synced: boolean }> {
  const key = apiKey.trim();
  if (!key) return { ok: false, error: 'empty_key', synced: false };

  setProfileKey(profileId, key);
  const profile = loadProfiles().find((p) => p.id === profileId);
  if (!profile) return { ok: false, error: 'profile_not_found', synced: false };

  const activeId = getActiveProfileId();
  const shouldSync =
    activeId === profileId ||
    !activeId ||
    Boolean(opts?.activateModel);

  if (!shouldSync) {
    return { ok: true, synced: false };
  }

  const model =
    (opts?.activateModel || getActiveModelId() || profile.models[0] || '').trim();
  if (!model) {
    // 仅推密钥与地址，等用户再选模型
    const res = await updateEngineConfig({
      apiKey: key,
      baseUrl: profile.baseUrl || undefined,
    });
    if (res.ok) setActiveProfileId(profileId);
    return { ok: res.ok, error: res.error, synced: res.ok };
  }

  const res = await activateProfileModel(profileId, model);
  return { ok: res.ok, error: res.error, synced: res.ok };
}

export function addModelToProfile(profileId: string, model: string) {
  const m = model.trim();
  if (!m) return loadProfiles();
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);
  if (!p) return list;
  if (!p.models.includes(m)) p.models = [...p.models, m];
  saveProfiles(list);
  return list;
}

export function removeModelFromProfile(profileId: string, model: string) {
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);
  if (!p) return list;
  p.models = p.models.filter((x) => x !== model);
  saveProfiles(list);
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

/** 将指定 profile + 模型应用到引擎 */
export async function activateProfileModel(
  profileId: string,
  model: string,
): Promise<{ ok: boolean; error?: string; warning?: 'no_local_key' | 'model_mismatch' }> {
  const p = loadProfiles().find((x) => x.id === profileId);
  if (!p) return { ok: false, error: 'profile_not_found' };

  const m = model.trim();
  if (!m) return { ok: false, error: 'empty_model' };

  const hasLocalKey = Boolean(p.apiKey?.trim());
  const update: EngineConfigUpdate = {
    model: m,
    baseUrl: p.baseUrl || undefined,
    ...(hasLocalKey ? { apiKey: p.apiKey } : {}),
  };

  const res = await updateEngineConfig(update);
  if (res.ok) {
    setActiveProfileId(profileId);
    setActiveModelId(m);
    pushRecentModel(m);
    // 回读引擎状态，避免 config-updated 成功但实际未切换
    try {
      const { fetchEngineStatus } = await import('./engineConfig');
      const status = await fetchEngineStatus();
      if (status.ok && status.model && status.model !== m) {
        return { ok: true, warning: 'model_mismatch' };
      }
      if (!hasLocalKey || (status.ok && status.hasApiKey === false)) {
        return { ok: true, warning: hasLocalKey ? undefined : 'no_local_key' };
      }
    } catch {
      /* ignore verify errors */
    }
    return {
      ok: true,
      warning: hasLocalKey ? undefined : 'no_local_key',
    };
  }
  return res;
}

/**
 * 引擎就绪后：把本地活动 profile 写回引擎（密钥 / 地址 / 模型）。
 * 无活动项时，若仅有一个已配密钥的 profile，则自动启用其首个模型。
 */
export async function syncActiveProfileToEngine(): Promise<{
  ok: boolean;
  error?: string;
  applied?: { profileId: string; model: string };
}> {
  const profiles = loadProfiles();
  let profileId = getActiveProfileId();
  let model = getActiveModelId() || '';

  if (!profileId) {
    const withKey = profiles.find((p) => p.hasKey || p.apiKey?.trim());
    if (!withKey) return { ok: true };
    profileId = withKey.id;
    model = withKey.models[0] || '';
  }

  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return { ok: true };

  if (!model) model = profile.models[0] || '';
  if (!model && !profile.apiKey?.trim()) return { ok: true };

  if (model) {
    const res = await activateProfileModel(profile.id, model);
    if (res.ok) {
      return { ok: true, applied: { profileId: profile.id, model } };
    }
    return { ok: false, error: res.error };
  }

  const res = await updateEngineConfig({
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl || undefined,
  });
  if (res.ok) setActiveProfileId(profile.id);
  return { ok: res.ok, error: res.error };
}

export type FlatModelChoice = {
  profileId: string;
  profileName: string;
  model: string;
  hasKey: boolean;
};

export function flattenModelChoices(): FlatModelChoice[] {
  const out: FlatModelChoice[] = [];
  for (const p of loadProfiles()) {
    if (p.enabled === false) continue;
    for (const m of p.models) {
      out.push({
        profileId: p.id,
        profileName: p.name,
        model: m,
        hasKey: p.hasKey || Boolean(p.apiKey?.trim()),
      });
    }
  }
  return out;
}
