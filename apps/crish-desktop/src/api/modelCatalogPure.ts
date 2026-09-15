/**
 * 纯目录辅助（拆自 modelCatalog.ts）：normalize / dedupe / usable / default pick /
 * build / display labels / guess。
 * 无 LS 读写、无网络副作用，可独立单测。
 */

import type { ProviderProfile } from './providerProfiles';
import type {
  CatalogModelEntry,
  ModelMeta,
  PickDefaultCatalogOpts,
  UsableCatalogOpts,
} from './modelCatalogTypes';
import { AUTOFILL_BASELINE_2026, findAutofillModel } from './modelsAutofillBaseline';

/**
 * Unicode 安全 trim（中文/全角空格）：NFC 后去首尾空白（含 \u3000）。
 * 用于 model id / profileId 规范化；不发明 id。
 */
export function normalizeModelIdText(raw: unknown): string {
  if (raw == null) return '';
  if (
    typeof raw !== 'string' &&
    typeof raw !== 'number' &&
    typeof raw !== 'boolean'
  ) {
    return '';
  }
  let s = String(raw);
  try {
    s = s.normalize('NFC');
  } catch {
    /* ignore environments without normalize */
  }
  return s.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}

/** 目录项去重键：profileId::model（与 meta 存储键同形） */
export function catalogEntryKey(
  entry: Pick<CatalogModelEntry, 'profileId' | 'model'> | null | undefined
): string {
  if (!entry) return '';
  const profileId = normalizeModelIdText(entry.profileId);
  const model = normalizeModelIdText(entry.model);
  if (!profileId || !model) return '';
  return `${profileId}::${model}`;
}

/**
 * 规范化单条目录项（纯）。
 * profileId / model 必填；空 name 回退 profileId；非法 → null。
 */
export function normalizeCatalogEntry(
  raw: Partial<CatalogModelEntry> | null | undefined
): CatalogModelEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const profileId = normalizeModelIdText(raw.profileId);
  const model = normalizeModelIdText(raw.model);
  if (!profileId || !model) return null;
  const profileName = normalizeModelIdText(raw.profileName) || profileId;
  return {
    profileId,
    profileName,
    model,
    hasKey: Boolean(raw.hasKey),
  };
}

/**
 * 规范化目录列表（纯）：丢弃非法项；不发明演示模型。
 * 非法入参 → []。
 */
export function normalizeCatalogEntries(list: unknown): CatalogModelEntry[] {
  if (!Array.isArray(list)) return [];
  const out: CatalogModelEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const e = normalizeCatalogEntry(item as Partial<CatalogModelEntry>);
    if (e) out.push(e);
  }
  return out;
}

/**
 * 保序去重（纯）：同 profileId+model 先到优先。
 * 不合并跨供应商的同名 model（id 可撞名）。
 */
