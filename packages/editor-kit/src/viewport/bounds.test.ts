/**
 * A-PERF 结构门：DOM 上界 / overscan 默认值（**W6-C-S** / W3-A 结构）
 * 引用：perf-baseline.md · A-PERF-01 · A-MEM-01
 *
 * **≠ W6-C** 数值门；**≠ EL-03**。文档断言见 `perf-baseline.contract.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_HOT_YTEXT,
  DEFAULT_OVERSCAN_BLOCKS,
  isWithinDomMountBound,
  MAX_MOUNTED_DOM_BLOCKS,
  OVERSCAN_BLOCKS_MAX,
  OVERSCAN_BLOCKS_MIN,
} from './bounds';
import { queryViewport } from './ViewportQuery';

describe('A-PERF structure bounds (W6-C-S)', () => {
  it('DEFAULT_OVERSCAN_BLOCKS 落在 D5 建议区间 8～20', () => {
    expect(DEFAULT_OVERSCAN_BLOCKS).toBe(12);
    expect(DEFAULT_OVERSCAN_BLOCKS).toBeGreaterThanOrEqual(OVERSCAN_BLOCKS_MIN);
    expect(DEFAULT_OVERSCAN_BLOCKS).toBeLessThanOrEqual(OVERSCAN_BLOCKS_MAX);
  });

  it('MAX_MOUNTED_DOM_BLOCKS 为结构门硬上界且 ≤ 热集默认 512', () => {
    expect(MAX_MOUNTED_DOM_BLOCKS).toBe(256);
    expect(DEFAULT_MAX_HOT_YTEXT).toBe(512);
    expect(MAX_MOUNTED_DOM_BLOCKS).toBeLessThanOrEqual(DEFAULT_MAX_HOT_YTEXT);
    // 至少能容纳「可见 + 双侧 overscan」的典型窗口
    expect(MAX_MOUNTED_DOM_BLOCKS).toBeGreaterThan(DEFAULT_OVERSCAN_BLOCKS * 2);
  });

  it('典型视口 + 默认 overscan 的挂载数 ≤ MAX_MOUNTED_DOM_BLOCKS（A-PERF-01）', () => {
    // 模拟约 40 块可见 + 默认 overscan，十万块文档
    const r = queryViewport({
      totalCount: 100_000,
      window: { startIndex: 500, endIndex: 540 },
      overscan: DEFAULT_OVERSCAN_BLOCKS,
    });
    expect(r.count).toBe(40 + DEFAULT_OVERSCAN_BLOCKS * 2);
    expect(isWithinDomMountBound(r.count)).toBe(true);
    expect(r.count).toBeLessThanOrEqual(MAX_MOUNTED_DOM_BLOCKS);
  });

  it('isWithinDomMountBound 边界', () => {
    expect(isWithinDomMountBound(0)).toBe(true);
    expect(isWithinDomMountBound(MAX_MOUNTED_DOM_BLOCKS)).toBe(true);
    expect(isWithinDomMountBound(MAX_MOUNTED_DOM_BLOCKS + 1)).toBe(false);
    expect(isWithinDomMountBound(-1)).toBe(false);
  });
});
