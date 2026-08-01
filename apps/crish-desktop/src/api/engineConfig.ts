/**
 * Engine configuration — real daemon get-status / update-config.
 * Also keeps a local recent-models list for the chat picker.
 *
 * Pure helpers (normalize / defaults / endpoint validation / empty-partial)
 * never invent remote vendor demo model ids (e.g. mimo). Empty stays empty.
 */

import { getDesktopDaemonClient } from './daemonClient';
import { logInternalError } from './userFacingErrors';

const RECENT_MODELS_KEY = 'crish_recent_models';
const MAX_RECENT = 12;

export type EngineStatus = {
  /**
   * 产品可用性：true = UI 不当作「引擎离线」。
   * 正式版默认 keep-alive：短暂断连 / 重连中仍为 true（永不恐吓离线）。
   */
  ok: boolean;
  /** 底层 WebSocket 当前是否 OPEN（诊断用；不直接驱动 soft-hint） */
  connected?: boolean;
  /** 正在 keep-alive 重连（ok 仍可为 true） */
  reconnecting?: boolean;
  model?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  credentialMode?: string;
  raw?: Record<string, unknown>;
  error?: string;
};

export type EngineConfigUpdate = {
  /**
   * @deprecated PE-07 T07.4（K-01）：明文 key 下线后仅接受 undefined——
   * normalizeEngineConfigUpdate 会剥离任何 apiKey 值（兼容层剥离），
   * 密钥一律经 config_secret_set / config_profile_apply 走 DPAPI。
   */
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  credentialMode?: string | undefined;
  endpoint?: string | undefined;
  stream?: boolean | undefined;
};

/** OpenAI-compatible endpoint kind (daemon-aligned aliases). */
export type EngineEndpointKind = 'auto' | 'responses' | 'chat-completions';

/** Credential modes accepted by desktop → daemon update-config. */
export type EngineCredentialMode = 'direct' | 'auto' | 'account-center';

/**
 * Normalized engine config shell.
 * Optional fields stay undefined when unset — **no** default remote model id.
 */
export type NormalizedEngineConfig = {
  /** @deprecated 明文 key 已下线（K-01）：规范化输出恒不含本字段 */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  credentialMode?: EngineCredentialMode;
  endpoint?: EngineEndpointKind;
  stream?: boolean;
};

export type EngineBaseUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: string };

export type EngineConfigReadiness = {
  hasModel: boolean;
  hasBaseUrl: boolean;
  baseUrlValid: boolean;
  hasApiKey: boolean;
  /** model present and baseUrl either empty or valid http(s) */
  usable: boolean;
  /** model + valid baseUrl + apiKey (or credential that may supply key) */
  ready: boolean;
  empty: boolean;
  partial: boolean;
};

// ─── Pure helpers (no LS / no network) ───────────────────────────────────────

/**
 * Unicode-safe trim（中文/全角空格）：NFC 后去首尾空白（含 \u3000）。
 * 非 string/number/boolean → ''。
 */
export function normalizeEngineConfigText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
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

/**
 * 模型 id 规范化（纯）：trim；空 → undefined。
 * **绝不**回落 mimo / 其它远程 vendor 演示 id。
 */
export function normalizeEngineModelId(raw: unknown): string | undefined {
  const m = normalizeEngineConfigText(raw);
  return m || undefined;
}

/**
 * Base URL 规范化（纯）：trim、去掉尾部 `/`（保留 scheme/host/path）。
 * 空/非法类型 → ''。不自动补 `/v1`（留给供应商 profile）。
 */
export function normalizeEngineBaseUrl(raw: unknown): string {
  const u = normalizeEngineConfigText(raw);
  if (!u) return '';
  return u.replace(/\/+$/, '');
}

/**
 * 校验引擎 baseUrl / endpoint URL（纯）。
 * - 空串 → invalid（empty）
 * - 仅接受 http: / https:
 * - 必须能被 URL 解析且含 hostname
 * - 成功时返回已 normalize 的 url（无尾斜杠）
 */
export function validateEngineBaseUrl(raw: unknown): EngineBaseUrlValidation {
  const url = normalizeEngineBaseUrl(raw);
  if (!url) {
    return { ok: false, error: 'empty' };
  }
  // 拒绝明显非 URL 的粘贴（空白已 strip）
  if (/\s/.test(url)) {
    return { ok: false, error: 'whitespace' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, error: 'unsupported_protocol' };
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'missing_host' };
  }
  // 规范化后再拼回（去掉默认端口噪音以外的尾斜杠已由 normalize 处理）
  const normalized = normalizeEngineBaseUrl(parsed.toString());
  return { ok: true, url: normalized || url };
}

/** baseUrl 是否合法 http(s)（纯；空 → false） */
export function isValidEngineBaseUrl(raw: unknown): boolean {
  return validateEngineBaseUrl(raw).ok;
}

