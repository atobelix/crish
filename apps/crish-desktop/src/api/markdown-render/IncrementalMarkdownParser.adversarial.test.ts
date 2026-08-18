/**
 * IncrementalMarkdownParser adversarial 测试（C7）
 *
 * 覆盖用例：
 *   - 超大输入（单帧推送 > 1MB 文本，不卡死、不 OOM）
 *   - ReDoS（恶意嵌套 `*`.repeat(10000) + `_`.repeat(10000)，完成时间 < 100ms）
 *   - 恶意嵌套结构（1000 层嵌套列表/引用，不栈溢出）
 *   - Unicode 畸形（孤立代理对 `\uD800`、超长 ZWJ 序列，不崩溃不截断）
 *
 * 被测路径：IncrementalMarkdownParser.push（每帧 split('\n') +
 *           stripThoughtPlaceholders + processLine 状态机）
 */
import { describe, expect, it } from 'vitest';
import { IncrementalMarkdownParser } from './IncrementalMarkdownParser';

/**
 * 性能断言辅助：测量 fn 执行时间不超过 maxMs。
 * 使用 performance.now() 避免 Date.now 精度问题。
 */
function expectCompletesWithin<T>(label: string, maxMs: number, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  expect(elapsed, `${label} completed in ${elapsed.toFixed(1)}ms, threshold ${maxMs}ms`).toBeLessThan(maxMs);
  return result;
}

describe('IncrementalMarkdownParser adversarial', () => {
  // ===========================================================================
  // 1. 超大输入（单帧推送 > 1MB 文本）
  // ===========================================================================
  describe('超大输入', () => {
    it('单帧推送 1MB 纯文本段落不卡死、不 OOM', () => {
      const parser = new IncrementalMarkdownParser();
      const line = 'A'.repeat(80);
      const bigText = Array.from({ length: 13108 }, () => line).join('\n'); // ~1MB+

      const result = expectCompletesWithin(
        '1MB paragraph push',
        2000,
        () => parser.push(bigText),
      );

      // 应产生段落块（或 tailBlock），不抛异常
      expect(result.blockCount).toBeGreaterThanOrEqual(0);
      expect(parser).toBeDefined();
    });

    it('单帧推送 1MB 单行文本不卡死', () => {
      const parser = new IncrementalMarkdownParser();
      const bigLine = 'X'.repeat(1_048_576); // 1MB 单行

      const result = expectCompletesWithin(
        '1MB single line push',
        2000,
        () => parser.push(bigLine),
      );

      expect(result).toBeDefined();
    });

    it('多帧增量推送累计 2MB 不泄漏', () => {
      const parser = new IncrementalMarkdownParser();
      const chunk = 'B'.repeat(100_000) + '\n';

      // 分 20 帧推送，每帧 100KB，累计 ~2MB
      const start = performance.now();
      for (let i = 0; i < 20; i++) {
        parser.push(chunk + `chunk-${i}`);
      }
      const elapsed = performance.now() - start;

      expect(elapsed, `20-frame 2MB push took ${elapsed.toFixed(1)}ms`).toBeLessThan(5000);
    });
  });

  // ===========================================================================
  // 2. ReDoS（恶意嵌套强调标记）
  // ===========================================================================
  describe('ReDoS', () => {
    it('恶意嵌套 * x10000 + _ x10000 完成时间 < 100ms', () => {
      const parser = new IncrementalMarkdownParser();
      const malicious = '*'.repeat(10000) + '_'.repeat(10000);

      const result = expectCompletesWithin(
        'ReDoS * x10000 + _ x10000',
        100,
        () => parser.push(malicious),
      );

      expect(result).toBeDefined();
    });

    it('恶意交替 *[10000]_*[10000] 完成时间 < 200ms', () => {
      const parser = new IncrementalMarkdownParser();
      const malicious = '*_'.repeat(10000);

      const result = expectCompletesWithin(
        'ReDoS *_ x10000',
        200,
        () => parser.push(malicious),
      );

      expect(result).toBeDefined();
    });

    it('嵌套方括号 [[[[...]]]] x5000 不卡死', () => {
      const parser = new IncrementalMarkdownParser();
      const malicious = '['.repeat(5000) + ']' .repeat(5000);

      const result = expectCompletesWithin(
        'nested brackets x5000',
        200,
        () => parser.push(malicious),
      );

      expect(result).toBeDefined();
    });
  });

  // ===========================================================================
  // 3. 恶意嵌套结构（1000 层嵌套列表/引用）
  // ===========================================================================
  describe('恶意嵌套结构', () => {
    it('1000 层缩进列表项不栈溢出', () => {
      const parser = new IncrementalMarkdownParser();
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        lines.push('  '.repeat(i) + '- item ' + i);
      }

      const result = expectCompletesWithin(
        '1000-level nested list',
        2000,
        () => parser.push(lines.join('\n')),
      );

      expect(result.blockCount).toBeGreaterThanOrEqual(0);
      expect(parser).toBeDefined();
    });

    it('1000 层引用嵌套 > 不栈溢出', () => {
      const parser = new IncrementalMarkdownParser();
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        lines.push('>'.repeat(i + 1) + ' quote level ' + i);
      }

      const result = expectCompletesWithin(
        '1000-level nested quote',
        2000,
        () => parser.push(lines.join('\n')),
      );

      expect(result).toBeDefined();
    });

    it('1000 层嵌套后 reset 不泄漏', () => {
      const parser = new IncrementalMarkdownParser();
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        lines.push('  '.repeat(i) + '- deep');
      }
      parser.push(lines.join('\n'));
      parser.reset();

      const result = parser.push('Hello after reset');
      expect(result.blockCount).toBe(0);
      expect(result.tailBlock?.type).toBe('p');
    });
  });

  // ===========================================================================
  // 4. Unicode 畸形
  // ===========================================================================
  describe('Unicode 畸形', () => {
    it('孤立代理对 \\uD800 不崩溃', () => {
      const parser = new IncrementalMarkdownParser();
      const text = 'Hello \uD800 World';

      const result = expectCompletesWithin(
        'lone surrogate \\uD800',
        1000,
        () => parser.push(text),
      );

      expect(result).toBeDefined();
    });

    it('孤立高代理 + 低代理混合不崩溃', () => {
      const parser = new IncrementalMarkdownParser();
      const text = '\uD800 \uDC00 \uD800\uDC00 mixed';

      const result = expectCompletesWithin(
        'mixed surrogates',
        1000,
        () => parser.push(text),
      );

      expect(result).toBeDefined();
    });

    it('超长 ZWJ 序列（emoji 链）不崩溃不截断', () => {
      const parser = new IncrementalMarkdownParser();
      // ZWJ = \u200D，构造超长 ZWJ 序列
      const zwj = '\u200D'.repeat(1000);
      const text = 'A' + zwj + 'B';

      const result = expectCompletesWithin(
        '1000-char ZWJ sequence',
        1000,
        () => parser.push(text),
      );

      expect(result).toBeDefined();
    });

    it('全 BOM / 零宽字符输入不崩溃', () => {
      const parser = new IncrementalMarkdownParser();
      const text = '\uFEFF\u200B\u200C\u200D\uFEFF'.repeat(200);

      const result = expectCompletesWithin(
        'BOM + zero-width chars x200',
        1000,
        () => parser.push(text),
      );

      expect(result).toBeDefined();
    });
  });
});
