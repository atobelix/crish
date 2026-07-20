/**
 * 多服务商配置（正式版）
 *
 * 契约：模型/密钥主轨 = LS profiles + daemon `update-config`（ENGINE-CONFIG）。
 * - 本地保存多组 profile（地址 / 密钥 / 模型列表）
 * - 引擎侧同一时刻只有一组生效，通过 update-config 切换
 * - 打开应用时把当前活动 profile 同步回引擎
 * - 活动模型解析：**本机已选优先**，不回落到厂商演示 id（如引擎默认 mimo）
 */

import { updateEngineConfig, pushRecentModel, type EngineConfigUpdate } from './engineConfig';
import { emitUiEvent } from './uiEvents';

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

/**
 * 首次空库种子：只提供服务商壳，**不**硬编码具体模型 id。
 * 模型列表由用户扫描 / 手填；避免列表里永远挂着 mimo 等写死项。
 */
const DEFAULT_PROFILES: ProviderProfile[] = [
  {
    id: 'opencode-go',
    name: 'OpenCode Go 订阅',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    models: ['deepseek-v4-flash', 'glm-5', 'kimi-k2'],
    hasKey: false,
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen 订阅',
    baseUrl: 'https://opencode.ai/zen/v1',
    models: ['deepseek-v4-flash', 'gemini-3-flash', 'claude-3-7-sonnet'],
    hasKey: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hasKey: false,
  },
  {
    id: 'qwen',
    name: '千问 Qwen Portal',
    baseUrl: 'https://portal.qwen.ai/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-coder'],
    hasKey: false,
  },
  {
    id: 'openai',
    name: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'o3-mini'],
    hasKey: false,
  },
  {
    id: 'anthropic',
    name: 'Anthropic 兼容',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-3-7-sonnet'],
    hasKey: false,
  },
  {
    id: 'flowbit',
    name: 'Flowbit',
    baseUrl: 'https://api.flowbit.me',
    models: [],
    hasKey: false,
  },
];

/** 导出只读默认壳，便于单测断言契约 */
export function getDefaultProviderProfiles(): ProviderProfile[] {
  return DEFAULT_PROFILES.map((p) => ({ ...p, models: [...p.models] }));
}

/**
 * 已知壳 id → 中文/产品展示名（纯函数；不读 LS，不发事件）。
 * 自定义 id 无条目时由调用方回退到 name/id。
 */
export const KNOWN_PROFILE_LABELS: Readonly<Record<string, string>> = {
  'opencode-go': 'OpenCode Go 订阅',
  'opencode-zen': 'OpenCode Zen 订阅',
  deepseek: 'DeepSeek 官方',
  qwen: '千问 Qwen Portal',
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
  flowbit: 'Flowbit',
};

const UNNAMED_PROFILE_LABEL = '未命名服务商';

/**
 * Unicode 安全 trim（中文/全角空格）：NFC 后去首尾空白（含 \u3000）。
 * 禁止按字节/半个 UTF-16 码元裁切。
 */
export function normalizeProfileLabelText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw;
  try {
    s = s.normalize('NFC');
  } catch {
    /* ignore environments without normalize */
  }
  // trim 含全角空格与常见 Unicode 空白
  return s.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}

/**
 * 展示用供应商标签（纯）：优先用户 name，再已知中文壳名，再 id。
 * 空/纯空白 name 不污染 UI。
 */
export function profileDisplayLabel(
  profileOrId: string | Pick<ProviderProfile, 'id' | 'name'> | null | undefined,
): string {
  if (profileOrId == null) return UNNAMED_PROFILE_LABEL;
  if (typeof profileOrId === 'string') {
    const id = normalizeProfileLabelText(profileOrId);
    if (!id) return UNNAMED_PROFILE_LABEL;
    return KNOWN_PROFILE_LABELS[id] || id;
  }
  const id = normalizeProfileLabelText(profileOrId.id);
  const name = normalizeProfileLabelText(profileOrId.name);
  if (name) return name;
  if (id && KNOWN_PROFILE_LABELS[id]) return KNOWN_PROFILE_LABELS[id];
  return id || UNNAMED_PROFILE_LABEL;
}