/**
 * 端点类型规范化（纯），与 daemon normalizeEndpoint 别名对齐：
 * auto | responses | chat-completions；chat → chat-completions；response → responses。
 * 未知 / 空 → undefined（不发明默认）。
 */
export function normalizeEngineEndpointKind(raw: unknown): EngineEndpointKind | undefined {
  const n = normalizeEngineConfigText(raw).toLowerCase().replace(/_/g, '-').replace(/\//g, '-');
  if (!n) return undefined;
  if (n === 'auto') return 'auto';
  if (n === 'responses' || n === 'response') return 'responses';
  if (n === 'chat-completions' || n === 'chat' || n === 'chat-completion') return 'chat-completions';
  return undefined;
}

/**
 * credentialMode 规范化（纯）：direct | auto | account-center。
 * 别名：account_center / accountcenter → account-center。
 * 未知 / 空 → undefined。
 */
export function normalizeEngineCredentialMode(raw: unknown): EngineCredentialMode | undefined {
  const n = normalizeEngineConfigText(raw).toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
  if (!n) return undefined;
  if (n === 'direct') return 'direct';
  if (n === 'auto') return 'auto';
  if (n === 'account-center' || n === 'accountcenter' || n === 'account') return 'account-center';
  return undefined;
}

/**
 * stream 字段规范化（纯）：boolean 直通；字符串 true/1/yes/on 等。
 * 未知 → undefined（保留「未设置」语义，不强制默认 true）。
 */
export function normalizeEngineStreamFlag(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return undefined;
  }
  const n = normalizeEngineConfigText(raw).toLowerCase();
  if (!n) return undefined;
  if (n === 'true' || n === '1' || n === 'yes' || n === 'on') return true;
  if (n === 'false' || n === '0' || n === 'no' || n === 'off') return false;
  return undefined;
}

/**
 * 空配置壳（纯）：所有字段 undefined。
 * **不**写入任何远程演示 model / 厂商默认 baseUrl。
 */
export function emptyEngineConfig(): NormalizedEngineConfig {
  return {};
}

/**
 * 产品安全默认（纯）：不发明 model；stream 默认 true；endpoint 默认 auto。
 * 用于「尚未配置」的 UI 初始态，绝非 daemon 演示表。
 */
export function defaultEngineConfigShell(): NormalizedEngineConfig {
  return {
    stream: true,
    endpoint: 'auto',
    // model / baseUrl / apiKey 刻意缺省
  };
}

/**
 * 规范化 update-config 载荷（纯）。
 * - trim 字符串；空串丢弃（不写入 payload）
 * - endpoint / credentialMode 别名归一
 * - model 永不发明
 * - **apiKey 恒被剥离（K-01 兼容层剥离：任何密钥值都不进入 update-config 载荷）**
 * - 非法入参 → {}
 */
export function normalizeEngineConfigUpdate(
  update: Partial<EngineConfigUpdate> | null | undefined,
): EngineConfigUpdate {
  if (!update || typeof update !== 'object') return {};
  const out: EngineConfigUpdate = {};

  // PE-07 T07.4（K-01）：apiKey 兼容层剥离——明文只经 config_secret_set /
  // config_profile_apply 落 DPAPI，禁止进入 update-config / config_update。

  if (update.baseUrl !== undefined) {
    const base = normalizeEngineBaseUrl(update.baseUrl);
    if (base) out.baseUrl = base;
  }

  if (update.model !== undefined) {
    const model = normalizeEngineModelId(update.model);
    if (model) out.model = model;
  }

  if (update.credentialMode !== undefined) {
    const mode = normalizeEngineCredentialMode(update.credentialMode);
    if (mode) out.credentialMode = mode;
  }

  if (update.endpoint !== undefined) {
    const ep = normalizeEngineEndpointKind(update.endpoint);
    if (ep) out.endpoint = ep;
  }

  if (update.stream !== undefined) {
    const stream = normalizeEngineStreamFlag(update.stream);
    if (stream !== undefined) out.stream = stream;
  }

  return out;
}

/** 更新体是否无可下发字段（纯） */
export function isEmptyEngineConfigUpdate(
  update: Partial<EngineConfigUpdate> | null | undefined,
): boolean {
  const n = normalizeEngineConfigUpdate(update);
  return (
    n.baseUrl === undefined &&
    n.model === undefined &&
    n.credentialMode === undefined &&
    n.endpoint === undefined &&
    n.stream === undefined
  );
}

/**
 * 合并多层 partial → 规范化结果（纯）。
 * 后者覆盖前者；空串不覆盖已有值（与 update-config 语义一致）。
 * 不发明 model。
 */
