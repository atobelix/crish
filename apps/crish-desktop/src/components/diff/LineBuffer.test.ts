// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { LineBuffer } from './LineBuffer';

describe('LineBuffer 紧凑二进制行索引契约测试', () => {
  it('空文本：返回单行空字符串，totalLines 为 1', () => {
    const buf = new LineBuffer('');
    expect(buf.totalLines).toBe(1);
    expect(buf.getLineText(0)).toBe('');
    expect(buf.getLineLength(0)).toBe(0);
    expect(buf.maxLineLength).toBe(0);
  });

  it('单行无换行：正确截取与测长', () => {
    const buf = new LineBuffer('console.log("hello");');
    expect(buf.totalLines).toBe(1);
    expect(buf.getLineText(0)).toBe('console.log("hello");');
    expect(buf.getLineLength(0)).toBe(21);
    expect(buf.maxLineLength).toBe(21);
  });

  it('多行 LF 换行：行数与切片严格对齐 split("\\n")', () => {
    const text = 'line 1\nline 2 is longer\n\nline 4';
    const expected = text.split('\n');
    const buf = new LineBuffer(text);

    expect(buf.totalLines).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(buf.getLineText(i)).toBe(expected[i]);
      expect(buf.getLineLength(i)).toBe(expected[i]!.length);
    }
    expect(buf.maxLineLength).toBe('line 2 is longer'.length);
  });

  it('以换行符结尾：末尾视为空行，行数严格对齐 split("\\n")', () => {
    const text = 'first\nsecond\n';
    const expected = text.split('\n'); // ['first', 'second', '']
    const buf = new LineBuffer(text);

    expect(buf.totalLines).toBe(3);
    expect(buf.getLineText(0)).toBe('first');
    expect(buf.getLineText(1)).toBe('second');
    expect(buf.getLineText(2)).toBe('');
    expect(buf.getLineLength(2)).toBe(0);
  });

  it('CRLF 换行支持：正确剥离 \\r 且长度一致', () => {
    const text = 'abc\r\ndefg\r\n';
    const buf = new LineBuffer(text);

    expect(buf.totalLines).toBe(3);
    expect(buf.getLineText(0)).toBe('abc');
    expect(buf.getLineText(1)).toBe('defg');
    expect(buf.getLineText(2)).toBe('');
    expect(buf.getLineLength(0)).toBe(3);
    expect(buf.getLineLength(1)).toBe(4);
    expect(buf.getLineLength(2)).toBe(0);
    expect(buf.maxLineLength).toBe(4);
  });

  it('显示宽度统计：宽字符按 2 单位计入 maxLineDisplayWidth，宽行标记 O(1) 可查', () => {
    const buf = new LineBuffer('a=1;\n中文注释占两倍宽度\nb=2;');
    // 最长行为 10 个汉字（字符数 10，显示宽度 20）
    expect(buf.maxLineLength).toBe('中文注释占两倍宽度'.length);
    expect(buf.maxLineDisplayWidth).toBe('中文注释占两倍宽度'.length * 2);
    expect(buf.isWideLine(0)).toBe(false);
    expect(buf.isWideLine(1)).toBe(true);
    expect(buf.isWideLine(2)).toBe(false);
    expect(buf.getLineDisplayWidth(1)).toBe('中文注释占两倍宽度'.length * 2);
    // 非宽行显示宽度 == 字符数
    expect(buf.getLineDisplayWidth(0)).toBe(4);
  });

  it('越界保护：超出行范围安全返回空', () => {
    const buf = new LineBuffer('only one');
    expect(buf.getLineText(-1)).toBe('');
    expect(buf.getLineText(100)).toBe('');
    expect(buf.getLineLength(-1)).toBe(0);
    expect(buf.getLineLength(100)).toBe(0);
  });

  it('超大行数扩容与性能测试 (40,000 行)', () => {
    const lines: string[] = [];
    for (let i = 0; i < 40000; i++) {
      lines.push(`const row_${i} = ${i};`);
    }
    const bigContent = lines.join('\n');

    const start = performance.now();
    const buf = new LineBuffer(bigContent);
    const duration = performance.now() - start;

    expect(buf.totalLines).toBe(40000);
    expect(buf.getLineText(0)).toBe('const row_0 = 0;');
    expect(buf.getLineText(39999)).toBe('const row_39999 = 39999;');
    // 构建时间断言 < 30ms
    expect(duration).toBeLessThan(30.0);
  });
});
