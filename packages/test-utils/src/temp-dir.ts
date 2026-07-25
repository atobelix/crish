/**
 * 临时目录工具 — 统一跨包测试的临时目录创建与清理
 *
 * 解决问题：44+ 测试文件各自内联 mkdtempSync + rm 逻辑，且多数丢失 Windows 重试。
 * 升级自 packages/agent-daemon/src/test-temp-cleanup.ts（仅同包 4 文件使用）。
 *
 * 用法：
 *   import { createTempDir, withTempDir, removeTempDirs } from "@crish/test-utils";
 *
 *   // 方式 1：手动管理（适合 beforeEach/afterEach 模式）
 *   let tempDir: string;
 *   beforeEach(async () => { tempDir = await createTempDir("my-test"); });
 *   afterEach(async () => { await removeTempDirs([tempDir]); });
 *
 *   // 方式 2：回调式自动清理（适合单测内联）
 *   await withTempDir(async (dir) => {
 *     await writeFile(join(dir, "test.txt"), "data");
 *     // 离开回调后自动清理
 *   });
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 创建一个临时目录。
 * @param prefix 目录名前缀，默认 "test"
 * @returns 临时目录绝对路径
 */
export async function createTempDir(prefix: string = "test"): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

/**
 * 批量删除临时目录（含 Windows 重试逻辑）。
 * @param tempDirs 要删除的目录路径数组（调用后数组被清空）
 */
export async function removeTempDirs(tempDirs: string[]): Promise<void> {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => removeTempDir(dir)));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 0,
    retryDelay: 25,
  });
}

/**
 * 创建临时目录，执行回调后自动清理。
 * @param fn 接收临时目录路径的回调
 * @param prefix 目录名前缀
 * @returns 回调的返回值
 */
export async function withTempDir<T>(
  fn: (tempDir: string) => Promise<T>,
  prefix: string = "test",
): Promise<T> {
  const dir = await createTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    await removeTempDir(dir);
  }
}
