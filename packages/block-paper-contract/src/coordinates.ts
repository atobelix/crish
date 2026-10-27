/**
 * 文本坐标系品牌类型与强类型双向单射转换（ProseMirror UTF-16 vs Rust Yrs Unicode Code Point）。
 *
 * 约束来源：
 * - PLAN-ROUND-3-03 §2.2 / §2.3
 * - CODE_MODIFICATION_SYSTEMIC_DISCIPLINE.md §4.3
 * - ANTI_OVERENGINEERING_GUARDRAILS.md
 *
 * ProseMirror 的 JS UTF-16 偏移与 Rust Yrs Unicode Code Point 标量必须经过
 * 代理项感知（Surrogate-Aware）算子双向单射转换，严禁直接混用数值。
 */

declare const Utf16Brand: unique symbol;
declare const UnicodeScalarBrand: unique symbol;

/** ProseMirror / JS 字符串基于 UTF-16 code unit 的偏移量（0 <= offset <= string.length） */
export type Utf16CodeUnitOffset = number & { readonly [Utf16Brand]: true };

/** Rust Yrs / CRDT 文本基于 Unicode Code Point (Scalar Value) 的标量偏移量（0 <= offset <= chars().count()） */
export type UnicodeScalarOffset = number & {
  readonly [UnicodeScalarBrand]: true;
};

// ---------------------------------------------------------------------------
// 品牌类型转换 / 构造器
// ---------------------------------------------------------------------------

/**
 * 将普通数值转换为 Utf16CodeUnitOffset 强类型品牌。
 * 拦截负数与非有限数值。
 */
export function asUtf16Offset(offset: number): Utf16CodeUnitOffset {
  if (!Number.isFinite(offset) || offset < 0) {
    throw new RangeError(`[Coordinate] 非法的 UTF-16 偏移量: ${offset}`);
  }
  return Math.floor(offset) as Utf16CodeUnitOffset;
}

/**
 * 将普通数值转换为 UnicodeScalarOffset 强类型品牌。
 * 拦截负数与非有限数值。
 */
export function asUnicodeScalarOffset(offset: number): UnicodeScalarOffset {
  if (!Number.isFinite(offset) || offset < 0) {
    throw new RangeError(`[Coordinate] 非法的 Unicode 标量偏移量: ${offset}`);
  }
  return Math.floor(offset) as UnicodeScalarOffset;
}

/** 构造 Utf16CodeUnitOffset 品牌类型（兼容既有接口） */
export function createUtf16Offset(offset: number): Utf16CodeUnitOffset {
  if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
    throw new TypeError(`Invalid UTF-16 offset: ${offset}`);
  }
  return offset as Utf16CodeUnitOffset;
}

/** 构造 UnicodeScalarOffset 品牌类型（兼容既有接口） */
export function createUnicodeOffset(offset: number): UnicodeScalarOffset {
  if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
    throw new TypeError(`Invalid Unicode scalar offset: ${offset}`);
  }
  return offset as UnicodeScalarOffset;
}

// ---------------------------------------------------------------------------
// 代理项（Surrogate）感知判断与边界对齐
// ---------------------------------------------------------------------------

/**
 * 检测字符编码是否为 UTF-16 高位代理项 (High Surrogate: 0xD800 - 0xDBFF)
 */
export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 检测字符编码是否为 UTF-16 低位代理项 (Low Surrogate: 0xDC00 - 0xDFFF)
 */
export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 检测字符编码是否为代理项 (Surrogate: 0xD800 - 0xDFFF)
 */
export function isSurrogateCodePoint(code: number): boolean {
  return code >= 0xd800 && code <= 0xdfff;
}

/**
 * 检测 UTF-16 偏移量是否落在代理项对的内部（即低位代理项起始位置）
 */
export function isInsideSurrogatePair(
  text: string,
  offsetU16: number
): boolean {
  if (offsetU16 <= 0 || offsetU16 >= text.length) return false;
  const prev = text.charCodeAt(offsetU16 - 1);
  const curr = text.charCodeAt(offsetU16);
  return isHighSurrogate(prev) && isLowSurrogate(curr);
}

/**
 * 确保 UTF-16 偏移量对齐到代理项边界（若落在代理项中间，向前回退到高位代理项前）
 */
export function alignToSurrogateBoundaryFloor(
  text: string,
  offsetU16: number
): Utf16CodeUnitOffset {
  if (!Number.isFinite(offsetU16)) {
    throw new RangeError(`[Coordinate] 非法的 UTF-16 偏移量: ${offsetU16}`);
  }
  const clamped = Math.max(0, Math.min(Math.floor(offsetU16), text.length));
  if (isInsideSurrogatePair(text, clamped)) {
    return asUtf16Offset(clamped - 1);
  }
  return asUtf16Offset(clamped);
}

