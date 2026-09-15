/**
 * 服务商与模型目录校验、规范化纯函数。
 */

import {
  KNOWN_PROFILE_LABELS,
  LEGACY_SEED_MODEL_ID_SET,
  LEGACY_SEED_MODELS,
  UNNAMED_PROFILE_LABEL,
  type FlatModelChoice,
  type PickDefaultModelOptions,
  type ProviderProfile,
  type ResolvedModelSelection,
} from './profileCatalog';

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
  return s.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}

/**
 * 展示用供应商标签（纯）：优先用户 name，再已知中文壳名，再 id。
 * 空/纯空白 name 不污染 UI。
 */
export function profileDisplayLabel(
  profileOrId: string | Pick<ProviderProfile, 'id' | 'name'> | null | undefined
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

/** 展示名折叠键：NFC trim 后的可见标签。 */
export function profileDisplayNameKey(
  profileOrName: string | Pick<ProviderProfile, 'id' | 'name'> | null | undefined
): string {
  if (typeof profileOrName === 'string') {
    return normalizeProfileLabelText(profileOrName);
  }
  return normalizeProfileLabelText(profileDisplayLabel(profileOrName));
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
  p: Pick<Partial<ProviderProfile>, 'hasKey' | 'apiKey'> | null | undefined
): boolean {
  if (!p) return false;
  return Boolean(p.hasKey || (typeof p.apiKey === 'string' && p.apiKey.trim()));
}

/**
 * 同名折叠胜者比较：返回 >0 则 a 优于 b。
 * 密钥 > 模型数 > 已知种子 id > 非 custom-。同分视为不优于（保留先出现的）。
 */
function cmpPickerFoldWinner(a: ProviderProfile, b: ProviderProfile): number {
  const keyA = profileHasKey(a) ? 1 : 0;
  const keyB = profileHasKey(b) ? 1 : 0;
  if (keyA !== keyB) return keyA - keyB;
  const modelsA = normalizeModelIds(a.models).length;
  const modelsB = normalizeModelIds(b.models).length;
  if (modelsA !== modelsB) return modelsA - modelsB;
  const seedA = KNOWN_PROFILE_LABELS[a.id] ? 1 : 0;
  const seedB = KNOWN_PROFILE_LABELS[b.id] ? 1 : 0;
  if (seedA !== seedB) return seedA - seedB;
  const builtinA = a.id.startsWith('custom-') ? 0 : 1;
  const builtinB = b.id.startsWith('custom-') ? 0 : 1;
  return builtinA - builtinB;
}

/**
 * 按展示名折叠：同名只留一行（I8：种子 opencode-go 与 custom/preset 拷贝不得两行）。
 * 不改 enabled 过滤——由调用方决定。保序：第一次出现的标签位置。
 */
export function foldProfilesByDisplayName(
  profiles: readonly ProviderProfile[] | null | undefined
): ProviderProfile[] {
  if (!profiles || profiles.length === 0) return [];
  const winners = new Map<string, ProviderProfile>();
  const order: string[] = [];
  for (const p of profiles) {
    if (!p) continue;
    const key = profileDisplayNameKey(p);
    if (!key) continue;
    const prev = winners.get(key);
    if (!prev) {
      winners.set(key, p);
      order.push(key);
      continue;
    }
    if (cmpPickerFoldWinner(p, prev) > 0) winners.set(key, p);
  }
  return order.map((k) => winners.get(k)!);
}

/**
 * 按展示名找已有行（含停用）。同分走 fold 胜者，供添加预设绑已有、禁止再造 custom。
 */
export function findProfileByDisplayName(
  profiles: readonly ProviderProfile[] | null | undefined,
  name: string
): ProviderProfile | undefined {
  const key = profileDisplayNameKey(name);
  if (!key) return undefined;
  const matches: ProviderProfile[] = [];
  for (const p of profiles || []) {
    if (p && profileDisplayNameKey(p) === key) matches.push(p);
  }
  return foldProfilesByDisplayName(matches)[0];
}

/** 启用中且 models 非空（纯） */
export function profileHasUsableModels(
  p: Pick<ProviderProfile, 'enabled' | 'models'> | null | undefined
): boolean {
  if (!p || p.enabled === false) return false;
  return normalizeModelIds(p.models).length > 0;
}

/**
 * 空模型目录守卫（纯）：无任何启用供应商带模型 id。
 * 空 catalog 时不得回落 mimo 等演示默认。
 */
export function isEmptyModelCatalog(
  profiles:
    readonly Pick<ProviderProfile, 'enabled' | 'models'>[] | null | undefined
): boolean {
  if (!profiles || profiles.length === 0) return true;
  return !profiles.some((p) => profileHasUsableModels(p));
}

/**
 * 规范化单条 profile（纯，无副作用、不 emit profiles-changed）。
 * id 必填；models 去重；name 中文安全 trim。
 *
 * PE-07 T07.4（K-01）：规范化输出**剥离并丢弃** `apiKey` 明文——
 * 明文只进 DPAPI 凭据槽（config_secret_set / config_profile_apply）与会话内
 * 内存缓存，绝不落 localStorage；`hasKey` 布尔保留。旧对象携带的 apiKey
 * 仅用于 hasKey 判定与一次性迁移（migrateLegacyProfiles 直读原始 JSON）。
 */
export function normalizeProviderProfile(
  p: Partial<ProviderProfile> & { id: string }
): ProviderProfile {
  const id = String(p.id ?? '').trim();
  const nameRaw = normalizeProfileLabelText(p.name);
  const name =
    nameRaw || (id && KNOWN_PROFILE_LABELS[id]) || id || UNNAMED_PROFILE_LABEL;
  return {
    id: id || 'unknown',
    name,
    baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '',
    protocol: p.protocol,
    models: normalizeModelIds(p.models),
    hasKey: profileHasKey(p),
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
    out.push(
      normalizeProviderProfile({ ...(raw as Partial<ProviderProfile>), id })
    );
  }
  return out;
}

/**
 * 是否为旧版硬编码种子 / 引擎演示 model id（如 mimo-v2.5）。
 * 纯函数；不读 LS。用于拒绝「不在列表中的幽灵演示 id」冒充已选。
 */
export function isLegacySeedModelId(model: unknown): boolean {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m) return false;
  return LEGACY_SEED_MODEL_ID_SET.has(m);
}

