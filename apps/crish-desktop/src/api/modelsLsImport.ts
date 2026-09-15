/**
 * 一次性 LS → yaml 导入（T2-4 / M10）。
 *
 * 读 raw getItem + JSON.parse，禁止 loadProfiles / loadPrices / getModelMeta（会播种 DEFAULT）。
 * yaml 已有字段赢；只填洞；不拷明文 apiKey；defaultThinkingLevel 丢弃。
 * 成功才 updateTree，ok 后写完成标记；本模块不 setItem 三把配置键。
 */

import { modelsCatalogStore } from './modelsCatalogStore';
import { DEFAULT_PROTOCOL, normalizeProtocol, type ModelProtocol } from './modelsNormalize';
import type {
  ModelSpec,
  ModelsYamlTree,
  ModalityMatrix,
  PricingConfig,
  ProviderSpec,
} from './modelsCatalogTypes';

export const LS_IMPORT_FLAG_KEY = 'crish_models_ls_import_v1';
export const LS_IMPORT_FLAG_VERSION = 1;

const PROFILES_KEY = 'crish_provider_profiles_v1';
const META_KEY = 'crish_model_meta_v1';
const PRICES_KEY = 'crish_model_prices_v1';

export type LsImportResult = { ok: boolean; error?: string };

/** 只读边界旧名 → 规范协议。LS→yaml 是一次性显式升级边界，旧名到此终结。 */
const LEGACY_PROTOCOL_ALIASES: Readonly<Record<string, ModelProtocol>> = {
  'google/interactions': 'google/generate-content',
};

function protocolFromLegacy(raw: unknown): ModelProtocol | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return normalizeProtocol(text) ?? LEGACY_PROTOCOL_ALIASES[text];
}

let inflight: Promise<LsImportResult> | null = null;

export function resetLsImportForTesting(): void {
  inflight = null;
}

