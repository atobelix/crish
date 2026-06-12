/**
 * 文件系统同步工具函数
 */

import { openSync, closeSync, fsyncSync } from "node:fs";
import { open as openAsync } from "node:fs/promises";

/**
 * 对指定路径执行 fsync，确保持久化
 *
 * 统一行为：始终在失败时抛出异常。
 * 调用方如需降级处理，在 catch 中自行决定策略。
 */
export function fsyncPath(path: string, mode: "r" | "r+" = "r"): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, mode);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不影响 fsync 的持久化保证
      }
    }
  }
}

/**
 * 对指定路径执行异步 fsync，确保持久化
 *
 * 异步版本，适用于异步上下文中使用。
 */
export async function fsyncPathAsync(path: string, mode: "r" | "r+" = "r"): Promise<void> {
  const handle = await openAsync(path, mode);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 对目录路径执行 fsync（目录 fd）
 *
 * @param path 目录路径
 * @param mode 持久化策略：
 *   - "strict"（默认）：遇到不支持目录 fsync 的文件系统时抛出异常
 *   - "best-effort"：遇到已知的不支持情况（tmpfs、overlayfs 等）静默跳过
 */
export function fsyncDirectoryPath(path: string, mode: "strict" | "best-effort" = "strict"): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    if (mode === "best-effort" && isExpectedDirectoryFsyncFailure(error)) {
      return;
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭错误
      }
    }
  }
}

/**
 * 判断目录 fsync 失败是否为预期行为
 *
 * 某些文件系统（tmpfs、overlayfs 等）不支持目录 fsync，
 * 这是已知的、可接受的降级行为。
 */
export function isExpectedDirectoryFsyncFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  // EPERM: tmpfs 不支持目录 fsync
  // EROFS: 只读文件系统
  // EINVAL: 某些网络文件系统
  return code === "EPERM" || code === "EROFS" || code === "EINVAL";
}
