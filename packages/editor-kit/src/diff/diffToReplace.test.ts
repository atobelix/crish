import { describe, it, expect } from 'vitest';
import {
  diffToReplace,
  isHighSurrogate,
  isLowSurrogate,
  isSurrogateCodePoint,
  utf16OffsetToUnicodeScalar,
  unicodeScalarToUtf16Offset,
  countUnicodeScalars,
} from './diffToReplace';

describe('diffToReplace - Surrogate Aware & Scalar Calculations', () => {
  describe('代理项判定工具', () => {
    it('正确判定高低代理项', () => {
      expect(isHighSurrogate(0xd83c)).toBe(true);
      expect(isHighSurrogate(0xdbff)).toBe(true);
      expect(isHighSurrogate(0xdc00)).toBe(false);
      expect(isHighSurrogate(0x0041)).toBe(false);

      expect(isLowSurrogate(0xdf89)).toBe(true);
      expect(isLowSurrogate(0xdfff)).toBe(true);
      expect(isLowSurrogate(0xd83c)).toBe(false);

      expect(isSurrogateCodePoint(0xd83c)).toBe(true);
      expect(isSurrogateCodePoint(0xdf89)).toBe(true);
      expect(isSurrogateCodePoint(0x0041)).toBe(false);
    });
  });

  describe('坐标系双向转换 (UTF-16 <-> Unicode Scalar)', () => {
    it('纯 ASCII 字符串 1:1 对应', () => {
      const text = 'Hello, World!';
      expect(countUnicodeScalars(text)).toBe(13);
      expect(utf16OffsetToUnicodeScalar(text, 5)).toBe(5);
      expect(unicodeScalarToUtf16Offset(text, 5)).toBe(5);
    });

    it('单个 Emoji 辅助平面字符 (🎉 U+1F389, UTF-16 len=2, scalar=1)', () => {
      const text = '🎉Hello';
      // '🎉' = \uD83C\uDF89 (2 code units, 1 scalar)
      expect(text.length).toBe(7);
      expect(countUnicodeScalars(text)).toBe(6);

      // 偏移 2 (在 🎉 之后，H 之前)
      expect(utf16OffsetToUnicodeScalar(text, 2)).toBe(1);
      expect(unicodeScalarToUtf16Offset(text, 1)).toBe(2);

      // 偏移 3 ('H' 之后)
      expect(utf16OffsetToUnicodeScalar(text, 3)).toBe(2);
      expect(unicodeScalarToUtf16Offset(text, 2)).toBe(3);
    });

    it('生僻字 (𠮷 U+20BB7, UTF-16 len=2, scalar=1)', () => {
      const text = '𠮷野家';
      expect(text.length).toBe(4);
      expect(countUnicodeScalars(text)).toBe(3);

      expect(utf16OffsetToUnicodeScalar(text, 2)).toBe(1);
      expect(unicodeScalarToUtf16Offset(text, 1)).toBe(2);
      expect(utf16OffsetToUnicodeScalar(text, 3)).toBe(2);
      expect(unicodeScalarToUtf16Offset(text, 2)).toBe(3);
    });

    it('ZWJ 复合表情 👨‍👩‍👧‍👦 (11 UTF-16 code units, 7 scalars)', () => {
      const text = '👨‍👩‍👧‍👦Text';
      // 👨(2) + ZWJ(1) + 👩(2) + ZWJ(1) + 👧(2) + ZWJ(1) + 👦(2) = 11 code units, 7 scalars
      // 'Text' = 4 code units, 4 scalars
      // 总 length = 15, 总 scalars = 11
      expect(text.length).toBe(15);
      expect(countUnicodeScalars(text)).toBe(11);

      // 定位到 'Text' 之前 (UTF-16 11 -> scalar 7)
      expect(utf16OffsetToUnicodeScalar(text, 11)).toBe(7);
      expect(unicodeScalarToUtf16Offset(text, 7)).toBe(11);
    });

    it('边界与越界防护', () => {
      const text = 'test';
      expect(utf16OffsetToUnicodeScalar(text, -5)).toBe(0);
      expect(utf16OffsetToUnicodeScalar(text, 100)).toBe(4);
      expect(unicodeScalarToUtf16Offset(text, -1)).toBe(0);
      expect(unicodeScalarToUtf16Offset(text, 100)).toBe(4);
    });
  });

  describe('diffToReplace 比对算子', () => {
    it('相同字符串返回空替换', () => {
      const res = diffToReplace('Hello', 'Hello');
      expect(res.start).toBe(0);
      expect(res.end).toBe(0);
      expect(res.startScalar).toBe(0);
      expect(res.endScalar).toBe(0);
      expect(res.insert).toBe('');
      expect(res.oldScalarLength).toBe(5);
      expect(res.newScalarLength).toBe(5);
    });

    it('普通 ASCII 文本中间插入', () => {
      const res = diffToReplace('Hello World', 'Hello Brave World');
      expect(res.start).toBe(6);
      expect(res.end).toBe(6);
      expect(res.insert).toBe('Brave ');
      expect(res.startScalar).toBe(6);
      expect(res.endScalar).toBe(6);
    });

    it('普通 ASCII 文本删除', () => {
      const res = diffToReplace('Hello Brave World', 'Hello World');
      expect(res.start).toBe(6);
      expect(res.end).toBe(12);
      expect(res.insert).toBe('');
    });

    it('Emoji 替换绝不断裂代理项 (🎉 -> 🎊)', () => {
      // oldText: "A🎉B" = ['A', '\uD83C', '\uDF89', 'B']
      // newText: "A🎊B" = ['A', '\uD83D', '\uDF89', 'B']
      const oldText = 'A🎉B';
      const newText = 'A🎊B';

      const res = diffToReplace(oldText, newText);

      // start 必须在 🎉 之前 (index 1)，end 必须在 🎉 之后 (index 3)
      expect(res.start).toBe(1);
      expect(res.end).toBe(3);
      expect(res.insert).toBe('🎊');
      expect(res.startScalar).toBe(1);
      expect(res.endScalar).toBe(2);

      // 验证替换后的字符串与 newText 严格一致
      const reconstructed =
        oldText.slice(0, res.start) + res.insert + oldText.slice(res.end);
      expect(reconstructed).toBe(newText);
    });

    it('Emoji 前部插入字符 (🎉Hello -> A🎉Hello)', () => {
      const oldText = '🎉Hello';
      const newText = 'A🎉Hello';

      const res = diffToReplace(oldText, newText);
      expect(res.start).toBe(0);
      expect(res.end).toBe(0);
      expect(res.insert).toBe('A');

      const reconstructed =
        oldText.slice(0, res.start) + res.insert + oldText.slice(res.end);
      expect(reconstructed).toBe(newText);
    });

    it('ZWJ 复合表情后的文本替换 (👨‍👩‍👧‍👦Text -> 👨‍👩‍👧‍👦Doc)', () => {
      const oldText = '👨‍👩‍👧‍👦Text';
      const newText = '👨‍👩‍👧‍👦Doc';

      const res = diffToReplace(oldText, newText);
      expect(res.start).toBe(11);
      expect(res.end).toBe(15);
      expect(res.startScalar).toBe(7);
      expect(res.endScalar).toBe(11);
      expect(res.insert).toBe('Doc');

      const reconstructed =
        oldText.slice(0, res.start) + res.insert + oldText.slice(res.end);
      expect(reconstructed).toBe(newText);
    });

    it('从空文本到包含 Emoji 的文本', () => {
      const res = diffToReplace('', '🎉Hello🚀');
      expect(res.start).toBe(0);
      expect(res.end).toBe(0);
      expect(res.insert).toBe('🎉Hello🚀');
      expect(res.oldScalarLength).toBe(0);
      expect(res.newScalarLength).toBe(7);
    });

    it('全部删除至空文本', () => {
      const res = diffToReplace('🎉Hello🚀', '');
      expect(res.start).toBe(0);
      expect(res.end).toBe(9); // 2 + 5 + 2 = 9
      expect(res.insert).toBe('');
      expect(res.oldScalarLength).toBe(7);
      expect(res.newScalarLength).toBe(0);
    });
  });
});