export function mergeEngineConfigPartial(
  ...layers: Array<Partial<EngineConfigUpdate> | null | undefined>
): EngineConfigUpdate {
  let acc: EngineConfigUpdate = {};
  for (const layer of layers) {
    const n = normalizeEngineConfigUpdate(layer);
    acc = { ...acc, ...n };
  }
  return acc;
}

/**
 * 配置就绪度（纯）：空 / 部分 / 可用。
 * - empty：无 model、无 baseUrl、无 apiKey
 * - partial：有部分字段但未 usable
 * - usable：有 model，且 baseUrl 为空或合法
 * - ready：usable + hasApiKey（或 account-center / auto 凭证模式可暂无本地 key）
 *
 * K-01 注记：update 载荷中的 apiKey 已剥离（不参与下发）；本纯函数仍接受
 * 调用方原始配置对象中的 apiKey 字段做就绪度分类（legacy 只读兼容）。
 */
export function engineConfigReadiness(
  config: Partial<EngineConfigUpdate> | null | undefined,
): EngineConfigReadiness {
  const n = normalizeEngineConfigUpdate(config);
  const hasModel = Boolean(n.model);
  const hasBaseUrl = Boolean(n.baseUrl);
  const baseUrlValid = hasBaseUrl ? isValidEngineBaseUrl(n.baseUrl) : false;
  const rawKey = (config as { apiKey?: unknown } | null | undefined)?.apiKey;
  const hasApiKey = Boolean(
    typeof rawKey === 'string' && rawKey.trim()
  );
  const mode = normalizeEngineCredentialMode(n.credentialMode);
  const empty = !hasModel && !hasBaseUrl && !hasApiKey && mode === undefined && n.endpoint === undefined;
  // baseUrl 可选：有则必须合法；无 baseUrl 仍可 usable（本机已配引擎默认地址时）
  const usable = hasModel && (!hasBaseUrl || baseUrlValid);
  const credentialMaySupplyKey = mode === 'account-center' || mode === 'auto';
  const ready = usable && (hasApiKey || credentialMaySupplyKey);
  const partial = !empty && !usable;
  return {
    hasModel,
    hasBaseUrl,
    baseUrlValid,
    hasApiKey,
    usable,
    ready,
    empty,
    partial,
  };
}

/** 空配置（纯） */
export function isEmptyEngineConfig(
  config: Partial<EngineConfigUpdate> | null | undefined,
): boolean {
  return engineConfigReadiness(config).empty;
}

/** 部分配置：有字段但尚不可用（纯） */
export function isPartialEngineConfig(
  config: Partial<EngineConfigUpdate> | null | undefined,
): boolean {
  return engineConfigReadiness(config).partial;
}

/**
 * 构建 daemon `update-config` 请求体（纯）。
 * 仅包含已规范化、非空字段；始终带 type。
 */
export function buildUpdateConfigPayload(
  update: Partial<EngineConfigUpdate> | null | undefined,
): Record<string, unknown> {
  const n = normalizeEngineConfigUpdate(update);
  const payload: Record<string, unknown> = { type: 'update-config' };
  for (const [k, v] of Object.entries(n)) {
    if (v !== undefined && v !== '') payload[k] = v;
  }
  return payload;
}

/**
 * 最近模型列表规范化（纯）：trim、丢空、保序去重。
 * 不发明演示 id；非法 → []。
 */
export function normalizeRecentModels(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const m = normalizeEngineModelId(raw);
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/**
 * 合并 current + recent 供 picker（纯）。
 * current 优先置顶；不注入硬编码远程模型。
 */
export function mergeModelsForPicker(
  recent: unknown,
  current?: string | null,
): string[] {
  const list = normalizeRecentModels(recent);
  const cur = normalizeEngineModelId(current);
  if (cur && !list.includes(cur)) return [cur, ...list];
  if (cur) {
    // 已在列表：置顶
    return [cur, ...list.filter((x) => x !== cur)];
  }
  return list;
}

/**
 * 从 get-status 原始 JSON 抽取引擎状态字段（纯，无副作用）。
 * 兼容 provider / config / providerStatus 嵌套；不写 recent、不发明 model。
 */
export function parseEngineStatusFromRaw(res: unknown): Omit<EngineStatus, 'raw'> {
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    return { ok: false, error: 'invalid_status' };
  }
  const root = res as Record<string, unknown>;

  const provider =
    (pickNested(root, ['provider']) as Record<string, unknown> | undefined) ||
    (pickNested(root, ['config']) as Record<string, unknown> | undefined) ||
    {};

  const nestedProvider =
    (pickNested(root, ['providerStatus']) as Record<string, unknown> | undefined) ||
    (pickNested(root, ['lifecycle', 'providerStatus']) as Record<string, unknown> | undefined);

  const src = { ...provider, ...(nestedProvider || {}) };

  const apiKeyInfo =
    (pickNested(root, ['provider', 'apiKey']) as Record<string, unknown> | undefined) ||
    (pickNested(src, ['apiKey']) as Record<string, unknown> | undefined) ||
    (pickNested(root, ['apiKey']) as Record<string, unknown> | undefined);

  const hasApiKey =
    typeof apiKeyInfo?.hasApiKey === 'boolean'
      ? apiKeyInfo.hasApiKey
      : typeof src.hasApiKey === 'boolean'
        ? (src.hasApiKey as boolean)
        : Boolean(pickNested(root, ['hasApiKey']));

  const model =
    normalizeEngineModelId(src.model) ||
    normalizeEngineModelId(provider.model) ||
    normalizeEngineModelId(root.model) ||
    undefined;

  const baseUrlRaw =
    (typeof src.baseUrl === 'string' && src.baseUrl) ||
    (typeof provider.baseUrl === 'string' && provider.baseUrl) ||
    (typeof root.baseUrl === 'string' && root.baseUrl) ||
    undefined;
  const baseUrl = baseUrlRaw ? normalizeEngineBaseUrl(baseUrlRaw) || undefined : undefined;

  const credentialMode =
    normalizeEngineCredentialMode(src.credentialMode) ||
    normalizeEngineCredentialMode(provider.credentialMode) ||
    undefined;

  return {
    ok: true,
    ...(model !== undefined && { model }),
    ...(baseUrl !== undefined && { baseUrl }),
    hasApiKey,
    ...(credentialMode !== undefined && { credentialMode }),
  };
}

