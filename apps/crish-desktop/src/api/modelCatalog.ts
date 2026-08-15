/**
 * 模型目录元数据：启用状态、上下文长度、扫描与连通测试。
 * 与 providerProfiles 配合：提供商上级，模型下级。
 *
 * 纯目录辅助（normalize / dedupe / usable / default pick）不写死远程 vendor 演示 id；
 * 空 catalog 不得回落 mimo 等硬编码默认。
 */

import { loadProfiles, type ProviderProfile } from './providerProfiles';
import { invokeResult } from './tauriInvoke';
import {
  providerProbePing,
  providerProbeScanModels,
  type ScannedModel as WireScannedModel,
} from './provider-profiles/rustProfileStore';
import {
  applyCatalogCacheSnapshot,
  type CatalogCacheSnapshot,
  type CatalogSnapshotPrice,
  type CatalogTier,
} from './pricingStore';

const META_KEY = 'crish_model_meta_v1';

/** 模型能力开关（手配；扫描不发明） */
export type ModelCapabilityKey = 'tools' | 'vision' | 'reasoning';

export const MODEL_CAPABILITY_OPTIONS: ReadonlyArray<{
  key: ModelCapabilityKey;
  label: string;
}> = [
  { key: 'tools', label: '工具调用' },
  { key: 'vision', label: '视觉' },
  { key: 'reasoning', label: '推理' },
];

export type ModelCapabilities = Partial<Record<ModelCapabilityKey, boolean>>;

export type ModelMeta = {
  profileId: string;
  model: string;
  /** 展示名称（可与 model id 不同） */
  displayName?: string | undefined;
  /** 默认 true */
  enabled: boolean;
  /** 上下文 token 上限（可手改） */
  contextLength?: number | undefined;
  /** 支持的能力 */
  capabilities?: ModelCapabilities | undefined;
  lastTest?:
    | {
        ok: boolean;
        latencyMs?: number | undefined;
        at: number;
        error?: string | undefined;
      }
    | undefined;
};

/**
 * Picker / 目录扁平项（纯数据结构，可脱离 LS 运算）。
 * 仅承载用户真实配置过的 profile+model，不表示远程演示表。
 */
export type CatalogModelEntry = {
  profileId: string;
  profileName: string;
  model: string;
  hasKey: boolean;
};

type MetaMap = Record<string, ModelMeta>;

function metaKey(profileId: string, model: string): string {
  return `${profileId}::${model}`;
}

// ─── 纯目录辅助（无 LS / 无网络副作用）─────────────────────────────────────

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

export type UsableCatalogOpts = {
  /** 为 true 时仅保留已配密钥的项；默认 false */
  requireKey?: boolean | undefined;
};

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

export type PickDefaultCatalogOpts = {
  preferredProfileId?: string | null;
  preferredModel?: string | null;
  /** 优先有密钥项；默认 true */
  preferKeyed?: boolean;
  /** 仅在有密钥集合中挑选；默认 false */
  requireKey?: boolean;
};

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

