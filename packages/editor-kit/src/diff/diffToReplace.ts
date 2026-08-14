/**
 * diffToReplace — 代理项感知（Surrogate-Aware）的最长公共前后缀比对算子与标量坐标转换。
 *
 * 依据 PLAN-ROUND-3-03 §2.3 规范：
 * - 解决 JS UTF-16 Code Unit 与 Rust Unicode Scalar / char 之间的坐标系漂移问题；
 * - 在扫描最长公共前缀与后缀时，对高低代理项（High / Low Surrogates，U+D800..U+DFFF）
 *   实施原子边界保护，绝对禁止将单个 Emoji（如 🎉 / \uD83C\uDF89）或 ZWJ 复合表情切成半截代理项；
 * - 产出双坐标系确定值：UTF-16 偏移（用于 ProseMirror）与 Unicode 标量偏移（用于 Rust / Yrs）。
 */

/**
 * 判断指定的 UTF-16 编码单元是否为高位代理项（High Surrogate: 0xD800..0xDBFF）
 */
export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 判断指定的 UTF-16 编码单元是否为低位代理项（Low Surrogate: 0xDC00..0xDFFF）
 */
export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 判断指定的 UTF-16 编码单元是否为代理项（Surrogate: 0xD800..0xDFFF）
 */
export function isSurrogateCodePoint(code: number): boolean {
  return code >= 0xd800 && code <= 0xdfff;
}

/**
 * 将 JS UTF-16 Code Unit 偏移精确转换为 Unicode 标量（Code Point）计数。
 * 单遍线性扫描，无堆内存分配，正确识别完整的 High + Low 代理项对为一个 Scalar。
 *
 * @param text 目标字符串
 * @param offsetU16 UTF-16 编码单元偏移量（0 <= offsetU16 <= text.length）
 * @returns 对应的 Unicode Code Point 标量计数（对齐 Rust text.chars().count()）
 */
export function utf16OffsetToUnicodeScalar(
  text: string,
  offsetU16: number
): number {
  if (offsetU16 <= 0) return 0;
  const limit = Math.min(offsetU16, text.length);
  let scalarCount = 0;
  let i = 0;

  while (i < limit) {
    const code = text.charCodeAt(i);
    if (
      isHighSurrogate(code) &&
      i + 1 < text.length &&
      isLowSurrogate(text.charCodeAt(i + 1))
    ) {
      i += 2;
    } else {
      i += 1;
    }
    scalarCount += 1;
  }

  return scalarCount;
}

/**
 * 将 Unicode 标量（Code Point）计数还原为 JS UTF-16 Code Unit 偏移量。
 *
 * @param text 目标字符串
 * @param scalarOffset Unicode 标量偏移量（0 <= scalarOffset <= chars().count()）
 * @returns 对应的 JS UTF-16 偏移量
 */
export function unicodeScalarToUtf16Offset(
  text: string,
  scalarOffset: number
): number {
  if (scalarOffset <= 0) return 0;
  let currentScalar = 0;
  let i = 0;

  while (i < text.length && currentScalar < scalarOffset) {
    const code = text.charCodeAt(i);
    if (
      isHighSurrogate(code) &&
      i + 1 < text.length &&
      isLowSurrogate(text.charCodeAt(i + 1))
    ) {
      i += 2;
    } else {
      i += 1;
    }
    currentScalar += 1;
  }

  return i;
}

/**
 * 计算字符串的 Unicode 标量（Code Point）总数（对齐 Rust chars().count()）。
 * 零内存分配。
 */
export function countUnicodeScalars(text: string): number {
  let count = 0;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const code = text.charCodeAt(i);
    if (
      isHighSurrogate(code) &&
      i + 1 < len &&
      isLowSurrogate(text.charCodeAt(i + 1))
    ) {
      i += 2;
    } else {
      i += 1;
    }
    count += 1;
  }

  return count;
}

/**
 * 差分替换计算结果。
 */
export type DiffReplaceResult = {
  /** UTF-16 替换起始偏移量（对齐代理项边界） */
  start: number;
  /** UTF-16 原文本替换结束偏移量（对齐代理项边界） */
  end: number;
  /** Unicode 标量替换起始偏移量 */
  startScalar: number;
  /** Unicode 标量原文本替换结束偏移量 */
  endScalar: number;
  /** 插入的新子串 */
  insert: string;
  /** 原字符串 Unicode 标量总长度 */
  oldScalarLength: number;
  /** 新字符串 Unicode 标量总长度 */
  newScalarLength: number;
};

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
  const oldScalarLength = countUnicodeScalars(oldText);
  const newScalarLength = countUnicodeScalars(newText);

  // 1. 相等快速路径
  if (oldText === newText) {
    return {
      start: 0,
      end: 0,
      startScalar: 0,
      endScalar: 0,
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
  // 若 start 落在低位代理项上且前一位是高位代理项，向前回退 1 单元，保护完整 Emoji
  if (
    start > 0 &&
    isLowSurrogate(oldText.charCodeAt(start)) &&
    isHighSurrogate(oldText.charCodeAt(start - 1))
  ) {
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
  // 若 endOld 落在高位代理项且后一位是低位代理项，向后推进 1 单元，将低位代理项一同纳入替换区
  if (
    endOld < oldText.length &&
    endOld > 0 &&
    isHighSurrogate(oldText.charCodeAt(endOld - 1)) &&
    isLowSurrogate(oldText.charCodeAt(endOld))
  ) {
    endOld += 1;
    endNew += 1;
  }

  // 防御性越界检查
  if (start > endOld) {
    endOld = start;
    endNew = Math.max(start, endNew);
  }

  const startScalar = utf16OffsetToUnicodeScalar(oldText, start);
  const endScalar = utf16OffsetToUnicodeScalar(oldText, endOld);
  const insert = newText.slice(start, endNew);

  return {
    start,
    end: endOld,
    startScalar,
    endScalar,
    insert,
    oldScalarLength,
    newScalarLength,
  };
}
