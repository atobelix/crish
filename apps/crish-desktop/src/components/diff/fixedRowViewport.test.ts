/**
 * 固定行高视口单元测试（Mode-FIXED，误差 0）。
 */
import { describe, expect, it } from 'vitest';
import {
  computeFixedRowViewport,
  DIFF_FIXED_ROW_HEIGHT,
} from './fixedRowViewport';

describe('computeFixedRowViewport', () => {
  it('总高 = itemCount × rowHeight，与 scrollTop 无关（几何冻结）', () => {
    const a = computeFixedRowViewport(0, 400, 1000, DIFF_FIXED_ROW_HEIGHT, 10);
    const b = computeFixedRowViewport(12345.6, 400, 1000, DIFF_FIXED_ROW_HEIGHT, 10);
    expect(a.totalHeight).toBe(1000 * 22);
    expect(b.totalHeight).toBe(1000 * 22);
  });

  it('空列表返回零区间', () => {
    expect(computeFixedRowViewport(0, 400, 0, 22, 5)).toEqual({
      startIndex: 0,
      endIndex: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
  });

  it('offsetTop ≡ startIndex × rowHeight', () => {
    const v = computeFixedRowViewport(220, 100, 50, 22, 0);
    expect(v.startIndex).toBe(10);
    expect(v.offsetTop).toBe(10 * 22);
  });

  it('overscan 扩展窗口且不越界', () => {
    const v = computeFixedRowViewport(0, 100, 5, 22, 3);
    expect(v.startIndex).toBe(0);
    expect(v.endIndex).toBe(5);
  });
});
