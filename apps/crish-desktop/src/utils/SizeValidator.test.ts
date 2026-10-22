/**
 * truncateToBytes 等价性测试：单点定位实现必须与「逐 grapheme 累加字节直到超限」
 * 的参考语义逐字一致（含代理对、ZWJ 序列、国旗、组合字符、CJK 混排）。
 */
import { describe, it, expect } from 'vitest';
import { truncateToBytes } from './SizeValidator';

const SUFFIX = '...[截断]';
const encoder = new TextEncoder();

function referenceTruncate(text: string, maxBytes: number): string {
  if (encoder.encode(text).length <= maxBytes) return text;
  const available = maxBytes - encoder.encode(SUFFIX).length;
  if (available <= 0) return SUFFIX;
  let acc = 0;
  let out = '';
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const { segment } of segmenter.segment(text)) {
    const n = encoder.encode(segment).length;
    if (acc + n > available) break;
    acc += n;
    out += segment;
  }
  return out + SUFFIX;
}

const ALPHABET = [
  'a',
  'Z',
  '中',
  '𠮷',
  '🎉',
  '👨‍👩‍👧',
  '🇺🇸',
  'e\u0301',
  'ก\u0e33',
  '\u200d',
  ' ',
  '\n',
];

/** 确定性 LCG，保证失败可复现 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('truncateToBytes — 与逐 grapheme 参考实现等价', () => {
  it('随机混排文本在所有字节上限下结果一致', () => {
    const rng = makeRng(20261021);
    for (let round = 0; round < 100; round++) {
      const len = 1 + Math.floor(rng() * 40);
      let text = '';
      for (let i = 0; i < len; i++) {
        text += ALPHABET[Math.floor(rng() * ALPHABET.length)];
      }
      const total = encoder.encode(text).length;
      for (let maxBytes = 0; maxBytes <= total + 1; maxBytes++) {
        expect(truncateToBytes(text, maxBytes)).toBe(
          referenceTruncate(text, maxBytes)
        );
      }
    }
  });

  it('非整数上限按向下取整语义处理', () => {
    const text = '中'.repeat(20);
    for (const maxBytes of [11.5, 14.2, 20.999, 33.1]) {
      expect(truncateToBytes(text, maxBytes)).toBe(
        referenceTruncate(text, maxBytes)
      );
    }
  });

  it('切点落在长组合字符簇内部时回退到簇起点', () => {
    const cluster = 'a' + '\u0301'.repeat(30); // 1 + 60 字节，单个 grapheme
    const text = 'xy' + cluster + 'tail'.repeat(10);
    const result = truncateToBytes(text, 40);
    expect(result).toBe('xy' + SUFFIX);
    expect(result).toBe(referenceTruncate(text, 40));
  });

  it('百 KB 级文本截断结果满足字节上限且保留最长前缀', () => {
    const text = '中a'.repeat(80 * 1024);
    const maxBytes = 100 * 1024;
    const result = truncateToBytes(text, maxBytes);
    const bytes = encoder.encode(result).length;
    expect(bytes).toBeLessThanOrEqual(maxBytes);
    expect(result.endsWith(SUFFIX)).toBe(true);
    // 再多一个字符就会超限 → 是最长前缀
    const body = result.slice(0, -SUFFIX.length);
    const next = text.slice(0, body.length + 1);
    expect(
      encoder.encode(next).length + encoder.encode(SUFFIX).length
    ).toBeGreaterThan(maxBytes);
  });
});
