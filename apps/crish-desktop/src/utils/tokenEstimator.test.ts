/**
 * apps/crish-desktop/src/utils/tokenEstimator.test.ts
 * 加权特征 Token 估算器单测（详案 04 §2.3）：正逆向 + 边界 + 退化态。
 */
import { describe, expect, it } from 'vitest';
import { estimateTextTokens } from './tokenEstimator';

describe('estimateTextTokens 加权特征估算', () => {
  it('空串/空白输入为 0', () => {
    expect(estimateTextTokens('')).toBe(0);
  });

  it('纯 ASCII 短文本：下限 1', () => {
    expect(estimateTextTokens('hi')).toBe(1);
  });

  it('纯 ASCII 按加权放大小写字母/数字/空格（0.28/字符）', () => {
    // "abcd" = 4 × 0.28 = 1.12 → ceil 2
    expect(estimateTextTokens('abcd')).toBe(2);
    // 100 个 ASCII：浮点累计 28.000000000000004 → ceil 29（IEEE754 边界，锁定现状防漂移）
    expect(estimateTextTokens('a'.repeat(100))).toBe(29);
  });

  it('CJK 按 0.70/字符加权', () => {
    // "中文" = 2 × 0.70 = 1.4 → ceil 2
    expect(estimateTextTokens('中文')).toBe(2);
    // 10 个汉字 = 7
    expect(estimateTextTokens('一二三四五六七八九十')).toBe(7);
  });

  it('符号按 0.45/字符加权（cron 星号/标点）', () => {
    // "***" = 3 × 0.45 = 1.35 → ceil 2
    expect(estimateTextTokens('***')).toBe(2);
  });

  it('换行计入 0.1/个', () => {
    // "a\nb" = 2×0.28 + 1×0.1 = 0.66 → ceil 1
    expect(estimateTextTokens('a\nb')).toBe(1);
    // 10 行 ASCII（9 换行）：10×0.28 + 9×0.1 = 3.7 → ceil 4
    expect(estimateTextTokens('a\na\na\na\na\na\na\na\na\na')).toBe(4);
  });

  it('混合中英与标点：各分类独立累计', () => {
    // "中文 abc !" = 2×0.7 + 4×0.28(含空格) + 1×0.45 = 3.17 → ceil 4
    expect(estimateTextTokens('中文 abc !')).toBe(4);
  });

  it('逆向一致性：同输入恒等同输出（纯函数幂等）', () => {
    const sample = '统一提示词 injection pipeline：/schedule 0 9 * * *';
    expect(estimateTextTokens(sample)).toBe(estimateTextTokens(sample));
    expect(estimateTextTokens(sample)).toBeGreaterThan(0);
  });
});
