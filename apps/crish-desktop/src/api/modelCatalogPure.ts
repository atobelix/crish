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
 * - 优先 preferred profile+model → preferred model → preferred profile
 * - 再优先 hasKey，最后取首个可用
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

  if (prefProfile && prefModel) {
    const hit = usable.find(
      (e) => e.profileId === prefProfile && e.model === prefModel
    );
    if (hit) return hit;
  }
  if (prefModel) {
    const hit = usable.find((e) => e.model === prefModel);
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
 * 常见模型默认上下文（仅作缺省展示，可被扫描/手改覆盖）。
 * 来源：docs/cache-optimization/00-vendor-model-pricing-catalog.md（2026-08-02）：
 * - gpt-5.6 / gpt-5.5：§2.2（1,050,000）；gpt-4.1 仍受 §2.1 24h 保留支持，沿用 1M
 * - claude-sonnet-5 / claude-haiku-4-5：§1.4（litellm 副本）；opus-4-5 / sonnet-4-5 沿用 200k
 * - deepseek-v4-flash / deepseek-v4-pro：§3.1（1,000,000）
 * - gemini-3.x 窗口 catalog 未收录，沿用旧值 1M（风险项，见 R0.5 审计）
 */
const KNOWN_CONTEXT: Record<string, number> = {
  'gpt-5.6': 1_050_000,
  'gpt-5.5': 1_050_000,
  'gpt-4.1': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'mimo-v2.5': 128_000,
  'gemini-3.6-flash': 1_000_000,
  'gemini-3.5-flash': 1_000_000,
};

export function guessContextLength(model: string): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  for (const [k, v] of Object.entries(KNOWN_CONTEXT)) {
    if (m === k || m.includes(k) || k.includes(m)) return v;
  }
  if (m.includes('128k') || m.includes('128000')) return 128_000;
  if (m.includes('32k')) return 32_000;
  if (m.includes('200k')) return 200_000;
  if (m.includes('1m') || m.includes('1000k')) return 1_000_000;
  return undefined;
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
