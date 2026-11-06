/**
 * apps/crish-mobile/src/presentation/ui/cornerPath.test.ts
 *
 * G² 生成层移动端同构转写的数值测试：共享向量与桌面
 * apps/crish-desktop/src/utils/cornerPath.test.ts 逐项同值——
 * κ_peak 系数 1.337106、R=20 对角点 4.981124、采样偏差 < 0.02px、
 * 角占位恰为 R。两端任一实现漂移都会在自己一侧变红（同构转写的互校验）。
 */
import {
  CORNER_EXPONENT,
  CORNER_KAPPA_PEAK_FACTOR,
  concentricRadius,
  cornerSvgPath,
  kappaPeak,
  superellipseCornerPoints,
} from './cornerPath';

const N = CORNER_EXPONENT;

function distToSegment(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return Math.hypot(dx, dy);
}

describe('cornerPath（移动端同构转写）数值性质', () => {
  it('κ 共享向量：系数 ≈1.337106，kappaPeak(20) ≈0.0668553（≈1/14.9577）', () => {
    expect(CORNER_KAPPA_PEAK_FACTOR).toBeCloseTo(1.337106, 4);
    expect(kappaPeak(20)).toBeCloseTo(0.0668553, 5);
    expect(1 / kappaPeak(20)).toBeCloseTo(14.9577, 3);
    expect(kappaPeak(0)).toBe(0);
  });

  it('典范角：端点精确、隐式方程成立、对角点 = 共享向量', () => {
    for (const R of [20, 12]) {
      const pts = superellipseCornerPoints(R);
      expect(pts[0]).toEqual([R, 0]);
      expect(pts[pts.length - 1]).toEqual([0, R]);
      for (const [x, y] of pts) {
        const lhs = Math.pow(R - x, N) + Math.pow(R - y, N);
        expect(Math.abs(lhs - Math.pow(R, N)) / Math.pow(R, N)).toBeLessThan(1e-9);
      }
      const diagExpected = R === 20 ? 4.981124 : 2.988674;
      let cross: number | null = null;
      for (let k = 0; k + 1 < pts.length; k++) {
        const p0 = pts[k];
        const p1 = pts[k + 1];
        if (!p0 || !p1) continue;
        const d0 = p0[0] - p0[1];
        const d1 = p1[0] - p1[1];
        if (d0 === 0) { cross = p0[0]; break; }
        if (d0 * d1 < 0) {
          const t = d0 / (d0 - d1);
          cross = p0[0] + t * (p1[0] - p0[0]);
          break;
        }
      }
      expect(cross).not.toBeNull();
      expect(Math.abs(cross! - diagExpected)).toBeLessThan(0.02);
    }
    // 等角采样中点 = 对角点本身（与桌面同向量）
    const pts20 = superellipseCornerPoints(20);
    const mid = pts20[Math.floor(pts20.length / 2)];
    if (!mid) throw new Error('cornerPath.test: 采样点列为空');
    expect(mid[0]).toBeCloseTo(4.981124, 3);
    expect(mid[1]).toBeCloseTo(4.981124, 3);
  });

  it('采样偏差 < 0.02px（R = 6..36 密采样实测）', () => {
    for (const R of [6, 10, 12, 16, 18, 20, 24, 28, 36]) {
      const poly = superellipseCornerPoints(R);
      let maxDev = 0;
      const DENSE = 2000;
      for (let i = 0; i <= DENSE; i++) {
        const u = i / DENSE;
        const curvePts: Array<readonly [number, number]> = [
          [R * (1 - u), R * (1 - Math.pow(1 - Math.pow(u, N), 1 / N))],
          [R * (1 - Math.pow(1 - Math.pow(u, N), 1 / N)), R * (1 - u)],
        ];
        for (const p of curvePts) {
          let best = Infinity;
          for (let k = 0; k + 1 < poly.length; k++) {
            const a = poly[k];
            const b = poly[k + 1];
            if (!a || !b) continue;
            const d = distToSegment(p, a, b);
            if (d < best) best = d;
          }
          if (best > maxDev) maxDev = best;
        }
      }
      expect(maxDev).toBeLessThan(0.02);
    }
  });

  it('整径路径：入口/逐角开关/同心收口/钳制与退化（与桌面同口径）', () => {
    expect(cornerSvgPath(100, 60, 20).startsWith('M20 0H80')).toBe(true);
    expect(cornerSvgPath(100, 60, 10).startsWith('M10 0H90')).toBe(true);
    expect(cornerSvgPath(100, 60, 10)).not.toBe(cornerSvgPath(100, 60, 20));
    const partial = cornerSvgPath(100, 60, { tl: 0, tr: 20, br: 0, bl: 20 });
    expect(partial.startsWith('M0 0H80')).toBe(true);
    expect(concentricRadius(20, 10)).toBe(10);
    expect(concentricRadius(6, 10)).toBe(0);
    expect(cornerSvgPath(84, 44, concentricRadius(20, 8)).startsWith('M12 0')).toBe(true);
    expect(cornerSvgPath(30, 20, 20).startsWith('M10 0')).toBe(true);
    expect(cornerSvgPath(0, 10, 5)).toBe('');
    expect(cornerSvgPath(10, 10, 0)).toBe('M0 0H10V10H0Z');
  });
});