export function dedupeCatalogEntries(
  list: readonly CatalogModelEntry[] | null | undefined
): CatalogModelEntry[] {
  if (!list || list.length === 0) return [];
  const seen = new Set<string>();
  const out: CatalogModelEntry[] = [];
  for (const raw of list) {
    const e = normalizeCatalogEntry(raw);
    if (!e) continue;
    const k = catalogEntryKey(e);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** 目录项是否可用（纯）：非空 id + 可选密钥要求 */
export function isUsableCatalogEntry(
  entry: CatalogModelEntry | null | undefined,
  opts?: UsableCatalogOpts
): boolean {
  if (!entry) return false;
  const profileId = normalizeModelIdText(entry.profileId);
  const model = normalizeModelIdText(entry.model);
  if (!profileId || !model) return false;
  if (opts?.requireKey && !entry.hasKey) return false;
  return true;
}

/** 过滤可用目录项（纯） */
export function filterUsableCatalogEntries(
  list: readonly CatalogModelEntry[] | null | undefined,
  opts?: UsableCatalogOpts
): CatalogModelEntry[] {
  if (!list || list.length === 0) return [];
  return list.filter((e) => isUsableCatalogEntry(e, opts));
}

/**
 * 从目录选默认项（纯）。
 * - 空列表 / 无可用项 → null（**绝不**发明 mimo 或其它远程 vendor 演示 id）
 * - 模型身份 = (providerId, modelId) 双键：优先精确 profile+model，
 *   仅有 model 而无 profile 时**不可**跨供应商匹配，返回 null
 *   （U1：失效即置空，不强行找可用；INV-1：禁止裸 modelId 跨供应商匹配）
 * - 再优先 preferred profile，其后 hasKey，最后取首个可用
 */
export function pickDefaultCatalogEntry(
  list: readonly CatalogModelEntry[] | null | undefined,
  opts?: PickDefaultCatalogOpts
): CatalogModelEntry | null {
  const usable = filterUsableCatalogEntries(dedupeCatalogEntries(list ?? []), {
    requireKey: opts?.requireKey,
  });
  if (usable.length === 0) return null;

  const prefProfile = normalizeModelIdText(opts?.preferredProfileId ?? '');
  const prefModel = normalizeModelIdText(opts?.preferredModel ?? '');

  // 只有 modelId 没有 providerId → 身份不完整，拒绝跨供应商「同名首个」匹配。
  if (prefModel && !prefProfile) return null;

  if (prefProfile && prefModel) {
    const hit = usable.find(
      (e) => e.profileId === prefProfile && e.model === prefModel
    );
    if (hit) return hit;
  }
  if (prefProfile) {
    const hit = usable.find((e) => e.profileId === prefProfile);
    if (hit) return hit;
  }

  const preferKeyed = opts?.preferKeyed !== false;
  if (preferKeyed) {
    const keyed = usable.find((e) => e.hasKey);
    if (keyed) return keyed;
  }
  return usable[0] ?? null;
}

/**
 * 从 profile 列表构建目录项（纯，不读 meta LS）。
 * 跳过禁用供应商与空 model；可选 isModelEnabled 过滤 meta 禁用。
 * 结果已经 normalize + dedupe + usable。
 */
export function buildCatalogEntriesFromProfiles(
  profiles:
    | readonly Pick<
        ProviderProfile,
        'id' | 'name' | 'models' | 'enabled' | 'hasKey' | 'apiKey'
      >[]
    | null
    | undefined,
  isModelEnabled?: (profileId: string, model: string) => boolean
): CatalogModelEntry[] {
  if (!profiles || profiles.length === 0) return [];
  const raw: CatalogModelEntry[] = [];
  for (const p of profiles) {
    if (!p || p.enabled === false) continue;
    const profileId = normalizeModelIdText(p.id);
    if (!profileId) continue;
    const profileName = normalizeModelIdText(p.name) || profileId;
    const hasKey = Boolean(
      p.hasKey || (typeof p.apiKey === 'string' && p.apiKey.trim())
    );
    const models = Array.isArray(p.models) ? p.models : [];
    for (const m of models) {
      const model = normalizeModelIdText(m);
      if (!model) continue;
      if (isModelEnabled && !isModelEnabled(profileId, model)) continue;
      raw.push({ profileId, profileName, model, hasKey });
    }
  }
  return filterUsableCatalogEntries(dedupeCatalogEntries(raw));
}

/** 展示标签：「供应商 · 模型」；空 → 中文「未选择模型」 */
export function catalogEntryDisplayLabel(
  entry: CatalogModelEntry | null | undefined
): string {
  if (!entry) return '未选择模型';
  const name =
    normalizeModelIdText(entry.profileName) ||
    normalizeModelIdText(entry.profileId);
  const model = normalizeModelIdText(entry.model);
  if (!name && !model) return '未选择模型';
  if (!name) return model;
  if (!model) return name;
  return `${name} · ${model}`;
}

/** 启用状态中文标签（纯） */
export function formatModelEnabledLabel(
  enabled: boolean | null | undefined
): string {
  return enabled === false ? '已禁用' : '已启用';
}

/** 连通测试结果中文标签（纯） */
export function formatLastTestLabel(
  lastTest: ModelMeta['lastTest'] | null | undefined
): string {
  if (!lastTest) return '未测试';
  if (lastTest.ok) {
    const ms =
      typeof lastTest.latencyMs === 'number' &&
      Number.isFinite(lastTest.latencyMs)
        ? ` ${Math.round(lastTest.latencyMs)}ms`
        : '';
    return `连通正常${ms}`;
  }
  const err = typeof lastTest.error === 'string' ? lastTest.error.trim() : '';
  return err ? `连通失败：${err}` : '连通失败';
}

/**
 * 空目录守卫（纯）：无任何可用目录项时 true。
 * 调用方据此不得注入硬编码演示默认。
 */
export function isEmptyCatalog(
  list: readonly CatalogModelEntry[] | null | undefined
): boolean {
  return (
    filterUsableCatalogEntries(dedupeCatalogEntries(list ?? [])).length === 0
  );
}

/**
 * 模块级缓存：key = `${baselineVersion}:${model}`。
 * 钉入 autofill 基线 version，热更/替换基线后旧条目自动失配；
 * 配合 resetContextLengthCache() 供 store 热更后显式清空。
 */
let contextLengthCache = new Map<string, number | undefined>();

function contextCacheKey(model: string): string {
  return `${AUTOFILL_BASELINE_2026.version}:${model}`;
}

/**
 * 清空 contextLength 缓存。autofill 基线热更 / HMR / 测试重置后调用，
 * 避免 guessContextLength 返回陈旧窗口值。
 */
export function resetContextLengthCache(): void {
  contextLengthCache = new Map();
}

/**
 * 彻底废除 KNOWN_CONTEXT 128K 假上限硬编码与正则盲猜。
 * 模型上下文容量 100% 取自模型自身真实配置（如 1,048,576、1,050,000 等）。
 * 兜底未声明或未配置时返回 undefined，绝不在 128K 处粗暴腰斩。
 */
export function guessContextLength(model: string): number | undefined {
  if (!model) return undefined;
  const key = contextCacheKey(model);
  if (contextLengthCache.has(key)) {
    return contextLengthCache.get(key);
  }
  const autofill = findAutofillModel(model);
  const result =
    typeof autofill?.contextWindow === 'number' && autofill.contextWindow > 0
      ? autofill.contextWindow
      : undefined;
  contextLengthCache.set(key, result);
  return result;
}

/**
 * 上下文长度展示（纯）：空/非法 → 中文破折号「—」。
 * 百万级用 M，千级用 k（与设置页 / Picker 一致）。
 */
export function formatContextLabel(n?: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** 上下文长度中文前缀标签，如「上下文 128k」；未知 →「上下文 —」 */
export function formatContextLabelZh(n?: number | null): string {
  return `上下文 ${formatContextLabel(n)}`;
}