/**
 * 确保 UTF-16 偏移量对齐到代理项边界（若落在代理项中间，向后推进到低位代理项后）
 */
export function alignToSurrogateBoundaryCeil(
  text: string,
  offsetU16: number
): Utf16CodeUnitOffset {
  if (!Number.isFinite(offsetU16)) {
    throw new RangeError(`[Coordinate] 非法的 UTF-16 偏移量: ${offsetU16}`);
  }
  const clamped = Math.max(0, Math.min(Math.floor(offsetU16), text.length));
  if (isInsideSurrogatePair(text, clamped)) {
    return asUtf16Offset(clamped + 1);
  }
  return asUtf16Offset(clamped);
}

// ---------------------------------------------------------------------------
// 双向单射坐标转换算法
// ---------------------------------------------------------------------------

/**
 * 将 JS UTF-16 Code Unit 偏移精确转换为 Unicode 标量偏移（对齐 Rust chars().count()）
 * 单遍线性扫描，正确合并 High + Low Surrogate Pair。
 * 若传入落在代理项中间的偏移，统一执行 Floor 对齐（向下对齐至高位代理项起点），确保双向互逆单射。
 */
export function utf16OffsetToUnicodeScalar(
  text: string,
  offsetU16: Utf16CodeUnitOffset | number
): UnicodeScalarOffset {
  if (!Number.isFinite(offsetU16)) {
    throw new RangeError(`[Coordinate] 非法的 UTF-16 偏移量: ${offsetU16}`);
  }
  let scalarCount = 0;
  const rawLimit = Math.min(
    Math.max(0, Math.floor(offsetU16 as number)),
    text.length
  );
  // Floor 对齐：若 rawLimit 落在低位代理项上（代理项中间），向前回退 1 单元
  const limit = isInsideSurrogatePair(text, rawLimit) ? rawLimit - 1 : rawLimit;

  for (let i = 0; i < limit;) {
    const code = text.charCodeAt(i);
    // 检测是否为完整的代理项对
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
  return asUnicodeScalarOffset(scalarCount);
}

/**
 * 将 Unicode 标量偏移还原为 JS UTF-16 Code Unit 偏移
 * 单遍线性扫描，遇到代理项对向前推进 2 个 UTF-16 code units
 */
export function unicodeScalarToUtf16Offset(
  text: string,
  scalarOffset: UnicodeScalarOffset | number
): Utf16CodeUnitOffset {
  if (!Number.isFinite(scalarOffset)) {
    throw new RangeError(
      `[Coordinate] 非法的 Unicode 标量偏移量: ${scalarOffset}`
    );
  }
  let currentScalar = 0;
  let i = 0;
  const target = Math.max(0, Math.floor(scalarOffset as number));
  while (i < text.length && currentScalar < target) {
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
  return asUtf16Offset(i);
}

/**
 * 计算字符串的总 Unicode 标量长度（等价于 Rust `text.chars().count()`）
 */
export function unicodeScalarLength(text: string): UnicodeScalarOffset {
  return utf16OffsetToUnicodeScalar(text, text.length);
}

/**
 * 计算字符串的 Unicode 标量总数（等价于 unicodeScalarLength，兼容既有命名）
 */
export function countUnicodeScalars(text: string): number {
  return utf16OffsetToUnicodeScalar(text, text.length) as number;
}

/**
 * 计算字符串的总 UTF-16 长度（`text.length`）
 */
export function utf16Length(text: string): Utf16CodeUnitOffset {
  return asUtf16Offset(text.length);
}

/**
 * 转换 UTF-16 半开区间 [startU16, endU16] 为 Unicode 标量半开区间 [startScalar, endScalar]
 */
export function utf16RangeToUnicodeScalarRange(
  text: string,
  rangeU16: [number, number]
): [UnicodeScalarOffset, UnicodeScalarOffset] {
  const s = utf16OffsetToUnicodeScalar(text, rangeU16[0]);
  const e = utf16OffsetToUnicodeScalar(text, rangeU16[1]);
  return [s, e];
}

/**
 * 转换 Unicode 标量半开区间 [startScalar, endScalar] 为 UTF-16 半开区间 [startU16, endU16]
 */
export function unicodeScalarRangeToUtf16Range(
  text: string,
  rangeScalar: [number, number]
): [Utf16CodeUnitOffset, Utf16CodeUnitOffset] {
  const s = unicodeScalarToUtf16Offset(text, rangeScalar[0]);
  const e = unicodeScalarToUtf16Offset(text, rangeScalar[1]);
  return [s, e];
}
