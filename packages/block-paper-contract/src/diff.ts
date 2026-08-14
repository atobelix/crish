/**
 * 强类型差分替换契约与代理项感知最长公共前后缀比对算子。
 *
 * 约束来源：
 * - PLAN-ROUND-3-03 §2.3 / §4.4
 * - CRDT-02 & CRDT-04
 * - CODE_MODIFICATION_SYSTEMIC_DISCIPLINE.md §4.3
 *
 * 彻底消除 start/end 在标量与 UTF-16 之间的语义相反与歧义缺陷。
 */

import {
  asUtf16Offset,
  isInsideSurrogatePair,
  utf16OffsetToUnicodeScalar,
  unicodeScalarLength,
} from './coordinates';

/**
 * 差分替换计算结果（强类型双坐标系）。
 * 彻底消除 start/end 在标量与 UTF-16 之间的歧义。
 */
export interface DiffReplaceResult {
  /** Unicode 标量替换起始偏移量（用于 CRDT / Rust Yrs 后端） */
  readonly startScalar: number;
  /** Unicode 标量原文本替换结束偏移量（用于 CRDT / Rust Yrs 后端） */
  readonly endScalar: number;
  /** UTF-16 代码单元替换起始偏移量（对齐代理项边界，用于 ProseMirror / JS） */
  readonly startU16: number;
  /** UTF-16 原文本代码单元替换结束偏移量（对齐代理项边界，用于 ProseMirror / JS） */
  readonly endU16: number;
  /** 替换的目标子串 */
  readonly replacement: string;
  /** 别名兼容 insert */
  readonly insert: string;
  /** 原字符串 Unicode 标量总长度 */
  readonly oldScalarLength?: number;
  /** 新字符串 Unicode 标量总长度 */
  readonly newScalarLength?: number;
}

/**
 * 代理项感知的最长公共前后缀比对算子。
 *
 * 保证 start 与 end 绝不切断 Emoji 代理项对，杜绝 Emoji 代理项断裂。
 * 同时产出 JS UTF-16 与 Unicode Scalar 双坐标系精确值。
 *
 * @param oldText 编辑前旧文本
 * @param newText 编辑后新文本
 */
export function diffToReplace(
  oldText: string,
  newText: string
): DiffReplaceResult {
  const oldScalarLength = unicodeScalarLength(oldText) as number;
  const newScalarLength = unicodeScalarLength(newText) as number;

  // 1. 相等快速路径
  if (oldText === newText) {
    return {
      startScalar: 0,
      endScalar: 0,
      startU16: 0,
      endU16: 0,
      replacement: '',
      insert: '',
      oldScalarLength,
      newScalarLength,
    };
  }

  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);

  // 2. 扫描最长公共前缀
  while (
    start < minLen &&
    oldText.charCodeAt(start) === newText.charCodeAt(start)
  ) {
    start += 1;
  }

  // 代理项前缀边界对齐：
  // 若 start 落在代理项对内部（低位代理项起始位置），向前回退 1 单元，保护完整 Emoji
  if (isInsideSurrogatePair(oldText, start)) {
    start -= 1;
  }

  // 3. 扫描最长公共后缀
  let endOld = oldText.length;
  let endNew = newText.length;

  while (
    endOld > start &&
    endNew > start &&
    oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)
  ) {
    endOld -= 1;
    endNew -= 1;
  }

  // 代理项后缀边界对齐：
  // 若 endOld 落在代理项对内部（低位代理项起始位置），向后推进 1 单元，将低位代理项一同纳入替换区
  if (isInsideSurrogatePair(oldText, endOld)) {
    endOld += 1;
    endNew += 1;
  }

  // 防御性越界检查
  if (start > endOld) {
    endOld = start;
    endNew = Math.max(start, endNew);
  }

  const startU16 = start;
  const endU16 = endOld;
  const startScalar = utf16OffsetToUnicodeScalar(
    oldText,
    asUtf16Offset(start)
  ) as number;
  const endScalar = utf16OffsetToUnicodeScalar(
    oldText,
    asUtf16Offset(endOld)
  ) as number;
  const replacement = newText.slice(start, endNew);

  return {
    startScalar,
    endScalar,
    startU16,
    endU16,
    replacement,
    insert: replacement,
    oldScalarLength,
    newScalarLength,
  };
}
