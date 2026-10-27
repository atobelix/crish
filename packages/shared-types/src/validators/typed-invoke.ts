import type { ZodType } from 'zod';

/**
 * 类型安全的 Tauri invoke 包装器。
 * 在运行时通过 Zod schema 校验 IPC 响应结构，
 * 确保任何 Rust 端的结构变更不会静默丢失数据。
 */
export function createTypedInvoke(
  invoke: (cmd: string, args?: unknown) => Promise<unknown>
) {
  return async function typedInvoke<T>(
    command: string,
    args: Record<string, unknown> | undefined,
    responseSchema: ZodType<T>
  ): Promise<T> {
    const raw = await invoke(command, args);
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      console.error(
        `[IPC Schema Violation] Command "${command}" returned unexpected shape:`,
        parsed.error.format()
      );
      throw new Error(
        `IPC response validation failed for "${command}": ${parsed.error.message}`
      );
    }
    return parsed.data;
  };
}