export function guessModelCapabilities(model: string): ModelCapabilities {
  if (!model) return { tools: true };
  const m = model.toLowerCase();
  const reasoning =
    m.includes('reasoner') ||
    m.includes('r1') ||
    m.includes('v4') ||
    m.includes('o1') ||
    m.includes('o3') ||
    m.includes('thinking') ||
    m.includes('k2') ||
    m.includes('deepseek');
  const vision =
    m.includes('vision') ||
    m.includes('vl') ||
    m.includes('4o') ||
    m.includes('gemini') ||
    m.includes('claude') ||
    m.includes('flash');
  return { reasoning, vision, tools: true };
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
      'enabled' | 'contextLength' | 'lastTest' | 'displayName' | 'capabilities'
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

/** 模型 id 变更时迁移元数据键 */

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

/** 能力摘要，如「工具 · 视觉」；全关/无 → 空串 */

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

/** 扫描提供商模型列表（OpenAI 兼容 /models） */
export async function scanProviderModels(
  profile: ProviderProfile
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const fresh = loadProfiles().find((p) => p.id === profile.id) || profile;
  try {
    const res = await providerProbeScanModels(fresh.id);
    if (res.status === 'ok') {
      const data = res.data;
      if (data.ok && data.models.length > 0) {
        const modelNames = data.models.map((m: WireScannedModel) => m.model);
        for (const m of data.models) {
          if (m.contextWindow && m.contextWindow > 0) {
            upsertModelMeta(fresh.id, m.model, {
              contextLength: m.contextWindow,
            });
          }
        }
        return { ok: true, models: modelNames };
      }
      return {
        ok: false,
        models: [],
        error: data.error || '未能检测到服务器可用模型',
      };
    }
    if (res.status === 'error') {
      return { ok: false, models: [], error: res.message };
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, models: [], error };
  }
  return { ok: false, models: [], error: '扫描服务未就绪' };
}

// ─── P3 扫描结果上送（catalog_refresh；T-25）────────────────────────────

/** 扫描上送单模型（catalog_refresh wire，camelCase；缺省字段 Rust 侧不合并） */
export type ScannedModel = {
  /** API 模型标识（扫描列表原样；空串 Rust 侧忽略） */
  model: string;
  /** 厂商；缺省时 Rust 回退 catalog_refresh 的 provider 参数作 vendor 键 */
  vendor?: string | undefined;
  /** 上下文窗口（≤0 视为缺失，不发送） */
  contextWindow?: number | undefined;
  /** 输出上限（扫描结果不提供，恒缺省） */
  maxOutputTokens?: number | undefined;
  /** 能力位猜测（对齐 ModelCapabilityKey 三键） */
  capabilities?: ModelCapabilities | undefined;
};

/**
 * 扫描结果 → catalog_refresh 上送形状（纯）。
 * 仅映射窗口 / 能力位；vendor / maxOutputTokens 扫描不提供 → 缺省。
 */
export function buildScannedModelWire(
  model: string,
  contextWindow?: number | undefined,
  capabilities?: ModelCapabilities | undefined
): ScannedModel {
  const m = normalizeModelIdText(model);
  const out: ScannedModel = { model: m };
  if (!m) return out;
  if (contextWindow && contextWindow > 0) out.contextWindow = contextWindow;
  if (capabilities && Object.keys(capabilities).length > 0) {
    out.capabilities = { ...capabilities };
  }
  return out;
}

/**
 * 扫描结果上送合并（P3 步骤 5b / §3.1.3 数据来源策略 2）。
 *
 * 经 Tauri `catalog_refresh` 命令合并（仅窗口 / 能力位，不覆盖价格）；
 * 命令缺失 / invoke 失败 / 非 Tauri 环境一律降级：console.warn 记录，
 * 绝不抛出——扫描流程不因上送失败而中断（invokeResult 本身不抛，外层
 * try/catch 兜底保证恒不抛）。
 */
export async function uploadScannedModels(
  provider: string,
  scan: readonly ScannedModel[]
): Promise<void> {
  try {
    const res = await invokeResult<unknown>('catalog_refresh', {
      provider,
      scan,
    });
    if (res.status !== 'ok') {
      console.warn(
        `模型目录上送合并跳过（${res.status}）${res.status === 'error' ? `：${res.message}` : ''}，不阻塞扫描`
      );
    }
  } catch (e) {
    console.warn('模型目录上送合并失败，不阻塞扫描：', e);
  }
}

// ─── P3 步骤 5a：catalog_get 快照拉取（DEEPCHECK-02 P0 断链修复）────────────
//
// 此前 `catalog_get` 仅 manifest 登记、前端零调用：catalogSnapshot 恒 null，
// resolve4dPrices 永远取不到 source='snapshot'，Rust 目录真源与前端定价完全
// 脱钩（两端双份价格无同步）。本面接线：启动 / 设置页加载时拉取一次快照 →
// applyCatalogCacheSnapshot（版本号幂等，天然安全）；invoke 失败降级静态表。

/** catalog_get wire 条目（Rust ModelCatalogEntry camelCase 子集：定价面字段） */
export interface CatalogSnapshotEntryWire {
  model?: string;
  apiModel?: string;
  inputPrice?: number | null;
  outputPrice?: number | null;
  cacheReadPrice?: number | null;
  cacheWritePrice?: number | null;
  tieredPricing?: Array<{
    minTokens?: number;
    maxTokens?: number | null;
    inputPrice?: number | null;
    outputPrice?: number | null;
    cacheReadPrice?: number | null;
    cacheWritePrice?: number | null;
  }> | null;
}

/** catalog_get wire 快照（Rust CatalogSnapshot camelCase） */
export interface CatalogSnapshotWire {
  version?: number;
  entries?: CatalogSnapshotEntryWire[];
}

/** 条目 tiered 档映射（Rust TieredPriceTier camelCase → 前端 CatalogTier） */
function toCatalogTierWire(
  tiers: CatalogSnapshotEntryWire['tieredPricing']
): CatalogTier[] | undefined {
  if (!Array.isArray(tiers) || tiers.length === 0) return undefined;
  const out: CatalogTier[] = [];
  for (const t of tiers) {
    if (typeof t?.minTokens !== 'number' || t.minTokens < 0) continue;
    out.push({
      minTokens: t.minTokens,
      ...(typeof t.maxTokens === 'number' ? { maxTokens: t.maxTokens } : {}),
      ...(typeof t.inputPrice === 'number'
        ? { inputPerMTok: t.inputPrice }
        : {}),
      ...(typeof t.outputPrice === 'number'
        ? { outputPerMTok: t.outputPrice }
        : {}),
      ...(typeof t.cacheReadPrice === 'number'
        ? { cacheReadPerMTok: t.cacheReadPrice }
        : {}),
      ...(typeof t.cacheWritePrice === 'number'
        ? { cacheWritePerMTok: t.cacheWritePrice }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * catalog_get wire → pricingStore 快照（纯转换，可单测）。
 * 索引键：model 主键 + apiModel 别名（点号异形兼容）；null 价 = 未收录 → 缺失
 * （回退下级解析链）；tieredPricing 映射为分档消费结构。
 */
export function toCatalogCacheSnapshot(
  wire: CatalogSnapshotWire | null | undefined
): CatalogCacheSnapshot {
  const prices: Record<string, CatalogSnapshotPrice> = {};
  if (!wire || !Array.isArray(wire.entries)) {
    return {
      version: typeof wire?.version === 'number' ? wire.version : 0,
      prices,
    };
  }
  for (const entry of wire.entries) {
    const model = normalizeModelIdText(entry?.model);
    if (!model) continue;
    const price: CatalogSnapshotPrice = {
      ...(typeof entry.inputPrice === 'number'
        ? { inputPerMTok: entry.inputPrice }
        : {}),
      ...(typeof entry.outputPrice === 'number'
        ? { outputPerMTok: entry.outputPrice }
        : {}),
      ...(typeof entry.cacheReadPrice === 'number'
        ? { readPerMTok: entry.cacheReadPrice }
        : {}),
      ...(typeof entry.cacheWritePrice === 'number'
        ? { writePerMTok: entry.cacheWritePrice }
        : {}),
      ...(toCatalogTierWire(entry.tieredPricing)
        ? { tiered: toCatalogTierWire(entry.tieredPricing) }
        : {}),
    };
    prices[model] = price;
    // apiModel 别名（点号异形，如 gemini-3.1-pro-preview）→ 同一价格索引
    const apiModel = normalizeModelIdText(entry.apiModel);
    if (apiModel && apiModel !== model && !prices[apiModel]) {
      prices[apiModel] = price;
    }
  }
  return {
    version: typeof wire.version === 'number' ? wire.version : 0,
    prices,
  };
}

/**
 * 拉取运行时模型目录快照（catalog_get → applyCatalogCacheSnapshot）。
 *
 * - 成功：快照注入 pricingStore（版本号幂等，重复调用安全）；
 * - 命令缺失 / invoke 失败 / 载荷非法：console.warn 降级（静态表兜底），
 *   恒不抛（invokeResult 不抛 + 外层 try/catch 兜底）。
 *
 * @returns 是否成功注入（false = 降级静态表）
 */
export async function fetchCatalogSnapshot(): Promise<boolean> {
  try {
    const res = await invokeResult<CatalogSnapshotWire>('catalog_get', {});
    if (res.status !== 'ok') {
      console.warn(
        `模型目录快照拉取跳过（${res.status}）${res.status === 'error' ? `：${res.message}` : ''}，定价回退静态表`
      );
      return false;
    }
    if (!Array.isArray(res.data?.entries) || res.data.entries.length === 0) {
      console.warn('模型目录快照载荷非法（entries 缺失），定价回退静态表');
      return false;
    }
    applyCatalogCacheSnapshot(toCatalogCacheSnapshot(res.data));
    return true;
  } catch (e) {
    console.warn('模型目录快照拉取失败，定价回退静态表：', e);
    return false;
  }
}

/** 轻量连通测试：发极短 completion */
export async function testProviderModel(
  profile: ProviderProfile,
  model: string
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const fresh = loadProfiles().find((p) => p.id === profile.id) || profile;
  try {
    const res = await providerProbePing(fresh.id, model || undefined);
    if (res.status === 'ok') {
      const data = res.data;
      upsertModelMeta(fresh.id, model, {
        lastTest: {
          ok: data.ok,
          latencyMs: data.latencyMs,
          at: Date.now(),
          error: data.error,
        },
      });
      return { ok: data.ok, latencyMs: data.latencyMs, error: data.error };
    }
    if (res.status === 'error') {
      return { ok: false, error: res.message };
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error };
  }
  return { ok: false, error: '探活服务未就绪' };
}

/** 启用中的提供商（有密钥的优先展示） */
export function listPickerProfiles(): ProviderProfile[] {
  return loadProfiles().filter((p) => p.enabled !== false);
}

/**
 * Picker 用：仅返回真实配置在 profile 中、且 meta 未禁用的模型。
 * 经 normalize → dedupe → usable 管道；不写死 vendor 演示表。
 * 空列表时返回 []（调用方不得回落 mimo 等硬编码默认）。
 */
export function listAvailablePickerModels(): CatalogModelEntry[] {
  return buildCatalogEntriesFromProfiles(
    listPickerProfiles(),
    (profileId, model) => {
      const meta = getModelMeta(profileId, model);
      return meta.enabled !== false;
    }
  );
}

/**
 * 从当前本机目录挑选默认模型（读 LS，无副作用）。
 * 空 catalog → null，**不**发明远程 vendor 默认。
 */
export function pickDefaultFromLocalCatalog(
  opts?: PickDefaultCatalogOpts
): CatalogModelEntry | null {
  return pickDefaultCatalogEntry(listAvailablePickerModels(), opts);
}
