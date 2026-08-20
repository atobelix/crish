/**
 * apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts
 *
 * 级联子菜单 Safe Triangle 向量三角区几何检测与 Grace Timer 状态机（RED-DETAILED-04 / Plan 04 §1.5）
 *
 * 算法原理：
 * 当鼠标指针从父级菜单项向右/左侧级联子菜单移动时，构建由「当前光标位置 P」与「子菜单包围盒两顶点 Vtop, Vbottom」
 * 构成的 Safe Triangle 闭合三角区。
 * 使用 2D 向量叉积（Cross Product）O(1) 复杂度判定后续鼠标轨迹点 M 是否在三角区内部。
 * 若在三角区内，启动 300ms Grace Timer 并挂起相邻菜单项的 hover 切换，彻底消除二级子菜单滑向过程中的误闪退。
 */

export interface Point2D {
  x: number;
  y: number;
}

export interface RectBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width?: number;
  height?: number;
}

/**
 * 2D 向量叉积（Cross Product / Signed Area）
 * 计算 (p2 - p1) × (p3 - p1) 的符号面积
 */
export function crossProduct(p1: Point2D, p2: Point2D, p3: Point2D): number {
  return (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
}

/**
 * 判断点 M 是否在由 A, B, C 三点构成的三角形内部
 * 当且仅当 M 相对三条边的叉积同号（全部 >= 0 或全部 <= 0）时，点 M 严格在三角形内部
 */
export function isPointInTriangle(
  m: Point2D,
  a: Point2D,
  b: Point2D,
  c: Point2D
): boolean {
  const cp1 = crossProduct(a, b, m);
  const cp2 = crossProduct(b, c, m);
  const cp3 = crossProduct(c, a, m);

  const hasNeg = cp1 < 0 || cp2 < 0 || cp3 < 0;
  const hasPos = cp1 > 0 || cp2 > 0 || cp3 > 0;

  return !(hasNeg && hasPos);
}

/**
 * 根据当前光标位置与子菜单矩形包围盒，生成安全三角形的三个顶点
 * 支持四向方位 (left / right / top / bottom) 扩展与光标插值
 */
export function getSubmenuSafeTriangle(
  cursor: Point2D,
  submenuBounds: RectBounds,
  placement?: 'left' | 'right' | 'top' | 'bottom'
): [Point2D, Point2D, Point2D] {
  // 显式方位优先判定
  if (placement === 'bottom') {
    return [
      cursor,
      { x: submenuBounds.left, y: submenuBounds.top },
      { x: submenuBounds.right, y: submenuBounds.top },
    ];
  }
  if (placement === 'top') {
    return [
      cursor,
      { x: submenuBounds.left, y: submenuBounds.bottom },
      { x: submenuBounds.right, y: submenuBounds.bottom },
    ];
  }
  if (placement === 'left') {
    return [
      cursor,
      { x: submenuBounds.right, y: submenuBounds.top },
      { x: submenuBounds.right, y: submenuBounds.bottom },
    ];
  }
  if (placement === 'right') {
    return [
      cursor,
      { x: submenuBounds.left, y: submenuBounds.top },
      { x: submenuBounds.left, y: submenuBounds.bottom },
    ];
  }

  // 缺省方位时的启发式几何推断
  if (cursor.y < submenuBounds.top) {
    return [
      cursor,
      { x: submenuBounds.left, y: submenuBounds.top },
      { x: submenuBounds.right, y: submenuBounds.top },
    ];
  }
  if (cursor.y > submenuBounds.bottom) {
    return [
      cursor,
      { x: submenuBounds.left, y: submenuBounds.bottom },
      { x: submenuBounds.right, y: submenuBounds.bottom },
    ];
  }
  if (cursor.x > submenuBounds.right) {
    return [
      cursor,
      { x: submenuBounds.right, y: submenuBounds.top },
      { x: submenuBounds.right, y: submenuBounds.bottom },
    ];
  }
  // 默认：右侧子菜单
  return [
    cursor,
    { x: submenuBounds.left, y: submenuBounds.top },
    { x: submenuBounds.left, y: submenuBounds.bottom },
  ];
}

import { SafeAimEngine } from './SafeAimEngine';

export { SafeAimEngine } from './SafeAimEngine';

/**
 * SafeTriangle 状态机控制器，管理 300ms Grace Timer 与相邻项 hover 锁
 */
export class SafeTriangleTracker {
  private triangle: [Point2D, Point2D, Point2D] | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private isSuspended = false;
  private readonly graceDurationMs: number;

  constructor(graceDurationMs = 300) {
    this.graceDurationMs = graceDurationMs;
  }

  /**
   * 当光标从父菜单项离开并开始指向子菜单时，初始化安全三角区
   */
  public enter(
    cursor: Point2D,
    submenuBounds: RectBounds,
    placement?: 'left' | 'right' | 'top' | 'bottom'
  ): void {
    this.triangle = getSubmenuSafeTriangle(cursor, submenuBounds, placement);
    this.isSuspended = true;

    // 同步 SVG 虚拟多边形 (Zero-Canvas Safe-Aim Overlay)
    try {
      const svg = document.getElementById('sepSafeAimOverlay');
      const poly = svg?.querySelector('polygon');
      if (poly && this.triangle) {
        const [p1, p2, p3] = this.triangle;
        poly.setAttribute('points', `${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`);
      }
    } catch {
      // quiet fail if not in DOM environment
    }

    this.clearTimer();
    this.graceTimer = setTimeout(() => {
      this.reset();
    }, this.graceDurationMs);
  }

  /**
   * 检查新鼠标位置是否仍在安全三角区内部
   */
  public check(pointer: Point2D): boolean {
    if (!this.triangle || !this.isSuspended) return false;
    const inTriangle = isPointInTriangle(
      pointer,
      this.triangle[0],
      this.triangle[1],
      this.triangle[2]
    );
    if (!inTriangle) {
      this.reset();
      return false;
    }
    return true;
  }

  /**
   * 鼠标已成功进入子菜单包围盒，常驻展开并清除计时器
   */
  public reach(): void {
    this.clearTimer();
    this.isSuspended = false;
    this.triangle = null;
    this.clearSvgPolygon();
  }

  /**
   * 重置安全三角区
   */
  public reset(): void {
    this.clearTimer();
    this.isSuspended = false;
    this.triangle = null;
    this.clearSvgPolygon();
  }

  private clearSvgPolygon(): void {
    try {
      const poly = document.getElementById('sepSafeAimOverlay')?.querySelector('polygon');
      if (poly) poly.removeAttribute('points');
    } catch {
      // quiet fail
    }
  }

  /**
   * 是否当前处于挂起相邻项状态
   */
  public isGraceActive(): boolean {
    return this.isSuspended;
  }

  private clearTimer(): void {
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }
}
