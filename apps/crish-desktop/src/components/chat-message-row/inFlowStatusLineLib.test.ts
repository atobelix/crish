/**
 * 批 B ⑲ 钉住：等待期的真实前置原因文案 = 引擎重试信息（InFlowStatusLine）。
 * 文案只来自引擎下发的 attempt / maxAttempts：有上限显示 n/m，
 * 无上限只显示「第 n 次」，绝不臆造分母。
 */
import { describe, expect, it } from 'vitest';
import { formatRetryStatusText } from './inFlowStatusLineLib';
import type { RuntimeRetryInfo } from '../../store';

const retry = (attempt: number, maxAttempts?: number): RuntimeRetryInfo =>
  ({ attempt, maxAttempts }) as unknown as RuntimeRetryInfo;

describe('formatRetryStatusText（批 B ⑲）', () => {
  it('有上限：正在重试 n/m', () => {
    expect(formatRetryStatusText(retry(2, 3))).toBe('正在重试 2/3');
  });

  it('无上限：正在重试 · 第 n 次（不臆造分母）', () => {
    expect(formatRetryStatusText(retry(2))).toBe('正在重试 · 第 2 次');
    expect(formatRetryStatusText(retry(2, 0))).toBe('正在重试 · 第 2 次');
  });

  it('attempt 下限钳制为 1、小数向下取整', () => {
    expect(formatRetryStatusText(retry(0))).toBe('正在重试 · 第 1 次');
    expect(formatRetryStatusText(retry(2.7, 5))).toBe('正在重试 2/5');
  });
});
