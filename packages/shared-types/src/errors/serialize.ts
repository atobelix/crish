// packages/shared-types/src/errors/serialize.ts
// 权威定义：./03-ERROR-MIGRATION.md §6.1
import type { JsonObject } from '../primitive-types';
import type { CrishErrorCode, CrishErrorCategory } from './codes';
import { isCrishErrorCode } from './codes';
import { CrishError } from './classes';

/** 跨进程序列化的错误负载（TS ↔ Rust ↔ 前端） */
export interface CrishErrorPayload {
  readonly code: CrishErrorCode;
  readonly message: string;
  readonly category: CrishErrorCategory;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action: string;
  readonly metadata?: JsonObject | undefined;
  /** 递归因果链，最多 8 层 */
  readonly cause?: CrishErrorPayload | undefined;
  /** 调用栈（仅开发环境，生产环境置空） */
  readonly stack?: string | undefined;
  /** 时间戳（epoch ms） */
  readonly timestamp: number;
}

/** 递归深度上限（设计约束 3） */
export const CRISH_ERROR_CAUSE_MAX_DEPTH = 8;

/** 从 CrishError 构造 Payload，自动截断 cause 链到 8 层 */
export function toErrorPayload(
  error: CrishError,
  depth = 0
): CrishErrorPayload {
  if (depth >= CRISH_ERROR_CAUSE_MAX_DEPTH) {
    return truncatedPayload(error, depth);
  }
  const code: CrishErrorCode = isCrishErrorCode(error.code)
    ? error.code
    : 'common.unknown';
  const cause =
    error.cause instanceof CrishError
      ? toErrorPayload(error.cause, depth + 1)
      : undefined;
  const stack =
    process.env.NODE_ENV !== 'production' && error.stack !== undefined
      ? error.stack
      : undefined;
  return {
    code,
    message: error.message,
    category: error.category,
    retryable: error.retryable,
    public: error.public,
    action: error.action,
    timestamp: Date.now(),
    ...(error.metadata !== undefined && { metadata: error.metadata }),
    ...(cause !== undefined && { cause }),
    ...(stack !== undefined && { stack }),
  };
}

/** 从 CrishErrorPayload 还原为 CrishError 实例（前端 invoke catch 后使用） */
export function fromErrorPayload(payload: CrishErrorPayload): CrishError {
  const cause =
    payload.cause !== undefined ? fromErrorPayload(payload.cause) : undefined;
  const options: { cause?: CrishError; public?: boolean; action?: string } = {
    public: payload.public,
    action: payload.action,
  };
  if (cause !== undefined) {
    options.cause = cause;
  }
  return new CrishError(
    payload.message,
    payload.code,
    payload.category,
    payload.retryable,
    payload.metadata,
    options
  );
}

/** 从任意值构造 Payload（兜底，未知错误用 common.unknown） */
export function fromUnknownError(error: unknown): CrishErrorPayload {
  if (error instanceof CrishError) return toErrorPayload(error);
  const stack =
    error instanceof Error && error.stack !== undefined
      ? error.stack
      : undefined;
  return {
    code: 'common.unknown',
    message: error instanceof Error ? error.message : String(error),
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.common.report_bug',
    timestamp: Date.now(),
    ...(stack !== undefined && { stack }),
  };
}

/**
 * 从未知错误构造 Payload 的工厂别名。
 * 与 fromUnknownError 语义相同，提供给偏好工厂函数命名的调用方。
 */
export function makeErrorPayload(error: unknown): CrishErrorPayload {
  return fromUnknownError(error);
}

/** 深度截断时的占位 Payload */
function truncatedPayload(error: CrishError, depth: number): CrishErrorPayload {
  return {
    code: 'common.unknown',
    message: `cause chain truncated at depth ${depth}`,
    category: 'permanent',
    retryable: false,
    public: false,
    action: 'action.runtime.none',
    timestamp: Date.now(),
  };
}

/**
 * HTTP 状态码 → CrishErrorCode 静态映射表。
 * 替代 if-else 分支，从结构上消除 CrishRestError 死代码模式（§6.1 设计要点 4）。
 * 权威定义：./03-ERROR-MIGRATION.md §6.1
 */
const HTTP_STATUS_TO_CODE: Readonly<Record<number, CrishErrorCode>> = {
  400: 'provider.schema',
  401: 'provider.auth',
  402: 'provider.quota',
  403: 'provider.auth',
  404: 'provider.endpoint_unavailable',
  405: 'provider.endpoint_unavailable',
  413: 'provider.schema',
  415: 'provider.endpoint_unavailable',
  422: 'provider.schema',
  429: 'provider.rate_limit',
  500: 'provider.server',
  502: 'provider.server',
  503: 'provider.server',
  504: 'provider.server',
  520: 'provider.server',
  522: 'provider.server',
  523: 'provider.server',
  524: 'provider.server',
};

export function codeFromHttpStatus(status: number): CrishErrorCode {
  return HTTP_STATUS_TO_CODE[status] ?? 'common.unknown';
}