/**
 * 按 Unicode 码点截断展示名（中文安全；emoji 按码点，不拆 surrogate）。
 * maxChars < 1 时返回空串。
 */
export function truncateProfileLabel(label: string, maxChars: number): string {
  const text = normalizeProfileLabelText(label);
  if (maxChars < 1) return '';
  const chars = Array.from(text);
  if (chars.length <= maxChars) return chars.join('');
  if (maxChars === 1) return '…';
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

/**
 * 模型 id 列表规范化（纯）：trim、丢弃空项、保序去重。
 * 不发明演示 id；非法入参 → []。
 */
export function normalizeModelIds(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    if (raw == null) continue;
    const m = String(raw).trim();
    if (!m) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/**
 * 合并多组模型 id 并去重（纯）。扫描结果 ∪ 本地列表时使用。
 * 先出现的保留顺序；后续列表仅追加新 id。
 */
export function mergeModelIds(...lists: unknown[]): string[] {
  const merged: unknown[] = [];
  for (const list of lists) {
    if (Array.isArray(list)) merged.push(...list);
    else if (list != null && list !== '') merged.push(list);
  }
  return normalizeModelIds(merged);
}

/** 供应商是否具备可用密钥标记（纯，不读 LS） */
export function profileHasKey(
  p: Pick<Partial<ProviderProfile>, 'hasKey' | 'apiKey'> | null | undefined,
): boolean {
  if (!p) return false;
  return Boolean(p.hasKey || (typeof p.apiKey === 'string' && p.apiKey.trim()));
}

/** 启用中且 models 非空（纯） */
export function profileHasUsableModels(
  p: Pick<ProviderProfile, 'enabled' | 'models'> | null | undefined,
): boolean {
  if (!p || p.enabled === false) return false;
  return normalizeModelIds(p.models).length > 0;
}

/**
 * 空模型目录守卫（纯）：无任何启用供应商带模型 id。
 * 空 catalog 时不得回落 mimo 等演示默认。
 */
export function isEmptyModelCatalog(
  profiles: readonly Pick<ProviderProfile, 'enabled' | 'models'>[] | null | undefined,
): boolean {
  if (!profiles || profiles.length === 0) return true;
  return !profiles.some((p) => profileHasUsableModels(p));
}

/**
 * 规范化单条 profile（纯，无副作用、不 emit profiles-changed）。
 * id 必填；models 去重；name 中文安全 trim。
 */
export function normalizeProviderProfile(
  p: Partial<ProviderProfile> & { id: string },
): ProviderProfile {
  const id = String(p.id ?? '').trim();
  const nameRaw = normalizeProfileLabelText(p.name);
  const name =
    nameRaw ||
    (id && KNOWN_PROFILE_LABELS[id]) ||
    id ||
    UNNAMED_PROFILE_LABEL;
  return {
    id: id || 'unknown',
    name,
    baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '',
    models: normalizeModelIds(p.models),
    hasKey: profileHasKey(p),
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : undefined,
    enabled: p.enabled !== false,
  };
}

/**
 * 规范化 profile 列表（纯）：丢弃无 id 项、按 id 保序去重（先到优先）、模型 id 去重。
 * 非法入参 → []（不回落默认壳；默认壳由 load 路径决定）。
 */
export function normalizeProviderProfiles(list: unknown): ProviderProfile[] {
  if (!Array.isArray(list)) return [];
  const out: ProviderProfile[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String((raw as { id?: unknown }).id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(normalizeProviderProfile({ ...(raw as Partial<ProviderProfile>), id }));
  }
  return out;
}

/** @internal 兼容旧内部名 */
function normalizeProfile(p: Partial<ProviderProfile> & { id: string }): ProviderProfile {
  return normalizeProviderProfile(p);
}

/**
 * 旧版 DEFAULT_PROFILES 曾硬编码的演示/示例模型。
 * 无密钥且 models 集合与旧种子完全一致时，load 时剥离（本地优先，去 mimo 污染）。
 * 用户已配密钥或自行改过列表则不动。
 */
const LEGACY_SEED_MODELS: Readonly<Record<string, readonly string[]>> = {
  flowbit: ['mimo-v2.5'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  deepseek: ['deepseek-chat', 'deepseek-v4-flash'],
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4'],
};

/** 所有旧种子/演示 model id（跨壳扁平；用于幽灵 active 与 pick 守卫） */
const LEGACY_SEED_MODEL_ID_SET: ReadonlySet<string> = new Set(
  Object.values(LEGACY_SEED_MODELS).flatMap((ids) => [...ids]),
);

/**
 * 是否为旧版硬编码种子 / 引擎演示 model id（如 mimo-v2.5）。
 * 纯函数；不读 LS。用于拒绝「不在列表中的幽灵演示 id」冒充已选。
 */
export function isLegacySeedModelId(model: unknown): boolean {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m) return false;
  return LEGACY_SEED_MODEL_ID_SET.has(m);
}

function sameModelSet(a: string[], b: readonly string[]): boolean {
  const sa = normalizeModelIds(a).slice().sort();
  const sb = normalizeModelIds([...b]).slice().sort();
  if (sa.length !== sb.length) return false;
  return sa.every((v, i) => v === sb[i]);
}

/** 无密钥且仍为旧种子列表 → 清空 models */
export function stripLegacySeedModels(p: ProviderProfile): ProviderProfile {
  if (profileHasKey(p)) return p;
  const seed = LEGACY_SEED_MODELS[p.id];
  if (!seed || seed.length === 0) return p;
  if (!sameModelSet(p.models || [], seed)) return p;
  return { ...p, models: [] };
}

/** 清空本机活动模型 id（删除/禁用/迁移后防幽灵展示） */
export function clearActiveModelId(): void {
  try {
    localStorage.removeItem(ACTIVE_MODEL_KEY);
  } catch {
    /* ignore */
  }
}

/** 清空本机活动 profile id */
export function clearActiveProfileId(): void {
  try {
    localStorage.removeItem(ACTIVE_PROFILE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 清除「幽灵」活动 model：已知旧种子/演示 id，且当前未出现在任何启用供应商的 models 列表中。
 * - 用户通过 activate / 扫描把 mimo 等写进列表 → 保留（真实选择）
 * - 列表已空或已剥离种子，但 LS 仍挂着 mimo-v2.5 → 清掉，避免空 catalog 手填路径冒充已就绪
 * 返回是否清除了 active model。
 */
export function sanitizeGhostActiveModel(
  profiles: readonly ProviderProfile[] | null | undefined,
): boolean {
  const mid = (getActiveModelId() || '').trim();
  if (!mid || !isLegacySeedModelId(mid)) return false;
  const listed = (profiles || []).some(
    (p) =>
      p &&
      p.enabled !== false &&
      normalizeModelIds(p.models).includes(mid),
  );
  if (listed) return false;
  clearActiveModelId();
  return true;
}

export function loadProfiles(): ProviderProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) {
      saveProfiles(DEFAULT_PROFILES);
      const seeded = DEFAULT_PROFILES.map((p) => ({ ...p, models: [...p.models] }));
      // 空库种子后仍清幽灵演示 active（如历史 LS 残留 mimo）
      sanitizeGhostActiveModel(seeded);
      return seeded;
    }
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) {
      const seeded = DEFAULT_PROFILES.map((p) => ({ ...p, models: [...p.models] }));
      sanitizeGhostActiveModel(seeded);
      return seeded;
    }
    const normalized = normalizeProviderProfiles(arr);
    if (normalized.length === 0) {
      const seeded = DEFAULT_PROFILES.map((p) => ({ ...p, models: [...p.models] }));
      sanitizeGhostActiveModel(seeded);
      return seeded;
    }
    let changed = false;
    // 去重/裁空白后与原文不一致时也回写，避免脏列表常驻 LS
    if (normalized.length !== arr.length) changed = true;
    const migrated = normalized.map((p) => {
      const next = stripLegacySeedModels(p);
      if (next.models.length !== p.models.length) changed = true;
      return next;
    });
    // 模型去重：原文含重复 id 时也需要持久化清理
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
      // 直接写 LS，避免 saveProfiles 递归触发额外副作用前完成 sanitize
      localStorage.setItem(
        PROFILES_KEY,
        JSON.stringify(migrated.map((p) => normalizeProviderProfile(p))),
      );
      try {
        emitUiEvent('profiles-changed');
      } catch {
        /* ignore */
      }
    }
    // 始终清幽灵演示 active（不依赖 models 是否刚迁移；防 residual mimo）
    sanitizeGhostActiveModel(migrated);
    return migrated;
  } catch {
    const seeded = DEFAULT_PROFILES.map((p) => ({ ...p, models: [...p.models] }));
    sanitizeGhostActiveModel(seeded);
    return seeded;
  }
}

export function saveProfiles(list: ProviderProfile[]) {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify(list.map((p) => normalizeProfile(p))),
  );
  try {
    emitUiEvent('profiles-changed');
  } catch {
    /* ignore */
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
 *
 * - needsKeySetup：本机无密钥且引擎也无密钥 → 应走向导/设置，勿刷 toast
 * - needsModelSetup：已有密钥（本机或引擎）但本机无可用模型选择 → 允许手填 model id
 * - 绝不因引擎演示默认 model（如 mimo）而认为「已配好」
 */
export type ProviderSetupStatus = {
  hasLocalKey: boolean;
  hasEngineKey: boolean;
  hasKey: boolean;
  hasLocalModel: boolean;
  /** 本机可解析出的活动模型（resolvePreferred，不含未知引擎演示 id） */
  resolvedModel: string | null;
  resolvedProfileId: string | null;
  needsKeySetup: boolean;
  needsModelSetup: boolean;
  /** 底栏是否应展示模型选择器（有密钥即可；空列表靠手填） */
  showModelPicker: boolean;
};

export function getProviderSetupStatus(opts?: {
  engineHasApiKey?: boolean | null;
  engineModel?: string | null;
  /** 引擎 get-status 是否成功（false 时不把 engine key 当已就绪） */
  engineOk?: boolean | null;
}): ProviderSetupStatus {
  const hasLocalKey = anyProfileHasKey();
  const engineOk = opts?.engineOk !== false;
  const hasEngineKey = Boolean(engineOk && opts?.engineHasApiKey === true);
  const hasKey = hasLocalKey || hasEngineKey;
  const hasLocalModel = anyProfileHasModel();
  const resolved = resolvePreferredModelSelection({
    engineModel: opts?.engineModel,
  });
  const resolvedModel = resolved?.model || null;
  const resolvedProfileId = resolved?.profileId || null;

  // 本机无密钥且引擎也无 → 需要密钥引导
  const needsKeySetup = !hasKey;
  // 有密钥但既无本机列表模型、也无本机已解析活动模型 → 需要手填/扫描
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
    // 有密钥就展示选择器（空 models 时手填）；无密钥时隐藏，改走 soft-hint
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
  // 至少保留一组默认，避免空列表
  const next = list.length > 0 ? list : DEFAULT_PROFILES.map((p) => ({ ...p, models: [...p.models] }));
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
export function setProfileEnabled(profileId: string, enabled: boolean): ProviderProfile[] {
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
 * 保存 Base URL；若该 profile 为当前活动项，同步到引擎（保存即生效）。
 */
export async function saveProfileBaseUrl(
  profileId: string,
  baseUrl: string,
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
  const update: EngineConfigUpdate = {
    baseUrl: p.baseUrl || undefined,
    ...(p.apiKey?.trim() ? { apiKey: p.apiKey } : {}),
    ...(model ? { model } : {}),
  };
  const res = await updateEngineConfig(update);
  return { ok: res.ok, error: res.error, synced: res.ok };
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
  // 若删掉的是当前活动模型，清空活动 model，避免 UI 继续展示幽灵 id
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
  newModel: string,
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

export type ResolvedModelSelection = {
  profileId: string;
  model: string;
  source:
    | 'stored_active'
    | 'stored_model_match'
    | 'active_profile_first'
    | 'first_available'
    | 'engine_match';
};

export type PickDefaultModelOptions = {
  storedProfileId?: string | null;
  storedModel?: string | null;
  engineModel?: string | null;
  /** 为 true 时要求 model 必须在 profile.models 中 */
  requireInList?: boolean;
};

/**
 * 纯函数：从给定 profiles + 选择提示安全挑选默认模型。
 *
 * 优先级（与 resolvePreferred 一致，勿倒退）：
 * 1. stored_active
 * 2. stored_model_match
 * 3. active_profile_first
 * 4. engine_match（仅当 model 已在本地列表）
 * 5–6. first_available（先有密钥，再任一有模型）
 *
 * **空 catalog 守卫**：无可用模型时返回 null，绝不发明 mimo 等演示 id。
 * 无 LS / 无 profiles-changed 副作用。
 */
export function pickDefaultModelSelection(
  profilesInput: readonly ProviderProfile[] | null | undefined,
  opts?: PickDefaultModelOptions,
): ResolvedModelSelection | null {
  const profiles = (profilesInput || []).filter((p) => p && p.enabled !== false);
  if (profiles.length === 0) return null;

  // 规范化每条 models，避免脏空白/重复影响 includes 与 [0]
  const normalized = profiles.map((p) => ({
    ...p,
    models: normalizeModelIds(p.models),
  }));

  if (isEmptyModelCatalog(normalized)) {
    // 仍允许 stored_active 手填 id（requireInList=false 时），但不采纳引擎/旧种子演示幽灵
    const storedProfileId = (opts?.storedProfileId || '').trim();
    const storedModel = (opts?.storedModel || '').trim();
    const requireInList = opts?.requireInList === true;
    if (storedProfileId && storedModel && !requireInList) {
      const p = normalized.find((x) => x.id === storedProfileId);
      // 旧种子/演示 id 未出现在列表中 → 视为幽灵，不冒充已选（防止 mimo 默认）
      if (p && !(isLegacySeedModelId(storedModel) && !p.models.includes(storedModel))) {
        return { profileId: p.id, model: storedModel, source: 'stored_active' };
      }
    }
    return null;
  }

  const storedProfileId = (opts?.storedProfileId || '').trim();
  const storedModel = (opts?.storedModel || '').trim();
  const engineModel = (opts?.engineModel || '').trim();
  const requireInList = opts?.requireInList === true;

  const byId = (id: string | null | undefined) =>
    (id ? normalized.find((p) => p.id === id) : undefined) || null;

  // 1) 本机已选 profile + model
  if (storedProfileId && storedModel) {
    const p = byId(storedProfileId);
    if (p) {
      const inList = p.models.includes(storedModel);
      // 幽灵演示 id（如 mimo）不在列表 → 跳过，继续后续优先级
      if (isLegacySeedModelId(storedModel) && !inList) {
        /* fall through */
      } else if (!requireInList || inList) {
        return { profileId: p.id, model: storedModel, source: 'stored_active' };
      }
    }
  }

  // 2) 仅有 model id：在任一列表中定位
  if (storedModel) {
    const p = normalized.find((x) => x.models.includes(storedModel));
    if (p) {
      return { profileId: p.id, model: storedModel, source: 'stored_model_match' };
    }
  }

  // 3) 活动 profile 首个模型
  if (storedProfileId) {
    const p = byId(storedProfileId);
    const m = p?.models[0];
    if (p && m) {
      return { profileId: p.id, model: m, source: 'active_profile_first' };
    }
  }

  // 4) 引擎回报的 model **仅当** 已在某用户列表中（拒绝未知演示 id）
  if (engineModel) {
    const p = normalized.find((x) => x.models.includes(engineModel));
    if (p) {
      return { profileId: p.id, model: engineModel, source: 'engine_match' };
    }
  }

  // 5) 已配密钥且有模型
  const keyed = normalized.find((p) => profileHasKey(p) && p.models.length > 0);
  if (keyed) {
    return {
      profileId: keyed.id,
      model: keyed.models[0],
      source: 'first_available',
    };
  }

  // 6) 任一有模型的 profile
  const withModels = normalized.find((p) => p.models.length > 0);
  if (withModels) {
    return {
      profileId: withModels.id,
      model: withModels.models[0],
      source: 'first_available',
    };
  }

  return null;
}

/** 纯：仅返回 model id，空 catalog → null */
export function pickDefaultModelId(
  profiles: readonly ProviderProfile[] | null | undefined,
  opts?: PickDefaultModelOptions,
): string | null {
  return pickDefaultModelSelection(profiles, opts)?.model ?? null;
}

/**
 * 本地优先的活动模型解析（对话底栏 / 启动同步共用）。
 * 读 LS 后委托纯函数 pickDefaultModelSelection；契约见该函数。
 */
export function resolvePreferredModelSelection(opts?: {
  engineModel?: string | null;
  /** 为 true 时要求 model 必须在 profile.models 中 */
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
  const resolved = resolvePreferredModelSelection({ engineModel });
  if (resolved) return resolved.model;
  // 仍有裸存的 active model（profile 被删等）时展示它，但不当作权威
  return (getActiveModelId() || '').trim();
}

/** 将活动选择写入 Settings.defaultModel/defaultProvider，避免 hydrate 回落到空/旧值 */
async function persistSelectionToAppSettings(
  profileId: string,
  model: string,
): Promise<void> {
  try {
    const { clientApi } = await import('./clientApi');
    const merged = await clientApi.updateSettings({
      defaultProvider: profileId,
      defaultModel: model,
    });
    try {
      const { useLayoutStore } = await import('../store/layoutStore');
      useLayoutStore.getState().setAppSettings(merged);
    } catch {
      /* store 未就绪时忽略 */
    }
  } catch {
    /* settings 写失败不阻断引擎切换 */
  }
}

function notifyModelChanged(profileId: string, model: string) {
  try {
    emitUiEvent('model-changed', { profileId, model });
  } catch {
    /* ignore */
  }
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

  // 保证列表与活动选择一致（手填 / 首次向导也能进 Picker）
  if (!p.models.includes(m)) {
    addModelToProfile(profileId, m);
  }

  const fresh = loadProfiles().find((x) => x.id === profileId) || p;
  const hasLocalKey = Boolean(fresh.apiKey?.trim());
  const update: EngineConfigUpdate = {
    model: m,
    baseUrl: fresh.baseUrl || undefined,
    ...(hasLocalKey ? { apiKey: fresh.apiKey } : {}),
  };

  const res = await updateEngineConfig(update);
  if (res.ok) {
    setActiveProfileId(profileId);
    setActiveModelId(m);
    pushRecentModel(m);
    notifyModelChanged(profileId, m);
    void persistSelectionToAppSettings(profileId, m);
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
 * 无活动项时，用 resolvePreferred 选出本地可用模型（不采用引擎演示默认）。
 */
export async function syncActiveProfileToEngine(): Promise<{
  ok: boolean;
  error?: string;
  applied?: { profileId: string; model: string };
}> {
  const profiles = loadProfiles();
  const resolved = resolvePreferredModelSelection();
  let profileId = resolved?.profileId || getActiveProfileId();
  let model = resolved?.model || getActiveModelId() || '';

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

/**
 * 纯：从给定 profiles 扁平化模型选择（跳过禁用；models 去重）。
 * 不读 LS、不 emit。空 catalog → []。
 */
export function flattenModelChoicesFrom(
  profiles: readonly ProviderProfile[] | null | undefined,
): FlatModelChoice[] {
  const out: FlatModelChoice[] = [];
  for (const p of profiles || []) {
    if (!p || p.enabled === false) continue;
    const name = profileDisplayLabel(p);
    const hasKey = profileHasKey(p);
    for (const m of normalizeModelIds(p.models)) {
      out.push({
        profileId: p.id,
        profileName: name,
        model: m,
        hasKey,
      });
    }
  }
  return out;
}

/**
 * 扁平化「真实配置过的」模型（来自用户 profile.models，非写死 vendor 表）。
 * 跳过禁用供应商；不含 meta 禁用过滤（见 modelCatalog / ModelPicker）。
 */
export function flattenModelChoices(): FlatModelChoice[] {
  return flattenModelChoicesFrom(loadProfiles());
}
