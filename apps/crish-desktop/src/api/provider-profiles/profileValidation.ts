/**
 * OAuth 档案轨校验与规范化纯函数。
 *
 * 单轨口径：本模块只服务于 LS 档案记录（OAuth/订阅身份）的规范化与展示标签；
 * 供应商/模型目录的校验在统一树侧（modelsCatalogActions / 内核 ModelsStore）。
 */

import { normalizeModelIds } from '../modelsCatalogTypes';
import {
  KNOWN_PROFILE_LABELS,
  LEGACY_SEED_MODELS,
  UNNAMED_PROFILE_LABEL,
  type ProviderProfile,
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

/** 供应商是否具备可用密钥标记（纯，不读 LS） */
export function profileHasKey(
  p: Pick<Partial<ProviderProfile>, 'hasKey' | 'apiKey'> | null | undefined
): boolean {
  if (!p) return false;
  return Boolean(p.hasKey || (typeof p.apiKey === 'string' && p.apiKey.trim()));
}

/**
 * 规范化单条档案（纯，无副作用、不 emit profiles-changed）。
 * id 必填；models 去重；name 中文安全 trim。
 *
 * PE-07 T07.4（K-01）：规范化输出**剥离并丢弃** `apiKey` 明文——
 * 明文只进 DPAPI 凭据槽（config_secret_set），绝不落 localStorage；
 * `hasKey` 布尔保留。旧对象携带的 apiKey 仅用于 hasKey 判定与一次性迁移
 * （migrateLegacyProfiles 直读原始 JSON）。
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
 * 规范化档案列表（纯）：丢弃无 id 项、按 id 保序去重（先到优先）、模型 id 去重。
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

/** 两个模型 id 集合是否一致（保序无关，纯） */
function sameModelSet(a: string[], b: readonly string[]): boolean {
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
