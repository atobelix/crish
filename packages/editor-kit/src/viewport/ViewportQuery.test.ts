/**
 * ViewportQuery 窗口边界单测
 */
import { describe, expect, it } from 'vitest';
import { queryViewport, queryViewportByScroll } from './ViewportQuery';

describe('queryViewport', () => {
  it('空文档返回空窗口', () => {
    const r = queryViewport({
      totalCount: 0,
      window: { startIndex: 0, endIndex: 10 },
      overscan: 5,
    });
    expect(r).toEqual({
      startIndex: 0,
      endIndex: 0,
      indices: [],
      count: 0,
      totalCount: 0,
    });
  });

  it('无 overscan 时保留 [start, end)', () => {
    const r = queryViewport({
      totalCount: 100,
      window: { startIndex: 10, endIndex: 20 },
    });
    expect(r.startIndex).toBe(10);
    expect(r.endIndex).toBe(20);
    expect(r.count).toBe(10);
    expect(r.indices[0]).toBe(10);
    expect(r.indices[r.indices.length - 1]).toBe(19);
  });

  it('overscan 前后扩展并 clamp 到上界', () => {
    const r = queryViewport({
      totalCount: 50,
      window: { startIndex: 0, endIndex: 5 },
      overscan: 8,
    });
    // start 不能小于 0
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(13); // 5+8
    expect(r.count).toBe(13);
  });

  it('overscan 在尾部 clamp', () => {
    const r = queryViewport({
      totalCount: 30,
      window: { startIndex: 25, endIndex: 30 },
      overscan: 10,
    });
    expect(r.startIndex).toBe(15); // 25-10
    expect(r.endIndex).toBe(30);
    expect(r.indices).toHaveLength(15);
  });

  it('越界窗口 clamp 到 [0, totalCount)', () => {
    const r = queryViewport({
      totalCount: 10,
      window: { startIndex: -5, endIndex: 100 },
      overscan: 2,
    });
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(10);
    expect(r.count).toBe(10);
  });

  it('start > end 时收敛为空区间起点', () => {
    const r = queryViewport({
      totalCount: 20,
      window: { startIndex: 15, endIndex: 10 },
    });
    // rawStart=15 clamp 后 end=max(start,rawEnd)=15 → 空
    expect(r.startIndex).toBe(15);
    expect(r.endIndex).toBe(15);
    expect(r.count).toBe(0);
  });
});

describe('queryViewportByScroll', () => {
  it('经 indexAt 换算窗口后再 overscan', () => {
    // 模拟固定 10px/块
    const indexAt = (offset: number) =>
      Math.min(99, Math.max(0, Math.floor(offset / 10)));
    const r = queryViewportByScroll({
      totalCount: 100,
      scrollTop: 100, // 块 10
      viewportHeight: 50, // 到 offset 150 → 块 15，end=16
      overscan: 2,
      indexAt,
    });
    expect(r.startIndex).toBe(8); // 10-2
    expect(r.endIndex).toBe(18); // 16+2
  });
});
