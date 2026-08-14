/**
 * 强类型标量坐标无损转换与单射映射单元测试。
 *
 * 验证：
 * 1. 品牌类型构造器与校验拦截（asUtf16Offset, asUnicodeScalarOffset, createUtf16Offset, createUnicodeOffset）；
 * 2. 代理项感知检测与边界对齐（isHighSurrogate, isLowSurrogate, isInsideSurrogatePair, alignToSurrogateBoundaryFloor/Ceil）；
 * 3. 极端 Unicode 边界场景下 JS UTF-16 与 Unicode 标量双向无损单射映射：
 *    - 场景 A：Emoji 辅助平面字符（🎉）
 *    - 场景 B：ZWJ 复合表情（👨‍👩‍👧‍👦、🏳️‍🌈）
 *    - 场景 C：CJK 辅助平面生僻字（𠮷野家）
 *    - 场景 D：组合音标（e\u0301）
 *    - 场景 E：多语言混合长文本与区间映射
 */

import { describe, expect, it } from 'vitest';
import {
  asUtf16Offset,
  asUnicodeScalarOffset,
  createUtf16Offset,
  createUnicodeOffset,
  isHighSurrogate,
  isLowSurrogate,
  isInsideSurrogatePair,
  alignToSurrogateBoundaryFloor,
  alignToSurrogateBoundaryCeil,
  utf16OffsetToUnicodeScalar,
  unicodeScalarToUtf16Offset,
  unicodeScalarLength,
  utf16Length,
  utf16RangeToUnicodeScalarRange,
  unicodeScalarRangeToUtf16Range,
} from './index';

describe('coordinates: 强类型品牌类型与构造器', () => {
  it('asUtf16Offset 与 asUnicodeScalarOffset 正确构造并在负数/NaN时抛出 RangeError', () => {
    const u16 = asUtf16Offset(10);
    expect(u16).toBe(10);
    const scalar = asUnicodeScalarOffset(5);
    expect(scalar).toBe(5);

    expect(() => asUtf16Offset(-1)).toThrow(RangeError);
    expect(() => asUtf16Offset(NaN)).toThrow(RangeError);
    expect(() => asUtf16Offset(Infinity)).toThrow(RangeError);

    expect(() => asUnicodeScalarOffset(-1)).toThrow(RangeError);
    expect(() => asUnicodeScalarOffset(NaN)).toThrow(RangeError);
    expect(() => asUnicodeScalarOffset(-Infinity)).toThrow(RangeError);
  });

  it('createUtf16Offset 与 createUnicodeOffset 保持向后兼容类型校验', () => {
    expect(createUtf16Offset(0)).toBe(0);
    expect(createUnicodeOffset(0)).toBe(0);
    expect(() => createUtf16Offset(1.2)).toThrow(TypeError);
    expect(() => createUnicodeOffset(-3)).toThrow(TypeError);
  });
});

describe('coordinates: 代理项检测与边界保护', () => {
  it('isHighSurrogate 与 isLowSurrogate 正确识别代理项区间', () => {
    // 0xD800 - 0xDBFF 为 High Surrogate
    expect(isHighSurrogate(0xd800)).toBe(true);
    expect(isHighSurrogate(0xd83c)).toBe(true);
    expect(isHighSurrogate(0xdbff)).toBe(true);
    expect(isHighSurrogate(0xdc00)).toBe(false);
    expect(isHighSurrogate(0x0041)).toBe(false);

    // 0xDC00 - 0xDFFF 为 Low Surrogate
    expect(isLowSurrogate(0xdc00)).toBe(true);
    expect(isLowSurrogate(0xdf89)).toBe(true);
    expect(isLowSurrogate(0xdfff)).toBe(true);
    expect(isLowSurrogate(0xdbff)).toBe(false);
  });

  it('isInsideSurrogatePair 与 alignToSurrogateBoundary 保护代理项不被截断', () => {
    const text = 'A🎉B'; // 'A' (0), '🎉' (1, 2), 'B' (3)
    expect(isInsideSurrogatePair(text, 0)).toBe(false);
    expect(isInsideSurrogatePair(text, 1)).toBe(false);
    expect(isInsideSurrogatePair(text, 2)).toBe(true); // 落在低位代理项起始
    expect(isInsideSurrogatePair(text, 3)).toBe(false);

    // Floor 对齐向前回退
    expect(alignToSurrogateBoundaryFloor(text, 2)).toBe(1);
    expect(alignToSurrogateBoundaryFloor(text, 1)).toBe(1);
    expect(alignToSurrogateBoundaryFloor(text, 3)).toBe(3);

    // Ceil 对齐向后推进
    expect(alignToSurrogateBoundaryCeil(text, 2)).toBe(3);
    expect(alignToSurrogateBoundaryCeil(text, 1)).toBe(1);
  });
});

