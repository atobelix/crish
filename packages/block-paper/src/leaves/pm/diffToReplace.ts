/**
 * 代理项感知（Surrogate-Aware）最长公共前后缀比对算子与双坐标系单射转换。
 *
 * 约束来源：
 * - PLAN-ROUND-3-03 §2.3 / §2.5
 * - CODE_MODIFICATION_SYSTEMIC_DISCIPLINE.md §4.3
 *
 * 保证 start 与 end 绝不切断 Emoji 代理项对，并在 Intent 产出源头同时产出双坐标系确定值，
 * 彻底根除复合 Emoji（如 👨‍👩‍👧‍👦）、多字节代理项及 CJK 生僻字在 Rust/TS 跨语言边界上的坐标漂移。
 */

import {
  type Utf16CodeUnitOffset,
  type UnicodeScalarOffset,
  asUtf16Offset,
  asUnicodeScalarOffset,
  isHighSurrogate,
  isLowSurrogate,
  isInsideSurrogatePair,
  utf16OffsetToUnicodeScalar,
  unicodeScalarToUtf16Offset,
} from '@crish/block-paper-contract';

export {
  isHighSurrogate,
  isLowSurrogate,
  isInsideSurrogatePair,
  utf16OffsetToUnicodeScalar,
  unicodeScalarToUtf16Offset,
};

export type DiffReplaceResult = {
  startU16: Utf16CodeUnitOffset;
  endU16: Utf16CodeUnitOffset;
  startScalar: UnicodeScalarOffset;
  endScalar: UnicodeScalarOffset;
  insert: string;
  /** 兼容传统 { start, end, insert } 接口访问（标量值） */
  start: number;
  end: number;
};

/**
 * 代理项感知的确定性最长公共前后缀比对算子。
 * 保证 start 与 end 绝不切断 Emoji 代理项对，并同时产出双坐标系确定值。
 */
export function diffToReplace(
  oldText: string,
  newText: string
): DiffReplaceResult {
  if (oldText === newText) {
    const zeroU16 = asUtf16Offset(0);
    const zeroScalar = asUnicodeScalarOffset(0);
    return {
      startU16: zeroU16,
      endU16: zeroU16,
      startScalar: zeroScalar,
      endScalar: zeroScalar,
      insert: '',
      start: 0,
      end: 0,
    };
  }

  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);

  // 1. 扫描最长公共前缀
  while (
    start < minLen &&
    oldText.charCodeAt(start) === newText.charCodeAt(start)
  ) {
    start += 1;
  }

  // 代理项边界对齐：若 start 落在代理项对内部，向前回退 1 单元，保护高位代理项
  if (isInsideSurrogatePair(oldText, start)) {
    start -= 1;
  }

  // 2. 扫描最长公共后缀
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

  // 代理项边界对齐：若 endOld 落在代理项对内部，向后推进 1 单元，保护低位代理项
  if (isInsideSurrogatePair(oldText, endOld)) {
    endOld += 1;
    endNew += 1;
  }

  const startU16 = asUtf16Offset(start);
  const endU16 = asUtf16Offset(endOld);
  const startScalar = utf16OffsetToUnicodeScalar(oldText, startU16);
  const endScalar = utf16OffsetToUnicodeScalar(oldText, endU16);
  const insert = newText.slice(start, endNew);

  return {
    startU16,
    endU16,
    startScalar,
    endScalar,
    insert,
    start: startScalar as number,
    end: endScalar as number,
  };
}
