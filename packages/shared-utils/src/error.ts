/**
 * 错误处理工具函数
 */

/**
 * 将 unknown 类型的错误转换为字符串消息
 *
 * 统一处理 Error、string、{ message: string } 等模式
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (isRecordWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

function isRecordWithMessage(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as Record<string, unknown>).message === "string"
  );
}
