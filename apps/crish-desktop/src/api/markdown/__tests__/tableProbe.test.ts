import { describe, expect, it } from 'vitest';
import { hasTableBlock } from '../tableProbe';

describe('hasTableBlock 高性能词法探针', () => {
  it('正确识别标准 GFM 表格定界行', () => {
    const text = '| Header A | Header B |\n| :--- | ---: |\n| 1 | 2 |';
    expect(hasTableBlock(text)).toBe(true);
  });

  it('正确识别流式中间态分隔行', () => {
    const text = '| Header A | Header B |\n| --- | --- |';
    expect(hasTableBlock(text)).toBe(true);
  });

  it('正确识别单列分隔行与各种对齐格式', () => {
    expect(hasTableBlock('| Column |\n| :---: |')).toBe(true);
    expect(hasTableBlock('| A | B | C |\n|:---|:---:|---:|')).toBe(true);
    expect(hasTableBlock('| A | B |\n| - | - |')).toBe(true);
  });

  it('正确识别无首尾管道符的表格定界行', () => {
    const text = 'Col 1 | Col 2\n--- | ---';
    expect(hasTableBlock(text)).toBe(true);
  });

  it('普通文本或仅包含管道符的非表格文本不应误判', () => {
    expect(hasTableBlock('')).toBe(false);
    expect(hasTableBlock('普通段落\n---\n分割线')).toBe(false);
    expect(hasTableBlock('这是带有 | 管道符的普通句子')).toBe(false);
    expect(hasTableBlock('||')).toBe(false);
    expect(hasTableBlock('| a | b |')).toBe(false); // 仅有数据行无定界行
  });

  it('执行时间控制在极低开销 (< 0.05ms)', () => {
    const tableText = '| Col 1 | Col 2 | Col 3 |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |';
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      hasTableBlock(tableText);
    }
    const end = performance.now();
    const avgMs = (end - start) / iterations;
    expect(avgMs).toBeLessThan(0.05);
  });
});
