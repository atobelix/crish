import { describe, expect, it } from 'vitest';
import {
  bootstrapRatioCi,
  createRng,
  DEFAULT_AB_OPTIONS,
  judgeAb,
  median,
  quantile,
} from './ab-stats';

describe('median / quantile', () => {
  it('median 处理奇偶长度且不修改入参', () => {
    const input = [3, 1, 2];
    expect(median(input)).toBe(2);
    expect(input).toEqual([3, 1, 2]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('空数组抛错而不是返回 NaN 静默通过', () => {
    expect(() => median([])).toThrow(RangeError);
    expect(() => quantile([], 0.5)).toThrow(RangeError);
  });

  it('quantile 线性插值', () => {
    expect(quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
});

describe('bootstrapRatioCi', () => {
  it('同一种子结果完全可复现', () => {
    const base = [2.0, 2.1, 1.9, 2.05, 1.95];
    const head = [2.4, 2.5, 2.35, 2.45, 2.6];
    const a = bootstrapRatioCi(base, head, DEFAULT_AB_OPTIONS);
    const b = bootstrapRatioCi(base, head, DEFAULT_AB_OPTIONS);
    expect(a).toEqual(b);
    expect(a.low).toBeLessThanOrEqual(a.high);
  });

  it('PRNG 输出在 [0,1)', () => {
    const rng = createRng(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('judgeAb', () => {
  const opts = DEFAULT_AB_OPTIONS;

  it('稳定变慢 50% 且超过最小增量 → regression', () => {
    const j = judgeAb(
      {
        name: 'x',
        base: [2.0, 2.02, 1.98, 2.01, 1.99, 2.0],
        head: [3.0, 3.03, 2.97, 3.01, 2.99, 3.0],
      },
      opts
    );
    expect(j.verdict).toBe('regression');
    expect(j.ratio).toBeCloseTo(1.5, 2);
    expect(j.ciLow!).toBeGreaterThan(1);
  });

  it('A/A（同分布）→ neutral', () => {
    const j = judgeAb(
      {
        name: 'x',
        base: [2.0, 2.1, 1.9, 2.05, 1.95],
        head: [2.02, 1.92, 2.08, 1.97, 2.03],
      },
      opts
    );
    expect(j.verdict).toBe('neutral');
  });

  it('点估计超阈值但噪声大到置信区间跨过 1 → suspect（告警，不判退化）', () => {
    const j = judgeAb(
      {
        name: 'x',
        base: [1.0, 4.0, 1.1, 3.9, 1.2],
        head: [4.1, 1.0, 3.8, 1.3, 4.2],
      },
      opts
    );
    expect(j.ratio!).toBeGreaterThan(1 + opts.threshold);
    expect(j.verdict).toBe('suspect');
  });

  it('相对变慢超阈值但绝对增量低于 minDeltaMs → neutral', () => {
    const j = judgeAb(
      { name: 'x', base: [0.2, 0.2, 0.2, 0.2], head: [0.4, 0.4, 0.4, 0.4] },
      opts
    );
    expect(j.ratio).toBe(2);
    expect(j.verdict).toBe('neutral');
  });

  it('稳定变快超阈值 → improvement', () => {
    const j = judgeAb(
      { name: 'x', base: [3, 3.1, 2.9, 3.05], head: [1.5, 1.52, 1.48, 1.51] },
      opts
    );
    expect(j.verdict).toBe('improvement');
  });

  it('base 中不存在 → new；任一侧有效观测不足 → insufficient', () => {
    expect(
      judgeAb({ name: 'x', base: [], head: [1, 1, 1] }, opts).verdict
    ).toBe('new');
    expect(
      judgeAb(
        { name: 'x', base: [1, 1, 1], head: [1, Number.NaN, Number.NaN] },
        opts
      ).verdict
    ).toBe('insufficient');
    expect(
      judgeAb(
        { name: 'x', base: [1, Number.POSITIVE_INFINITY], head: [1, 1, 1] },
        opts
      ).verdict
    ).toBe('insufficient');
  });
});
