/**
 * 连续性观测纯逻辑（D8 §3.7.4/§3.7.5）：临时通知老虎机滚动、错误 kind 中文映射。
 *
 * 纯 TS 无 React 依赖，便于单测：
 * - 老虎机滚动：attempt/maxAttempts 均取事件载荷（provider-diagnostic phase=retry），
 *   前端不做本地推算；数字递增时组件以 key 切换触发 CSS 过渡（简单老虎机效果）。
 * - 错误 kind 映射：kebab-case wire 值 → 中文展示文案（未知值原样回退，可观测）。
 * - 信息分级（用户约束 C）：重试进度不进对话历史，仅事件流 + 临时通知双面。
 */
import { PROVIDER_ERROR_KIND_VALUES } from '../../../../../packages/shared-types/src/generated/engine';

/** provider-diagnostic phase=retry 的 wire 值（生成类型 ProviderDiagnosticPhase） */
export const RETRY_PHASE = 'retry';

/** provider 错误 kind wire → 中文映射（PROVIDER_ERROR_KIND_VALUES 全覆盖） */
const ERROR_KIND_LABELS: Record<string, string> = {
  aborted: '已中止',
  'payload-too-large': '请求载荷过大',
  'gateway-challenge': '网关质询失败',
  auth: '认证失败',
  quota: '配额耗尽',
  'endpoint-unavailable': '服务端点不可用',
  'context-length-exceeded': '上下文长度超限',
  'invalid-request': '请求无效',
  'rate-limit': '触发限流',
  'server-error': '服务端错误',
  timeout: '请求超时',
  network: '网络异常',
  unknown: '未知错误',
};

/**
 * 错误 kind 中文映射：kebab-case wire 值 → 中文文案。
 * 未知值（含空）回退原文，未知字符串原样透传（引擎新枚举值不静默吞）。
 */
export function resolveErrorKindLabel(kind: string | undefined | null): string {
  const k = String(kind ?? '').trim();
  if (!k) return '';
  return ERROR_KIND_LABELS[k] ?? k;
}

/** wire kind 是否已登记（供测试/断言枚举覆盖） */
export function isKnownErrorKind(kind: string): boolean {
  return (PROVIDER_ERROR_KIND_VALUES as readonly string[]).includes(kind);
}

/** 老虎机滚动展示宽度：至少 2 字符（1/6 单数字、10/12 双数字均对齐） */
function digits(n: number): number {
  return String(Math.max(0, Math.floor(n))).length;
}

/** 分母对齐宽度：maxAttempts 位数（1/6 与 10/12 分母同宽，滚动不跳列） */
function denominatorWidth(maxAttempts: number): number {
  return Math.max(1, digits(maxAttempts));
}

/**
 * 临时通知文案：「重连中 1/6」→「重连中 2/6」。
 * attempt 从事件载荷取（1 起）；maxAttempts 缺省时按 0 显示（引擎未下发不臆测）。
 * 分子按分母位数补零对齐（1/6 与 1/10 数字滚动不跳列）。
 */
export function formatRetryLabel(
  attempt: number,
  maxAttempts: number | undefined
): string {
  const a = Math.max(0, Math.floor(attempt));
  const m =
    maxAttempts !== undefined ? Math.max(0, Math.floor(maxAttempts)) : 0;
  const width = denominatorWidth(m);
  return `重连中 ${String(a).padStart(width, '0')}/${m}`;
}

/** 数字是否发生递增（老虎机滚动动画触发判定：仅递增换帧，重复值不抖） */
export function isRetryAdvancing(
  prevAttempt: number | undefined,
  nextAttempt: number
): boolean {
  return prevAttempt === undefined || nextAttempt > prevAttempt;
}

/** 重连进行中（attempt > 0 且未达 maxAttempts；maxAttempts=0 视为未下发，恒进行中） */
export function isRetryInFlight(
  attempt: number,
  maxAttempts: number | undefined
): boolean {
  if (attempt <= 0) return false;
  if (maxAttempts === undefined || maxAttempts <= 0) return true;
  return attempt < maxAttempts;
}
