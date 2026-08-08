/**
 * 模型目录元数据：启用状态、上下文长度、扫描与连通测试。
 * 与 providerProfiles 配合：提供商上级，模型下级。
 *
 * 纯目录辅助（normalize / dedupe / usable / default pick）不写死远程 vendor 演示 id；
 * 空 catalog 不得回落 mimo 等硬编码默认。
 */

import {
  getProfileKeyInMemory,
  loadProfiles,
  type ProviderProfile,
} from './providerProfiles';
import { invokeResult } from './tauriInvoke';

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

export function normalizeModelIds(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normalizeModelIdText).filter(Boolean);
  if (typeof raw === 'string')
    return raw.split(',').map(normalizeModelIdText).filter(Boolean);
  return [];
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

function guessModelCapabilities(model: string): ModelCapabilities {
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

function normalizeBaseUrl(baseUrl: string): string {
  const u = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  // 已带 /v1 则保持
  return u;
}

function modelsListUrl(baseUrl: string): string {
  const u = ensureOpenAiCompatibleRoot(baseUrl);
  if (!u) return '';
  if (/\/models$/i.test(u)) return u;
  // 已含 /v1 → /v1/models；否则补 /v1/models（OpenAI / DeepSeek 惯例）
  if (/\/v1$/i.test(u)) return `${u}/models`;
  return `${u}/v1/models`;
}

function chatCompletionsUrl(baseUrl: string): string {
  const u = ensureOpenAiCompatibleRoot(baseUrl);
  if (!u) return '';
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v1$/i.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

/**
 * HTTP 探测顺序（OpenAI 兼容供应商，服务端出站无 CORS）：
 * 1. Tauri 原生 workbench_http_request（reqwest）
 * 2. Vite 开发代理 /__crish_http_proxy（localhost:5174 场景）
 * 3. 浏览器直连 fetch（多数公网 API 会被 CORS 拦截，仅作最后手段）
 */
async function httpRequest(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string }
): Promise<{ ok: boolean; status: number; text: string }> {
  const method = (init.method || 'GET').toUpperCase();
  // GET/HEAD 不要带 Content-Type，避免多余 preflight（直连时）
  const headers: Record<string, string> = { ...(init.headers || {}) };
  if (method === 'GET' || method === 'HEAD') {
    delete headers['Content-Type'];
    delete headers['content-type'];
  }

  // 1) 桌面壳原生 HTTP（命令未注册 / 非 Tauri → missing，fallthrough 代理）
  const tauriRes = await invokeResult<{
    ok?: boolean;
    status?: number;
    body?: string;
  }>('workbench_http_request', {
    url,
    method,
    headers,
    body: init.body ?? null,
  });
  if (tauriRes.status === 'ok') {
    const res = tauriRes.data;
    return {
      ok: Boolean(res?.ok),
      status: Number(res?.status) || 0,
      text: String(res?.body ?? ''),
    };
  }
  if (tauriRes.status === 'error') {
    const msg = tauriRes.message;
    // 真网络错误 → 抛出；其余（含命令/IPC 文案）→ 继续代理
    if (/network:/i.test(msg)) {
      throw new Error(msg.replace(/^network:\s*/i, ''));
    }
    if (/error sending|dns|connect|timed out|timeout|refused/i.test(msg)) {
      throw new Error(msg);
    }
    // fall through to vite proxy
  }

  // 2) Vite 开发代理（origin 为 localhost:5174 时的正解）
  const useDevProxy =
    typeof window !== 'undefined' &&
    (window.location.port === '5174' ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1');
  if (useDevProxy) {
    try {
      const res = await fetch('/__crish_http_proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          method,
          headers,
          body: init.body ?? null,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        status?: number;
        body?: string;
        error?: string;
      };
      if (data.error && !data.status) {
        throw new Error(data.error);
      }
      return {
        ok: Boolean(data.ok),
        status: Number(data.status) || 0,
        text: String(data.body ?? ''),
      };
    } catch (e) {
      // 代理未启动时再 fall through
      const msg = e instanceof Error ? e.message : String(e);
      if (!/failed to fetch|404|proxy/i.test(msg)) throw e;
    }
  }

  // 3) 浏览器直连（多数供应商会 CORS 失败）
  const res = await fetch(url, {
    method,
    headers,
    ...(init.body !== undefined && { body: init.body }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

function friendlyFetchError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed|cors/i.test(msg)) {
    return '浏览器无法直连该 API（常见于跨域）。请使用桌面应用，或确认引擎/壳已启动后再试；也可手动添加模型 id。';
  }
  if (/ssl|certificate|cert/i.test(msg)) {
    return '证书或 HTTPS 校验失败，请检查 Base URL。';
  }
  if (/timed out|timeout/i.test(msg)) {
    return '请求超时，请检查网络与 Base URL。';
  }
  if (/dns|getaddrinfo|name not resolved/i.test(msg)) {
    return '无法解析主机名，请检查 Base URL。';
  }
  if (/refused|connect/i.test(msg)) {
    return '无法连接到服务器，请检查 Base URL 与网络。';
  }
  return msg || '请求失败';
}

/**
 * OpenAI 兼容 URL 规范化：
 * - DeepSeek 文档：https://api.deepseek.com 或 …/v1
 * - 列模型：GET {base}/models（base 已含 /v1 时不再叠）
 * - 对话：POST {base}/chat/completions
 */
function ensureOpenAiCompatibleRoot(baseUrl: string): string {
  let u = normalizeBaseUrl(baseUrl);
  if (!u) return '';
  // 去掉末尾 /models 误写
  u = u.replace(/\/models\/?$/i, '');
  return u;
}

/** 扫描提供商模型列表（OpenAI 兼容 /models） */
export async function scanProviderModels(
  profile: ProviderProfile
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  // 始终用本地最新 profile（含密钥），避免 UI 态过期
  const fresh = loadProfiles().find((p) => p.id === profile.id) || profile;
  // K-01：明文只经会话内内存缓存（saveProfileKey 写入）；profile 对象不再带 apiKey
  const key = getProfileKeyInMemory(fresh.id) || fresh.apiKey?.trim();
  if (!key) {
    return {
      ok: false,
      models: [],
      error: fresh.hasKey
        ? '密钥未载入内存，请重新输入并保存密钥后再试'
        : '未配置密钥，请先保存 API Key',
    };
  }
  const url = modelsListUrl(fresh.baseUrl);
  if (!url) return { ok: false, models: [], error: '未配置地址（Base URL）' };

  // T03.7：probe-provider-models 幽灵命令已删，HTTP 直连为唯一路径
  try {
    const res = await httpRequest(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      return {
        ok: false,
        models: [],
        error: `获取失败 HTTP ${res.status}${res.text ? `：${res.text.slice(0, 120)}` : ''}`,
      };
    }
    let data: {
      data?: Array<{
        id?: string;
        context_length?: number;
        max_model_len?: number;
      }>;
      models?: Array<{ id?: string } | string>;
    };
    try {
      data = JSON.parse(res.text) as typeof data;
    } catch {
      return {
        ok: false,
        models: [],
        error: '响应不是 JSON，请检查 Base URL 是否指向 API 根路径',
      };
    }
    const rawList = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : [];
    const models: string[] = [];
    // 响应体显式声明的窗口（context_length / max_model_len），上送时优先于猜测
    const scannedCtx = new Map<string, number>();
    for (const item of rawList) {
      if (typeof item === 'string' && item.trim()) {
        models.push(item.trim());
        continue;
      }
      if (item && typeof item === 'object') {
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id) continue;
        models.push(id);
        const ctx =
          typeof (item as { context_length?: number }).context_length ===
          'number'
            ? (item as { context_length: number }).context_length
            : typeof (item as { max_model_len?: number }).max_model_len ===
                'number'
              ? (item as { max_model_len: number }).max_model_len
              : undefined;
        if (ctx && ctx > 0) {
          upsertModelMeta(fresh.id, id, { contextLength: ctx });
          scannedCtx.set(id, ctx);
        }
      }
    }
    const unique = Array.from(new Set(models)).sort((a, b) =>
      a.localeCompare(b)
    );
    for (const m of unique) {
      const ctx = guessContextLength(m);
      const caps = guessModelCapabilities(m);
      upsertModelMeta(fresh.id, m, {
        ...(ctx ? { contextLength: ctx } : {}),
        capabilities: caps,
      });
    }
    // P3 步骤 5b / §3.1.3（数据来源策略 2）：扫描结果上送合并——
    // 仅窗口 / 能力位，不覆盖价格（Rust upsert_from_scan 保证）；
    // 命令缺失 / invoke 失败降级记录，不阻塞扫描流程（uploadScannedModels 内吞错）。
    const scanned: ScannedModel[] = unique.map((m) =>
      buildScannedModelWire(
        m,
        scannedCtx.get(m) ?? guessContextLength(m),
        guessModelCapabilities(m)
      )
    );
    await uploadScannedModels(fresh.id, scanned);
    return { ok: true, models: unique };
  } catch (e) {
    return { ok: false, models: [], error: friendlyFetchError(e) };
  }
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

/** 轻量连通测试：发极短 completion */
export async function testProviderModel(
  profile: ProviderProfile,
  model: string
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const fresh = loadProfiles().find((p) => p.id === profile.id) || profile;
  // K-01：明文只经会话内内存缓存（saveProfileKey 写入）；profile 对象不再带 apiKey
  const key = getProfileKeyInMemory(fresh.id) || fresh.apiKey?.trim();
  if (!key) {
    const r = {
      ok: false,
      error: fresh.hasKey ? '密钥未载入，请重新输入并点「保存」' : '未配置密钥',
    };
    upsertModelMeta(fresh.id, model, {
      lastTest: { ok: false, at: Date.now(), error: r.error },
    });
    return r;
  }
  const base = normalizeBaseUrl(fresh.baseUrl);
  if (!base) {
    const r = { ok: false, error: '未配置地址' };
    upsertModelMeta(fresh.id, model, {
      lastTest: { ok: false, at: Date.now(), error: r.error },
    });
    return r;
  }
  const url = chatCompletionsUrl(base);
  if (!url) {
    const r = { ok: false, error: '无法构造 chat/completions 地址' };
    upsertModelMeta(fresh.id, model, {
      lastTest: { ok: false, at: Date.now(), error: r.error },
    });
    return r;
  }

  // Define timeout promise of 5 seconds
  const timeoutPromise = new Promise<{
    ok: boolean;
    latencyMs?: number;
    error?: string;
  }>((_, reject) => {
    setTimeout(() => {
      reject(new Error('连接超时（超过 5 秒）'));
    }, 5000);
  });

  // T03.7：probe-provider-chat 幽灵命令已删，HTTP 直连为唯一路径
  const doTest = async (): Promise<{
    ok: boolean;
    latencyMs?: number;
    error?: string;
  }> => {
    const started = performance.now();
    const res = await httpRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      }),
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      const error = `连通失败 HTTP ${res.status}${res.text ? `：${res.text.slice(0, 100)}` : ''}`;
      upsertModelMeta(fresh.id, model, {
        lastTest: { ok: false, latencyMs, at: Date.now(), error },
      });
      return { ok: false, latencyMs, error };
    }
    upsertModelMeta(fresh.id, model, {
      lastTest: { ok: true, latencyMs, at: Date.now() },
    });
    return { ok: true, latencyMs };
  };

  try {
    return await Promise.race([doTest(), timeoutPromise]);
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    upsertModelMeta(fresh.id, model, {
      lastTest: { ok: false, at: Date.now(), error },
    });
    return { ok: false, error };
  }
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
