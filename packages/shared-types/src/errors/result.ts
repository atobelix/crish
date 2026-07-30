// packages/shared-types/src/errors/result.ts
// CrishResult ADT，权威定义：./03-ERROR-MIGRATION.md §5.2

import { CrishError } from './classes';

/**
 * 不可变判别联合。readonly 字段避免误改。
 * 使用策略见 ./03-ERROR-MIGRATION.md §5.1：
 * - 公共 API 边界 / 异步流式 / 状态机转移 / 工具执行 / 审批决策 → 返回 CrishResult
 * - 内部辅助函数 / 入参校验 / 不可恢复错误 → throw
 */
export type CrishResult<T, E extends CrishError = CrishError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// ── 构造 ──
export function ok<T>(value: T): CrishResult<T, never>;
export function ok(): CrishResult<void, never>;
export function ok<T>(value?: T): CrishResult<T | void, never> {
  return { ok: true, value };
}

export function err<E extends CrishError>(error: E): CrishResult<never, E> {
  return { ok: false, error };
}

// ── 提取 ──
export function getOrThrow<T, E extends CrishError>(
  result: CrishResult<T, E>
): T {
  if (result.ok) return result.value;
  throw result.error;
}

export function unwrapOr<T, E extends CrishError>(
  result: CrishResult<T, E>,
  fallback: T
): T {
  return result.ok ? result.value : fallback;
}

// ── 转换 ──
export function mapResult<T, U, E extends CrishError>(
  result: CrishResult<T, E>,
  fn: (value: T) => U
): CrishResult<U, E> {
  return result.ok ? { ok: true, value: fn(result.value) } : result;
}

export function flatMapResult<
  T,
  U,
  E extends CrishError,
  E2 extends CrishError,
>(
  result: CrishResult<T, E>,
  fn: (value: T) => CrishResult<U, E2>
): CrishResult<U, E | E2> {
  return result.ok ? fn(result.value) : result;
}

/** 对 error 分支做转换（不改变 ok 分支） */
export function mapErr<T, E extends CrishError, E2 extends CrishError>(
  result: CrishResult<T, E>,
  fn: (error: E) => E2
): CrishResult<T, E2> {
  return result.ok ? result : { ok: false, error: fn(result.error) };
}

// ── 模式匹配 ──
export function match<T, U, E extends CrishError>(
  result: CrishResult<T, E>,
  handlers: { ok: (value: T) => U; err: (error: E) => U }
): U {
  return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
}

// ── 守卫 ──
export function isOk<T, E extends CrishError>(
  result: CrishResult<T, E>
): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E extends CrishError>(
  result: CrishResult<T, E>
): result is { ok: false; error: E } {
  return !result.ok;
}

// ── Promise 互转 ──
/**
 * 捕获 rejected promise 并包装为 CrishError（未知错误用 common.unknown）。
 * resolved → ok(value)，rejected → err(CrishError)
 */
export async function fromPromise<T>(
  promise: Promise<T>
): Promise<CrishResult<T, CrishError>> {
  try {
    const value = await promise;
    return { ok: true, value };
  } catch (e) {
    const error =
      e instanceof CrishError
        ? e
        : new CrishError(
            e instanceof Error ? e.message : String(e),
            'common.unknown',
            'permanent',
            false
          );
    return { ok: false, error };
  }
}

/**
 * 反向操作：ok 解包为 resolved，err 转为 rejected。
 * 用于必须 throw 的边界（如 React 事件处理器）。
 */
export function promiseResult<T, E extends CrishError>(
  result: CrishResult<T, E>
): Promise<T> {
  return result.ok
    ? Promise.resolve(result.value)
    : Promise.reject(result.error);
}
