/**
 * 顺序 ID 生成器 mock — 统一测试中的确定性 ID 生成
 *
 * 解决问题：preview-queue 两个测试文件字面复制了相同的 sequentialIds 实现。
 *
 * 用法：
 *   import { sequentialIds } from "@crish/test-utils";
 *   const idFactory = sequentialIds("preview");
 *   idFactory(); // "preview_1"
 *   idFactory(); // "preview_2"
 */

/**
 * 创建一个顺序 ID 生成器，每次调用返回 `${prefix}_${n}`（n 从 1 递增）。
 * @param prefix ID 前缀
 */
export function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}_${++next}`;
}