export function sameModelSet(a: string[], b: readonly string[]): boolean {
  const sa = normalizeModelIds(a).slice().sort();
  const sb = normalizeModelIds([...b])
    .slice()
    .sort();
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

/**
 * 纯：从给定 profiles 扁平化模型选择（跳过禁用；models 去重）。
 * 不读 LS、不 emit。空 catalog → []。
 */
export function flattenModelChoicesFrom(
  profiles: readonly ProviderProfile[] | null | undefined
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
 * 纯函数：从给定 profiles + 选择提示安全挑选默认模型。
 *
 * 模型身份 = (providerId, modelId) 复合键（总方案 §2.2 / INV-1）：
 * 解析必须由 storedProfileId 限定供应商，**禁止只按 modelId 跨供应商匹配**。
 *
 * 优先级（全部带 providerId，勿倒退）：
 * 1. storedProfileId + storedModel 且该 provider 的 models 含该 model → 采纳（stored_active）
 * 2. storedProfileId（无 storedModel 或不在列表）→ 该 provider 首个模型 → 采纳（active_profile_first）
 * 3. 无 storedProfileId → 返回 null —— **不跨厂商回落**（U1 裁决）：
 *    活动选择失效（供应商关闭/删除、模型停用/删除）时置空，交由 UI 引导用户重选；
 *    绝不自动匹配同名字段、绝不自动选「第一个可用」。
 *
 * `opts.engineModel` 已不用于定位：引擎回报的 model 不带 provider 信息，无法构成
 * 复合身份（plans/01 §5.1）；入参保留仅为兼容既有调用方，调用方清理由主控裁决。
 *
 * **空 catalog 守卫**：无可用模型时返回 null，绝不发明 mimo 等演示 id。
 * 无 LS / 无 profiles-changed 副作用。
 */
export function pickDefaultModelSelection(
  profilesInput: readonly ProviderProfile[] | null | undefined,
  opts?: PickDefaultModelOptions
): ResolvedModelSelection | null {
  const profiles = (profilesInput || []).filter(
    (p) => p && p.enabled !== false
  );
  if (profiles.length === 0) return null;

  // 规范化每条 models，避免脏空白/重复影响 includes 与 [0]
  const normalized = profiles.map((p) => ({
    ...p,
    models: normalizeModelIds(p.models),
  }));

  if (isEmptyModelCatalog(normalized)) {
    const storedProfileId = (opts?.storedProfileId || '').trim();
    const storedModel = (opts?.storedModel || '').trim();
    const requireInList = opts?.requireInList === true;
    if (storedProfileId && storedModel && !requireInList) {
      const p = normalized.find((x) => x.id === storedProfileId);
      if (
        p &&
        !(isLegacySeedModelId(storedModel) && !p.models.includes(storedModel))
      ) {
        return { profileId: p.id, model: storedModel, source: 'stored_active' };
      }
    }
    return null;
  }

  const storedProfileId = (opts?.storedProfileId || '').trim();
  const storedModel = (opts?.storedModel || '').trim();
  const requireInList = opts?.requireInList === true;

  const byId = (id: string | null | undefined) =>
    (id ? normalized.find((p) => p.id === id) : undefined) || null;

  // 1) 本机已选 profile + model（已由 providerId 限定，非跨厂商）
  if (storedProfileId && storedModel) {
    const p = byId(storedProfileId);
    if (p) {
      const inList = p.models.includes(storedModel);
      if (isLegacySeedModelId(storedModel) && !inList) {
        /* fall through */
      } else if (!requireInList || inList) {
        return { profileId: p.id, model: storedModel, source: 'stored_active' };
      }
    }
  }

  // 2) 仅有 profile id：取该 provider 首个模型（同 provider 内，不跨厂商）
  if (storedProfileId) {
    const p = byId(storedProfileId);
    const m = p?.models[0];
    if (p && m) {
      return { profileId: p.id, model: m, source: 'active_profile_first' };
    }
  }

  // 3) 无 providerId → 置空（U1）：不跨厂商回落、不自动选「第一个可用」
  return null;
}

/** 纯：仅返回 model id，空 catalog → null */
export function pickDefaultModelId(
  profiles: readonly ProviderProfile[] | null | undefined,
  opts?: PickDefaultModelOptions
): string | null {
  return pickDefaultModelSelection(profiles, opts)?.model ?? null;
}

/**
 * 该供应商是否已配置凭据（凭据壳 hasKey / apiKey 字面）。
 * 对话选择器用它判定「可用」：未配置的 yaml 预置壳不占列表，
 * 避免选择后 activateProfileModel 报 profile_not_found。
 */
