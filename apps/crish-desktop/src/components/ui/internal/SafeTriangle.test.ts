// @vitest-environment jsdom
/**
 * ui/internal/SafeTriangle 基础测试：2D 向量叉积、点在三角形内判定与 300ms Grace Timer
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  crossProduct,
  isPointInTriangle,
  getSubmenuSafeTriangle,
  SafeTriangleTracker,
} from './SafeTriangle';

describe('SafeTriangle 向量计算与几何判定', () => {
  const A = { x: 0, y: 50 };
  const B = { x: 100, y: 0 };
  const C = { x: 100, y: 100 };

  it('2D 向量叉积正确计算符号', () => {
    // 逆时针与顺时针叉积符号相反
    const cp1 = crossProduct({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 });
    expect(cp1).toBeGreaterThan(0);

    const cp2 = crossProduct({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 });
    expect(cp2).toBeLessThan(0);
  });

  it('准确判定点是否在安全三角形内部', () => {
    // 三角形中心点 (50, 50) 严格在内部
    expect(isPointInTriangle({ x: 50, y: 50 }, A, B, C)).toBe(true);

    // 顶点和边上的点判定为在内部 (>= 0)
    expect(isPointInTriangle({ x: 0, y: 50 }, A, B, C)).toBe(true);
    expect(isPointInTriangle({ x: 100, y: 0 }, A, B, C)).toBe(true);
    expect(isPointInTriangle({ x: 50, y: 25 }, A, B, C)).toBe(true);

    // 外部点判定为不在内部
    expect(isPointInTriangle({ x: 10, y: 0 }, A, B, C)).toBe(false);
    expect(isPointInTriangle({ x: 150, y: 50 }, A, B, C)).toBe(false);
    expect(isPointInTriangle({ x: -10, y: 50 }, A, B, C)).toBe(false);
  });

  it('根据光标与子菜单位置准确生成安全三角区顶点', () => {
    const cursor = { x: 80, y: 120 };
    const submenuBounds = { left: 200, top: 100, right: 350, bottom: 300 };

    const triangle = getSubmenuSafeTriangle(cursor, submenuBounds);
    expect(triangle[0]).toEqual(cursor);
    expect(triangle[1]).toEqual({ x: 200, y: 100 });
    expect(triangle[2]).toEqual({ x: 200, y: 300 });
  });
});

describe('SafeTriangleTracker 状态机与 Grace Timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('进入三角区启动 300ms 保护，超时后自动重置', () => {
    const tracker = new SafeTriangleTracker(300);
    const cursor = { x: 0, y: 50 };
    const submenuBounds = { left: 100, top: 0, right: 200, bottom: 100 };

    tracker.enter(cursor, submenuBounds);
    expect(tracker.isGraceActive()).toBe(true);

    // 轨迹在三角区内：保持活跃
    expect(tracker.check({ x: 50, y: 50 })).toBe(true);

    // 200ms 后依然有效
    vi.advanceTimersByTime(200);
    expect(tracker.isGraceActive()).toBe(true);

    // 300ms 到期后自动 reset
    vi.advanceTimersByTime(150);
    expect(tracker.isGraceActive()).toBe(false);
  });

  it('鼠标移出三角区立即重置保护', () => {
    const tracker = new SafeTriangleTracker(300);
    const cursor = { x: 0, y: 50 };
    const submenuBounds = { left: 100, top: 0, right: 200, bottom: 100 };

    tracker.enter(cursor, submenuBounds);
    expect(tracker.isGraceActive()).toBe(true);

    // 移动到三角形外部点 (10, 0)
    const inTri = tracker.check({ x: 10, y: 0 });
    expect(inTri).toBe(false);
    expect(tracker.isGraceActive()).toBe(false);
  });

  it('到达子菜单 (reach) 清除计时器并常驻', () => {
    const tracker = new SafeTriangleTracker(300);
    const cursor = { x: 0, y: 50 };
    const submenuBounds = { left: 100, top: 0, right: 200, bottom: 100 };

    tracker.enter(cursor, submenuBounds);
    tracker.reach();
    expect(tracker.isGraceActive()).toBe(false);
  });
});
