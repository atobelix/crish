/**
 * 账号状态 API（T06.9.2：providerStore 直连 fetch 归位）
 *
 * 背景：
 * - providerStore.refreshAccountStatus 原先在 store 内裸 fetch(`/api/accounts/${id}/status`)，
 *   绕过 api 层且无超时 / 类型校验（AA-03 Q05）。本模块收口该网络调用，
 *   store 只消费类型化结果（Q25）。
 * - 命令映射表（transport/commandMap）与 Rust 命令清单中**不存在**账号状态专属命令
 *   （config_get / config_update 面向引擎配置面，与账号池无关），后端亦无对应
 *   HTTP 端点注册——按 T06.9 决策「无对应命令则用 http_request」：
 *   优先走 Tauri 原生 workbench_http_request（仅绝对 http(s) URL 可用），
 *   否则回退同源直连 fetch（保持原行为），统一超时 + 类型化解析。
 *
 * 调用方：store/provider/providerStore.ts（唯一）。
 */

import { getTransport } from './transport';

/** 请求超时（ms）：原实现无超时，统一加护栏防挂死 */
const ACCOUNT_STATUS_TIMEOUT_MS = 10_000;

/** 账号状态合法值（对齐 store/types.ts Account.status，Q25 类型契约） */
export type AccountStatusState = 'active' | 'expired' | 'error' | 'cooling';

/** 账号状态刷新结果：仅保留已知字段，未知字段忽略 */
export interface AccountStatus {
  status?: AccountStatusState;
  expiresAt?: number;
  cooldownUntil?: number;
  usageScore?: number;
}

const ACCOUNT_STATUS_STATES: readonly string[] = [
  'active',
  'expired',
  'error',
  'cooling',
];

/** 类型守卫：unknown → AccountStatus（Q25：store 状态与 API 返回类型一致） */
export function isAccountStatusPayload(raw: unknown): raw is AccountStatus {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  if (
    o.status !== undefined &&
    !(typeof o.status === 'string' && ACCOUNT_STATUS_STATES.includes(o.status))
  ) {
    return false;
  }
  for (const key of ['expiresAt', 'cooldownUntil', 'usageScore'] as const) {
    const v = o[key];
    if (v !== undefined && v !== null && typeof v !== 'number') return false;
  }
  return true;
}

/**
 * 解析响应体 JSON → 类型化 AccountStatus。
 * - 非法 JSON：抛错（与原 res.json() 语义一致，调用方走 error 回退）；
 * - 非对象载荷：返回空对象（无字段可更新，同原 data.status 缺省行为）；
 * - 已知字段按类型过滤：status 仅接受合法枚举，数值字段仅接受有限数字，
 *   其余字段忽略（杜绝脏类型写入 store）。
 */
export function parseAccountStatusPayload(text: string): AccountStatus {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const o = value as Record<string, unknown>;
  const out: AccountStatus = {};
  if (
    typeof o.status === 'string' &&
    ACCOUNT_STATUS_STATES.includes(o.status)
  ) {
    out.status = o.status as AccountStatusState;
  }
  for (const key of ['expiresAt', 'cooldownUntil', 'usageScore'] as const) {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/**
 * 构造同源绝对 URL：仅浏览器 http(s) 源可用（Tauri 自定义协议源不可用 →
 * 返回 null，调用方回退同源相对路径直连）。
 */
function resolveSameOriginUrl(path: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const origin = window.location.origin;
    if (!/^https?:\/\//i.test(origin)) return null;
    return new URL(path, origin).toString();
  } catch {
    return null;
  }
}

/** 带超时的同源 fetch（原实现的收口版） */
async function fetchSameOrigin(path: string): Promise<AccountStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACCOUNT_STATUS_TIMEOUT_MS);
  try {
    const res = await fetch(path, { method: 'POST', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseAccountStatusPayload(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 经 Tauri 原生 workbench_http_request 发起（仅绝对 http(s) URL）。
 * - 命令成功：按 HTTP 状态归一（非 ok → 抛错）；返回解析结果；
 * - 命令缺失 / 其它文案类错误：返回 null，交给调用方回退同源直连；
 * - 真网络错误（DNS / 连接 / 超时）：抛错（与 modelCatalog 语义一致）。
 */
async function fetchViaTauriHttp(
  url: string
): Promise<AccountStatus | null> {
  const res = await getTransport().call<{
    ok?: boolean;
    status?: number;
    body?: string;
  }>('workbench_http_request', {
    url,
    method: 'POST',
    headers: {},
    body: null,
  });
  if (res.status === 'ok') {
    const r = res.data;
    if (!r?.ok) throw new Error(`HTTP ${Number(r?.status) || 0}`);
    return parseAccountStatusPayload(String(r?.body ?? ''));
  }
  if (res.status === 'error') {
    const msg = res.message;
    if (/network:|dns|connect|refused|timeout/i.test(msg)) {
      throw new Error(msg);
    }
    // 其余（命令缺失 / IPC 文案类）→ 回退同源直连
  }
  return null;
}

/**
 * 刷新账号状态（T06.9.2 唯一调用面）。
 *
 * @param id 账号 id（Account.id）
 * @returns 类型化 AccountStatus；任何网络 / 解析失败均抛错（store 侧 catch 置 error 态）
 */
export async function refreshAccountStatus(id: string): Promise<AccountStatus> {
  const path = `/api/accounts/${encodeURIComponent(id)}/status`;
  const absolute = resolveSameOriginUrl(path);
  if (absolute) {
    const viaTauri = await fetchViaTauriHttp(absolute);
    if (viaTauri !== null) return viaTauri;
  }
  return fetchSameOrigin(path);
}
