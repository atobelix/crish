/**
 * apps/crish-desktop/src/utils/cornerPath.test.ts
 *
 * G² 生成层数值测试（立项方案 §2.4 第二层）：
 * - 采样偏差 < 0.02px（折线 vs 解析超椭圆轮廓，密采样实测）；
 * - κ_peak = 1.337/R（共享向量：R=20 时 0.0668553 ≈ 1/14.9577）；
 * - 角占位包围盒恰为 R×R、对角点共享向量（R=20 → 4.981124，R=12 → 2.988674）；
 * - 逐角开关、双轮廓、concentricRadius 收口、钳制与退化输入。
 * 本文件的共享向量与移动端同构转写（crish-mobile cornerPath.test.ts）逐项同值，
 * 两端任一实现漂移都会在自己一侧变红。
 */
import { describe, expect, it } from 'vitest';
import {
  CORNER_EXPONENT,
  CORNER_KAPPA_PEAK_FACTOR,
  concentricRadius,
  cornerClipPath,
  cornerPath,
  cornerSvgDataUri,
  kappaPeak,
  superellipseCornerPoints,
} from './cornerPath';

const N = CORNER_EXPONENT;

/** path 字符串 → 点列（仅支持本生成器产出的 M/H/V/L/Z 形态） */
function parsePath(d: string): Array<readonly [number, number]> {
  const pts: Array<readonly [number, number]> = [];
  let x = 0;
  let y = 0;
  const re = /([MHVLZ])([\d.]*)?(?:\s([\d.]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const [, cmd, a, b] = m;
    if (cmd === 'M' || cmd === 'L') {
      x = parseFloat(a);
      y = parseFloat(b);
      pts.push([x, y] as const);
    } else if (cmd === 'H') {
      x = parseFloat(a);
      pts.push([x, y] as const);
    } else if (cmd === 'V') {
      y = parseFloat(a);
      pts.push([x, y] as const);
    }
  }
  return pts;
}

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

describe('cornerPath 数值性质', () => {
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
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(R);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(R);
      }
      // 对角点（x=y 处）：R(1 − 2^(−1/n))，Python 独立计算的共享向量；
      // 采样点不恰落在对角线上，以相邻采样点线性插值求交点后比对
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
    // 等角采样的中点恰为对角点本身（θ=π/4）：R=20 时两坐标同为 4.981124
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
      const DENSE = 4000;
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
      expect(maxDev, `R=${R} 偏差 ${maxDev}`).toBeLessThan(0.02);
    }
  });

  it('整径四角均满足各自角域的隐式方程，角占位恰为 R×R', () => {
    const w = 100;
    const h = 60;
    const R = 20;
    const pts = parsePath(cornerPath(w, h, R));
    const rn = Math.pow(R, N);
    const rel = (v: number) => Math.abs(v - rn) / rn;
    let checked = 0;
    for (const [x, y] of pts) {
      if (x < w - R && y < R && x > 0) {
        // TL 角域内部点
        if (y > 0) { expect(rel(Math.pow(R - x, N) + Math.pow(R - y, N))).toBeLessThan(0.01); checked++; }
      } else if (x > w - R && y < R) {
        expect(rel(Math.pow(x - (w - R), N) + Math.pow(R - y, N))).toBeLessThan(0.01); checked++;
      } else if (x > w - R && y > h - R) {
        expect(rel(Math.pow(x - (w - R), N) + Math.pow(y - (h - R), N))).toBeLessThan(0.01); checked++;
      } else if (x < R && y > h - R) {
        expect(rel(Math.pow(R - x, N) + Math.pow(y - (h - R), N))).toBeLessThan(0.01); checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    // 角占位：TL 角采样点包围盒恰为 [0,R]×[0,R]
    const tl = pts.filter(([x, y]) => x <= R && y <= R);
    expect(Math.max(...tl.map((p) => p[0]))).toBeCloseTo(R, 3);
    expect(Math.max(...tl.map((p) => p[1]))).toBeCloseTo(R, 3);
  });

  it('入口/双轮廓/逐角开关', () => {
    expect(cornerPath(100, 60, 20).startsWith('M20 0H80')).toBe(true);
    expect(cornerPath(100, 60, 10)).not.toBe(cornerPath(100, 60, 20));
    expect(cornerPath(100, 60, 10).startsWith('M10 0H90')).toBe(true);
    const partial = cornerPath(100, 60, { tl: 0, tr: 20, br: 0, bl: 20 });
    expect(partial.startsWith('M0 0H80')).toBe(true);
    const pts = parsePath(partial);
    // TL 直角：左上区域内无曲线采样点（只有边线点）
    const tlInterior = pts.filter(([x, y]) => x < 20 && y < 20 && x > 0 && y > 0);
    expect(tlInterior.length).toBe(0);
  });

  it('同心收口与钳制/退化', () => {
    expect(concentricRadius(20, 10)).toBe(10);
    expect(concentricRadius(6, 10)).toBe(0);
    expect(cornerPath(84, 44, concentricRadius(20, 8)).startsWith('M12 0')).toBe(true);
    // 半径钳制到 min(w,h)/2
    expect(cornerPath(30, 20, 20).startsWith('M10 0')).toBe(true);
    expect(cornerPath(0, 10, 5)).toBe('');
    expect(cornerPath(10, 10, 0)).toBe('M0 0H10V10H0Z');
  });

  it('承载形态：SVG data URI 与 clip-path 同源同路径', () => {
    const d = cornerPath(120, 48, 12);
    const uri = cornerSvgDataUri(120, 48, 12, '#fff');
    expect(uri.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    const decoded = decodeURIComponent(uri);
    expect(decoded).toContain('preserveAspectRatio="none"');
    expect(decoded).toContain(`d="${d}"`);
    expect(cornerClipPath(120, 48, 12)).toBe(`path('${d}')`);
  });
});