describe('coordinates: 标量坐标双向单射转换（对齐 Rust chars().count()）', () => {
  it('场景 A：Emoji 辅助平面（🎉 单个代理项对）', () => {
    const text = '🎉Hello';
    expect(text.length).toBe(7); // UTF-16 code units
    expect(Array.from(text).length).toBe(6); // Unicode scalar count

    expect(utf16OffsetToUnicodeScalar(text, 0)).toBe(0);
    expect(utf16OffsetToUnicodeScalar(text, 2)).toBe(1); // 跳过 🎉
    expect(utf16OffsetToUnicodeScalar(text, 3)).toBe(2); // 'H' 之后
    expect(utf16OffsetToUnicodeScalar(text, 7)).toBe(6);

    // 逆向转换
    expect(unicodeScalarToUtf16Offset(text, 0)).toBe(0);
    expect(unicodeScalarToUtf16Offset(text, 1)).toBe(2);
    expect(unicodeScalarToUtf16Offset(text, 2)).toBe(3);
    expect(unicodeScalarToUtf16Offset(text, 6)).toBe(7);
  });

  it('场景 B：ZWJ 复合表情（👨‍👩‍👧‍👦 与 🏳️‍🌈 彻底消除 Off-by-4 漂移）', () => {
    const family = '👨‍👩‍👧‍👦Text';
    // "👨‍👩‍👧‍👦" 占 11 个 UTF-16 code units，7 个 Unicode 标量
    expect(family.length).toBe(15);
    expect(Array.from(family).length).toBe(11);

    // UTF-16 11 对应 标量 7（即 "Text" 的起始点）
    const scalarStart = utf16OffsetToUnicodeScalar(family, 11);
    expect(scalarStart).toBe(7);

    const scalarEnd = utf16OffsetToUnicodeScalar(family, 15);
    expect(scalarEnd).toBe(11);

    // 逆向映射 100% 精确还原
    expect(unicodeScalarToUtf16Offset(family, 7)).toBe(11);
    expect(unicodeScalarToUtf16Offset(family, 11)).toBe(15);

    // 🏳️‍🌈 彩虹旗 (U+1F3F3, U+FE0F, U+200D, U+1F308) -> 6 code units, 4 scalars
    const flag = '🏳️‍🌈Flag';
    expect(utf16OffsetToUnicodeScalar(flag, 6)).toBe(4);
    expect(unicodeScalarToUtf16Offset(flag, 4)).toBe(6);
  });

  it('场景 C：CJK 辅助平面生僻字（𠮷野家）', () => {
    const text = '𠮷野家'; // '𠮷' 占 2 code units, 1 scalar; '野' 1/1; '家' 1/1
    expect(text.length).toBe(4);
    expect(unicodeScalarLength(text)).toBe(3);
    expect(utf16Length(text)).toBe(4);

    expect(utf16OffsetToUnicodeScalar(text, 2)).toBe(1);
    expect(unicodeScalarToUtf16Offset(text, 1)).toBe(2);
    expect(utf16OffsetToUnicodeScalar(text, 3)).toBe(2);
    expect(unicodeScalarToUtf16Offset(text, 2)).toBe(3);
  });

  it('场景 D：组合音标（NFD 字符 e\\u0301）', () => {
    const text = 'e\u0301text'; // 2 scalars, 2 code units + 4 = 6
    expect(utf16OffsetToUnicodeScalar(text, 2)).toBe(2);
    expect(unicodeScalarToUtf16Offset(text, 2)).toBe(2);
  });

  it('场景 E：区间映射 utf16RangeToUnicodeScalarRange 与 unicodeScalarRangeToUtf16Range', () => {
    const text = 'Prefix: 👨‍👩‍👧‍👦 Middle 🎉 Suffix';
    const rangeU16: [number, number] = [8, 19]; // 覆盖 '👨‍👩‍👧‍👦' 整个表情
    const rangeScalar = utf16RangeToUnicodeScalarRange(text, rangeU16);
    expect(rangeScalar).toEqual([8, 15]);

    const backToU16 = unicodeScalarRangeToUtf16Range(text, rangeScalar);
    expect(backToU16).toEqual(rangeU16);
  });
});
