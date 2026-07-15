/**
 * 模型目录元数据：启用状态、上下文长度、扫描与连通测试。
 * 与 providerProfiles 配合：提供商上级，模型下级。
 */

import { loadProfiles, type ProviderProfile } from './providerProfiles';

const META_KEY = 'crish_model_meta_v1';

export type ModelMeta = {
  profileId: string;
  model: string;
  /** 默认 true */
  enabled: boolean;
  /** 上下文 token 上限（可手改） */
  contextLength?: number;
  lastTest?: {
    ok: boolean;
    latencyMs?: number;
    at: number;
    error?: string;
  };
};

type MetaMap = Record<string, ModelMeta>;

function metaKey(profileId: string, model: string): string {
  return `${profileId}::${model}`;
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

/** 常见模型默认上下文（仅作缺省展示，可被扫描/手改覆盖） */
const KNOWN_CONTEXT: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_000_000,
  'o1': 200_000,
  'o3-mini': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-opus-4': 200_000,
  'claude-3-5-sonnet': 200_000,
  'deepseek-chat': 64_000,
  'deepseek-v4-flash': 128_000,
  'deepseek-reasoner': 64_000,
  'mimo-v2.5': 128_000,
  'gemini-1.5-pro': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
};

export function guessContextLength(model: string): number | undefined {
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

export function upsertModelMeta(
  profileId: string,
  model: string,
  patch: Partial<Pick<ModelMeta, 'enabled' | 'contextLength' | 'lastTest'>>,
): ModelMeta {
  const map = loadMap();
  const k = metaKey(profileId, model);
  const prev = getModelMeta(profileId, model);
  const next: ModelMeta = {
    ...prev,
    ...patch,
    profileId,
    model,
  };
  map[k] = next;
  saveMap(map);
  return next;
}

export function setModelEnabled(profileId: string, model: string, enabled: boolean): ModelMeta {
  return upsertModelMeta(profileId, model, { enabled });
}

export function setModelContextLength(
  profileId: string,
  model: string,
  contextLength: number | undefined,
): ModelMeta {
  return upsertModelMeta(profileId, model, { contextLength });
}

export function formatContextLabel(n?: number): string {
  if (!n || n <= 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function normalizeBaseUrl(baseUrl: string): string {
  let u = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  // 已带 /v1 则保持
  return u;
}

function modelsListUrl(baseUrl: string): string {
  const u = normalizeBaseUrl(baseUrl);
  if (!u) return '';
  if (/\/v1$/i.test(u)) return `${u}/models`;
  if (/\/models$/i.test(u)) return u;
  return `${u}/v1/models`;
}

/** 优先 Tauri HTTP 插件（绕过浏览器 CORS），否则 window.fetch */
async function httpRequest(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const http: any = await (Function(
      'return import("@tauri-apps/plugin-http")',
    )() as Promise<any>).catch(() => null);
    if (http?.fetch) {
      const res = await http.fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      const text = await res.text();
      return { ok: Boolean(res.ok), status: Number(res.status) || 0, text };
    }
  } catch {
    /* fall through */
  }
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

function friendlyFetchError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed|cors/i.test(msg)) {
    return '无法访问该地址（网络或跨域限制）。请确认 Base URL 可访问，或手动添加模型 id。';
  }
  if (/ssl|certificate|cert/i.test(msg)) {
    return '证书或 HTTPS 校验失败，请检查地址是否正确。';
  }
  return msg || '请求失败';
}

/** 扫描提供商模型列表（OpenAI 兼容 /models） */
export async function scanProviderModels(
  profile: ProviderProfile,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  // 始终用本地最新 profile（含密钥），避免 UI 态过期
  const fresh = loadProfiles().find((p) => p.id === profile.id) || profile;
  const key = fresh.apiKey?.trim();
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
      data?: Array<{ id?: string; context_length?: number; max_model_len?: number }>;
      models?: Array<{ id?: string } | string>;
    };
    try {
      data = JSON.parse(res.text) as typeof data;
    } catch {
      return { ok: false, models: [], error: '响应不是 JSON，请检查 Base URL 是否指向 API 根路径' };
    }
    const rawList = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : [];
    const models: string[] = [];
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
          typeof (item as { context_length?: number }).context_length === 'number'
            ? (item as { context_length: number }).context_length
            : typeof (item as { max_model_len?: number }).max_model_len === 'number'
              ? (item as { max_model_len: number }).max_model_len
              : undefined;
        if (ctx && ctx > 0) {
          upsertModelMeta(fresh.id, id, { contextLength: ctx });
        }
      }
    }
    const unique = Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
    return { ok: true, models: unique };
  } catch (e) {
    return { ok: false, models: [], error: friendlyFetchError(e) };
  }
}

/** 轻量连通测试：发极短 completion */
export async function testProviderModel(
  profile: ProviderProfile,
  model: string,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const fresh = loadProfiles().find((p) => p.id === profile.id) || profile;
  const key = fresh.apiKey?.trim();
  if (!key) {
    const r = {
      ok: false,
      error: fresh.hasKey
        ? '密钥未载入，请重新输入并点「保存」'
        : '未配置密钥',
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
  const url = /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const started = performance.now();
  try {
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
  } catch (e) {
    const error = friendlyFetchError(e);
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
