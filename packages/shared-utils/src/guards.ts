/**
 * 类型守卫工具函数
 */

/**
 * 判断值是否为非 null 的对象（且不是数组）
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 判断值是否为 PromiseLike
 */
export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).then === "function"
  );
}

/**
 * 判断字符串是否非空
 */
export function nonEmptyString(value: string | undefined | null): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * 判断错误是否为 Node.js 系统错误
 */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
