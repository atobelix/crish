import type { InvokeTypedResult } from '../tauriInvoke';
import { logger } from '../../services/LoggerService';

/** 核心就绪状态兼容引擎、数据库与旧 search-index 标记。 */
export function isCoreReady(status: unknown): boolean {
  if (typeof status !== 'object' || status === null) return false;
  const value = status as Record<string, unknown>;
  for (const key of [
    'engineReady',
    'engine_ready',
    'dbReady',
    'db_ready',
    'searchIndexReady',
    'search_index_ready',
  ] as const) {
    if (typeof value[key] === 'boolean') {
      if (value[key] === true) return true;
    }
  }
  return false;
}

/** 解析 Rust 事件 JSON；异常载荷保持静默丢弃。 */
export function safeParseEventPayload(
  payload: string
): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value === 'object' && value !== null) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 把 invokeTyped 三态结果转成 Promise<T> 使用的值或错误。 */
export function fromInvokeTyped<T>(res: InvokeTypedResult<T>, cmd: string): T {
  if (res.status === 'ok') return res.data;
  if (res.status === 'missing') {
    throw new Error(`Tauri command not available: ${cmd}`);
  }
  logger.error('invoke failed', {
    module: 'transport',
    err: { message: `${res.kind}: ${res.message}`, code: res.kind, name: cmd },
  });
  throw new Error(`${res.kind}: ${res.message}`);
}

/**
 * 只重试 Rust 在任何 run 装配副作用前返回的 restore gate 拒绝。
 * 其它 CoreError（包括权限拒绝、engine readiness、参数错误、IO 和通用 Internal）都不能重放：
 * 命令可能已产生副作用，重放会造成重复操作。
 */
export function isTransientInvokeResult(
  res: InvokeTypedResult<unknown>
): boolean {
  return (
    res.status === 'error' &&
    res.kind === 'Internal' &&
    /^restore in progress\b/i.test(res.message.trim())
  );
}