export function ensureLsImported(): Promise<LsImportResult> {
  if (readDoneMarker()) return Promise.resolve({ ok: true });
  if (!inflight) {
    inflight = runImport().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function readDoneMarker(): boolean {
  const raw = lsGet(LS_IMPORT_FLAG_KEY);
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return false;
    return parsed.done === true && parsed.version === LS_IMPORT_FLAG_VERSION;
  } catch {
    return false;
  }
}

function writeDoneMarker(): boolean {
  try {
    localStorage.setItem(
      LS_IMPORT_FLAG_KEY,
      JSON.stringify({ done: true, version: LS_IMPORT_FLAG_VERSION })
    );
    return true;
  } catch {
    return false;
  }
}

async function runImport(): Promise<LsImportResult> {
  if (readDoneMarker()) return { ok: true };

  const loaded = await modelsCatalogStore.ensureLoaded();
  if (!loaded) {
    return {
      ok: false,
      error: modelsCatalogStore.getState().lastError?.message || 'models.yaml 未能加载，放弃导入',
    };
  }

  const sources = readLsSources();
  if (!sources.ok) return { ok: false, error: sources.error };

  const current = modelsCatalogStore.getState().tree;
  const merged = mergeLsIntoTree(
    JSON.parse(JSON.stringify(current)) as ModelsYamlTree,
    sources.bundle
  );
  const changed = JSON.stringify(merged.providers) !== JSON.stringify(current.providers);

  if (changed) {
    const written = await modelsCatalogStore.updateTree(merged);
    if (!written.ok) {
      return { ok: false, error: written.error || '导入写盘失败' };
    }
  }

  if (!writeDoneMarker()) {
    return { ok: false, error: '导入完成标记写入失败' };
  }
  return { ok: true };
}

// ── LS 读取（缺键=空；坏 JSON=整次失败，不播种） ──────────────────────────

interface LsBundle {
  profiles: Record<string, unknown>[];
  meta: Map<string, Record<string, unknown>>;
  prices: Map<string, Record<string, unknown>>;
}

function readLsSources(): { ok: true; bundle: LsBundle } | { ok: false; error: string } {
  const profilesRaw = parseJsonValue(lsGet(PROFILES_KEY));
  const metaRaw = parseJsonValue(lsGet(META_KEY));
  const pricesRaw = parseJsonValue(lsGet(PRICES_KEY));

  const badJson =
    profilesRaw.kind === 'bad' ||
    metaRaw.kind === 'bad' ||
    pricesRaw.kind === 'bad' ||
    (profilesRaw.kind === 'ok' && !Array.isArray(profilesRaw.value));
  if (badJson) return { ok: false, error: 'LocalStorage 配置 JSON 损坏，放弃导入' };

  const profiles: Record<string, unknown>[] = [];
  if (profilesRaw.kind === 'ok') {
    for (const item of profilesRaw.value as unknown[]) {
      if (isPlainObject(item)) profiles.push(item);
    }
  }

  const meta = new Map<string, Record<string, unknown>>();
  if (metaRaw.kind === 'ok' && isPlainObject(metaRaw.value)) {
    for (const [key, value] of Object.entries(metaRaw.value)) {
      if (!isPlainObject(value)) continue;
      const norm = key.trim().toLowerCase();
      if (norm) meta.set(norm, value);
    }
  }

  const prices = new Map<string, Record<string, unknown>>();
  if (pricesRaw.kind === 'ok' && Array.isArray(pricesRaw.value)) {
    for (const item of pricesRaw.value as unknown[]) {
      if (!isPlainObject(item)) continue;
      const model = typeof item.model === 'string' ? item.model.trim().toLowerCase() : '';
      if (model) prices.set(model, item);
    }
  }

  return { ok: true, bundle: { profiles, meta, prices } };
}

function lsGet(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(key);
}

function parseJsonValue(
  raw: string | null
): { kind: 'missing' } | { kind: 'bad' } | { kind: 'ok'; value: unknown } {
  if (!raw) return { kind: 'missing' };
  try {
    return { kind: 'ok', value: JSON.parse(raw) };
  } catch {
    return { kind: 'bad' };
  }
}

// ── 合并：ID 集合 + 缺字段填充；yaml 已有（含 false / 0）不动 ──────────────

function mergeLsIntoTree(tree: ModelsYamlTree, ls: LsBundle): ModelsYamlTree {
  const providers: Record<string, ProviderSpec> = { ...tree.providers };

  for (const profile of ls.profiles) {
    const rawId = typeof profile.id === 'string' ? profile.id.trim() : '';
    if (!rawId) continue;
    const pid = rawId.toLowerCase();
    const fromLs = providerFromLs(profile, pid, ls);
    const existing = providers[pid];
    providers[pid] = existing ? fillProviderHoles(existing, fromLs) : fromLs;
  }

  // LS 导入不改活动选择；树契约要求 activeModel 键恒在。
  return { version: 2, activeModel: tree.activeModel, providers };
}

function providerFromLs(
  profile: Record<string, unknown>,
  pid: string,
  ls: LsBundle
): ProviderSpec {
  const protocol = protocolFromLegacy(profile.protocol) ?? DEFAULT_PROTOCOL;
  const name = typeof profile.name === 'string' ? profile.name.trim() : '';
  const displayName = name || pid;
  const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl : '';
  const models: ModelSpec[] = [];
  const seen = new Set<string>();

  for (const rawId of stringList(profile.models)) {
    const modelId = rawId.trim();
    if (!modelId) continue;
    const low = modelId.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    models.push(modelFromLs(pid, modelId, ls));
  }

  const spec: ProviderSpec = {
    displayName,
    baseUrl,
    protocol,
    stream: true,
    enabled: profile.enabled !== false,
    models,
  };
  return spec;
}

function fillProviderHoles(yaml: ProviderSpec, ls: ProviderSpec): ProviderSpec {
  const models = (yaml.models ?? []).map((m) => ({ ...m }));
  const index = new Map<string, number>();
  for (let i = 0; i < models.length; i += 1) {
    const id = (models[i]?.id || '').trim().toLowerCase();
    if (id) index.set(id, i);
  }

  for (const lsModel of ls.models) {
    const low = lsModel.id.trim().toLowerCase();
    const at = index.get(low);
    if (at == null) {
      index.set(low, models.length);
      models.push(lsModel);
    } else {
      models[at] = fillModelHoles(models[at]!, lsModel);
    }
  }

  const out: ProviderSpec = { ...yaml, models };
  if (isHole(out.displayName) && ls.displayName) out.displayName = ls.displayName;
  if (isHole(out.baseUrl) && ls.baseUrl) out.baseUrl = ls.baseUrl;
  if (isHole(out.protocol) && ls.protocol) out.protocol = ls.protocol;
  if (isHole(out.enabled) && ls.enabled === false) out.enabled = false;
  return out;
}

function modelFromLs(pid: string, modelId: string, ls: LsBundle): ModelSpec {
  const meta = ls.meta.get(`${pid}::${modelId.toLowerCase()}`);
  const price = ls.prices.get(modelId.toLowerCase());
  const spec: ModelSpec = { id: modelId, enabled: meta?.enabled !== false };

  const displayName = typeof meta?.displayName === 'string' ? meta.displayName.trim() : '';
  if (displayName) spec.displayName = displayName;
  const protocol = protocolFromLegacy(meta?.protocol);
  if (protocol) spec.protocol = protocol;
  const contextWindow = pickNum(meta?.contextWindow, meta?.contextLength);
  if (contextWindow != null) spec.contextWindow = contextWindow;
  const maxOutputTokens = pickNum(meta?.maxOutputTokens);
  if (maxOutputTokens != null) spec.maxOutputTokens = maxOutputTokens;
  const thinking = thinkingFromUnknown(meta?.thinking);
  if (thinking) spec.thinking = thinking;
  const modalities = modalitiesFromMeta(meta);
  if (modalities) spec.modalities = modalities;
  const pricing = pricingFrom(meta, price);
  if (pricing) spec.pricing = pricing;
  return spec;
}

function fillModelHoles(yaml: ModelSpec, ls: ModelSpec): ModelSpec {
  const out: ModelSpec = { ...yaml };
  if (isHole(out.displayName) && ls.displayName) out.displayName = ls.displayName;
  if (isHole(out.protocol) && ls.protocol) out.protocol = ls.protocol;
  if (isHole(out.contextWindow) && ls.contextWindow != null) out.contextWindow = ls.contextWindow;
  if (isHole(out.maxOutputTokens) && ls.maxOutputTokens != null) {
    out.maxOutputTokens = ls.maxOutputTokens;
  }
  if (isHole(out.thinking) && ls.thinking) out.thinking = ls.thinking;
  if (isHole(out.modalities) && ls.modalities) out.modalities = ls.modalities;
  if (isHole(out.pricing) && ls.pricing) out.pricing = ls.pricing;
  else if (out.pricing && ls.pricing) out.pricing = fillPricingHoles(out.pricing, ls.pricing);
  if (isHole(out.enabled) && ls.enabled === false) out.enabled = false;
  return out;
}

function fillPricingHoles(yaml: PricingConfig, ls: PricingConfig): PricingConfig {
  const out: PricingConfig = { ...yaml };
  if (isHole(out.input) && ls.input != null) out.input = ls.input;
  if (isHole(out.output) && ls.output != null) out.output = ls.output;
  if (isHole(out.cacheRead) && ls.cacheRead != null) out.cacheRead = ls.cacheRead;
  if (isHole(out.cacheWrite) && ls.cacheWrite != null) out.cacheWrite = ls.cacheWrite;
  if (isHole(out.perImage) && ls.perImage != null) out.perImage = ls.perImage;
  if (isHole(out.currency) && ls.currency) out.currency = ls.currency;
  return out;
}

function thinkingFromUnknown(raw: unknown): Record<string, string> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = key.trim();
    if (!k || typeof value !== 'string') continue;
    const v = value.trim();
    if (!v) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function modalitiesFromMeta(
  meta: Record<string, unknown> | undefined
): ModalityMatrix | undefined {
  const raw = meta?.modalities;
  if (isPlainObject(raw)) {
    const input = [...stringList(raw.input)];
    const output = [...stringList(raw.output)];
    if (hasCap(meta?.capabilities, 'vision') && !input.includes('image')) {
      input.push('image');
    }
    if (input.length === 0 && output.length === 0) return undefined;
    return {
      input: input.length > 0 ? input : ['text'],
      output: output.length > 0 ? output : ['text'],
    };
  }

  const image = hasCap(meta?.capabilities, 'image') || hasCap(meta?.capabilities, 'vision');
  const video = hasCap(meta?.capabilities, 'video');
  if (!image && !video) return undefined;
  const input = ['text'];
  if (image) input.push('image');
  if (video) input.push('video');
  return { input, output: ['text'] };
}

function pricingFrom(
  meta: Record<string, unknown> | undefined,
  price: Record<string, unknown> | undefined
): PricingConfig | undefined {
  const mp =
    meta && isPlainObject(meta.pricing) ? (meta.pricing as Record<string, unknown>) : undefined;
  const input = pickNum(mp?.input, mp?.inputPerMTok, price?.inputPerMTok, price?.input);
  const output = pickNum(mp?.output, mp?.outputPerMTok, price?.outputPerMTok, price?.output);
  const cacheRead = pickNum(mp?.cacheRead, mp?.cacheReadPerMTok, price?.cacheReadPerMTok, price?.cacheRead);
  const cacheWrite = pickNum(mp?.cacheWrite, mp?.cacheWritePerMTok, price?.cacheWritePerMTok, price?.cacheWrite);
  const perImage = pickNum(mp?.perImage, mp?.perImageCost, price?.perImageCost, price?.perImage);
  if (input == null && output == null && cacheRead == null && cacheWrite == null && perImage == null) {
    return undefined;
  }
  const currency: PricingConfig['currency'] =
    mp?.currency === 'USD' || mp?.currency === 'CNY' ? mp.currency : price?.currency === 'CNY' ? 'CNY' : 'USD';
  const out: PricingConfig = { currency };
  if (input != null) out.input = input;
  if (output != null) out.output = output;
  if (cacheRead != null) out.cacheRead = cacheRead;
  if (cacheWrite != null) out.cacheWrite = cacheWrite;
  if (perImage != null) out.perImage = perImage;
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isHole(value: unknown): boolean {
  return value === undefined || value === null;
}

function pickNum(...candidates: unknown[]): number | undefined {
  for (const item of candidates) {
    if (typeof item === 'number' && Number.isFinite(item)) return item;
  }
  return undefined;
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) out.push(item);
  }
  return out;
}

function hasCap(caps: unknown, key: string): boolean {
  return isPlainObject(caps) && caps[key] === true;
}