function pickNested(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// ─── localStorage + daemon I/O ───────────────────────────────────────────────

export function loadRecentModels(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_MODELS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return normalizeRecentModels(arr);
  } catch {
    return [];
  }
}

export function pushRecentModel(model: string): string[] {
  const m = normalizeEngineModelId(model);
  if (!m) return loadRecentModels();
  const next = [m, ...loadRecentModels().filter((x) => x !== m)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

/**
 * 产品策略「默认引擎永不离线」：
 * - 已 startKeepAlive：短暂未连上 → ok:true + reconnecting（不弹 engine-down）
 * - 仅在用户显式 disconnect、且未 keep-alive 时才 ok:false
 */
export async function fetchEngineStatus(): Promise<EngineStatus> {
  const client = getDesktopDaemonClient();
  client.startKeepAlive();
  try {
    const ready = await client.waitUntilConnected(12_000);
    if (!ready) {
      // keep-alive 仍在跑 / 曾连通过 → 对用户视为引擎在场（后台重连）
      if (client.isKeepAliveStarted() || client.hasEverConnected()) {
        return {
          ok: true,
          connected: false,
          reconnecting: true,
          error: 'reconnecting',
          raw: { reconnecting: true, state: client.getState() },
        };
      }
      return { ok: false, connected: false, error: 'not_connected' };
    }

    const res = (await client.request({ type: 'get-status' }, 'status-response', 8_000)) as Record<
      string,
      unknown
    >;

    // 不在 get-status 时写入 recent：避免引擎演示默认（如 mimo）污染本机最近列表
    // recent 仅由用户主动 activate / update-config 写入
    const parsed = parseEngineStatusFromRaw(res);
    return {
      ...parsed,
      ok: true,
      connected: true,
      reconnecting: false,
      raw: res,
    };
  } catch (e) {
    logInternalError('fetchEngineStatus', e);
    // 请求失败但 keep-alive 仍在：不恐吓离线
    if (client.isKeepAliveStarted() || client.hasEverConnected()) {
      return {
        ok: true,
        connected: client.isConnected(),
        reconnecting: !client.isConnected(),
        error: e instanceof Error ? e.message : String(e),
        raw: { reconnecting: true },
      };
    }
    return {
      ok: false,
      connected: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function updateEngineConfig(
  update: EngineConfigUpdate,
): Promise<{ ok: boolean; error?: string }> {
  const client = getDesktopDaemonClient();
  try {
    const ready = await client.waitUntilConnected(12_000);
    if (!ready) return { ok: false, error: 'not_connected' };

    const normalized = normalizeEngineConfigUpdate(update);
    if (isEmptyEngineConfigUpdate(normalized)) {
      // 无可下发字段：视为成功 no-op（避免空 update-config 打 daemon）
      return { ok: true };
    }

    const payload = buildUpdateConfigPayload(normalized);

    await client.request(payload, ['config-updated', 'status-response', 'error'], 12_000);
    if (typeof normalized.model === 'string' && normalized.model) {
      pushRecentModel(normalized.model);
    }
    return { ok: true };
  } catch (e) {
    logInternalError('updateEngineConfig', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Models shown in chat picker: recent + current engine model. */
export function modelsForPicker(current?: string): string[] {
  return mergeModelsForPicker(loadRecentModels(), current);
}
