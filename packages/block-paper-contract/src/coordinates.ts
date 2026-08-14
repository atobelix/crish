/**
 * 文本坐标系品牌类型与构造器（ProseMirror UTF-16 vs Rust Yrs Unicode Code Point）。
 *
 * 约束来源：CODE_MODIFICATION_SYSTEMIC_DISCIPLINE.md §2.3
 * ProseMirror 的 JS UTF-16 偏移与 Rust Yrs Unicode Code Point 标量必须经过
 * 代理项感知（Surrogate-Aware）算子双向单射转换，严禁直接混用数值。
 */

declare const Utf16Brand: unique symbol;
declare const UnicodeScalarBrand: unique symbol;

/** ProseMirror / JS 字符串基于 UTF-16 code unit 的偏移量 */
export type Utf16CodeUnitOffset = number & { readonly [Utf16Brand]: true };

/** Rust Yrs / CRDT 文本基于 Unicode Code Point (Scalar Value) 的标量偏移量 */
export type UnicodeScalarOffset = number & {
  readonly [UnicodeScalarBrand]: true;
};

/** 构造 Utf16CodeUnitOffset 品牌类型 */
export function createUtf16Offset(offset: number): Utf16CodeUnitOffset {
  if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
    throw new TypeError(`Invalid UTF-16 offset: ${offset}`);
  }
  return offset as Utf16CodeUnitOffset;
}

/** 构造 UnicodeScalarOffset 品牌类型 */
export function createUnicodeOffset(offset: number): UnicodeScalarOffset {
  if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
    throw new TypeError(`Invalid Unicode scalar offset: ${offset}`);
  }
  return offset as UnicodeScalarOffset;
}
