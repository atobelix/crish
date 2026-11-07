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
  CONCENTRIC_EXPONENT,
  CORNER_EXPONENT,
  CORNER_KAPPA_PEAK_FACTOR,
  concentricRadius,
  cornerClipPath,
  cornerExponentForScheme,
  cornerPath,
  cornerSvgDataUri,
  deviceSnappedStrokeWidth,
  getCornerScheme,
  kappaPeak,
  setCornerScheme,
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

  it('描边宽设备像素对齐：与被替代 CSS 边框的实际绘制宽度一致', () => {
    // DPR 1：恒等（既有描边产物断言的口径不变）
    expect(deviceSnappedStrokeWidth(1, 1)).toBe(1);
    expect(deviceSnappedStrokeWidth(2, 1)).toBe(2);
    // DPR 1.25：1px → 0.8 CSS px（恰 1 设备 px，活测 used 值实证）
    expect(deviceSnappedStrokeWidth(1, 1.25)).toBeCloseTo(0.8, 10);
    expect(deviceSnappedStrokeWidth(2, 1.25)).toBeCloseTo(2.4, 10);
    // DPR 1.5：1px → 2 设备 px = 4/3 CSS px；DPR 2：1px → 2 设备 px = 1 CSS px
    expect(deviceSnappedStrokeWidth(1, 1.5)).toBeCloseTo(4 / 3, 10);
    expect(deviceSnappedStrokeWidth(1, 2)).toBe(1);
    // 退化输入：dpr 非法回落名义值，宽度 ≤0 归零
    expect(deviceSnappedStrokeWidth(1, 0)).toBe(1);
    expect(deviceSnappedStrokeWidth(1, NaN)).toBe(1);
    expect(deviceSnappedStrokeWidth(0, 1.25)).toBe(0);
    expect(deviceSnappedStrokeWidth(-1, 1.25)).toBe(0);
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

describe('双方案体系（g2 主方案 / concentric 同心圆弧后退方案）', () => {
  /** 路径骨架：抹去角采样点（L 段）后剩 M/H/V/Z 锚点 = 布局占位与直边 */
  const skeleton = (d: string): string => d.replace(/L[\d.]+ [\d.]+/g, 'L');

  it('方案 → 指数映射与 κ：圆弧方案曲率恒定 1/R', () => {
    expect(cornerExponentForScheme('g2')).toBe(CORNER_EXPONENT);
    expect(cornerExponentForScheme('concentric')).toBe(CONCENTRIC_EXPONENT);
    expect(CONCENTRIC_EXPONENT).toBe(2);
    // κ 公式在 n = 2 时系数恰为 1：圆弧全程曲率恒定 = 1/R（非峰值概念）
    expect(kappaPeak(20, undefined, 'concentric')).toBeCloseTo(0.05, 10);
    expect(kappaPeak(20, 2)).toBeCloseTo(0.05, 10);
    expect(kappaPeak(12, undefined, 'concentric')).toBeCloseTo(1 / 12, 10);
  });

  it('同心典范角：采样点恰在真圆上、端点精确、对角点 = 共享向量', () => {
    for (const R of [20, 12]) {
      const pts = superellipseCornerPoints(R, undefined, 'concentric');
      expect(pts[0]).toEqual([R, 0]);
      expect(pts[pts.length - 1]).toEqual([0, R]);
      for (const [x, y] of pts) {
        // 圆心 (R, R)、半径 R 的圆方程（相对误差与 G² 分支同口径 1e-9）
        const lhs = Math.pow(R - x, 2) + Math.pow(R - y, 2);
        expect(Math.abs(lhs - R * R) / (R * R)).toBeLessThan(1e-9);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(R);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(R);
      }
      // 对角点共享向量：R(1 − 2^(−1/2))，R=20 → 5.857864，R=12 → 3.514719
      // （与移动端同构转写共用本向量）；等角采样中点恰为对角点本身（θ=π/4）
      const diagExpected = R === 20 ? 5.857864 : 3.514719;
      const mid = pts[Math.floor(pts.length / 2)];
      if (!mid) throw new Error('cornerPath.test: 采样点列为空');
      expect(mid[0]).toBeCloseTo(diagExpected, 3);
      expect(mid[1]).toBeCloseTo(diagExpected, 3);
    }
  });

  it('同心典范角：端点切线与直边衔接（首弦近水平、末弦近竖直）', () => {
    const pts = superellipseCornerPoints(20, undefined, 'concentric');
    const p0 = pts[0];
    const p1 = pts[1];
    const q0 = pts[pts.length - 2];
    const q1 = pts[pts.length - 1];
    if (!p0 || !p1 || !q0 || !q1) {
      throw new Error('cornerPath.test: 采样点列为空');
    }
    // (R, 0) 端圆切线为水平线：首弦斜率 ≈ 0.026（Δθ = 3° 的弦近似）
    expect(Math.abs((p1[1] - p0[1]) / (p1[0] - p0[0]))).toBeLessThan(0.05);
    // (0, R) 端圆切线为竖直线：末弦横偏/纵程同量级
    expect(Math.abs((q1[0] - q0[0]) / (q1[1] - q0[1]))).toBeLessThan(0.05);
  });

  it('同心采样偏差 < 0.02px（与 G² 分支同一预算；R = 6..36）', () => {
    for (const R of [6, 10, 12, 16, 18, 20, 24, 28, 36]) {
      const poly = superellipseCornerPoints(R, undefined, 'concentric');
      let maxDev = 0;
      const DENSE = 2000;
      for (let i = 0; i <= DENSE; i++) {
        const phi = (Math.PI / 2) * (i / DENSE);
        const p = [R - R * Math.cos(phi), R - R * Math.sin(phi)] as const;
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
      expect(maxDev, `R=${R} 偏差 ${maxDev}`).toBeLessThan(0.02);
    }
  });

  it('整径：同心四角满足圆方程、角占位恰为 R×R、骨架锚点与 G² 逐字一致', () => {
    const w = 100;
    const h = 60;
    const R = 20;
    const dArc = cornerPath(w, h, R, undefined, 'concentric');
    const dG2 = cornerPath(w, h, R, undefined, 'g2');
    expect(dArc).not.toBe(dG2);
    expect(dArc.startsWith('M20 0H80')).toBe(true);
    const pts = parsePath(dArc);
    const r2 = R * R;
    const rel = (v: number) => Math.abs(v - r2) / r2;
    let checked = 0;
    for (const [x, y] of pts) {
      if (x < w - R && y < R && x > 0) {
        if (y > 0) { expect(rel(Math.pow(R - x, 2) + Math.pow(R - y, 2))).toBeLessThan(0.01); checked++; }
      } else if (x > w - R && y < R) {
        expect(rel(Math.pow(x - (w - R), 2) + Math.pow(R - y, 2))).toBeLessThan(0.01); checked++;
      } else if (x > w - R && y > h - R) {
        expect(rel(Math.pow(x - (w - R), 2) + Math.pow(y - (h - R), 2))).toBeLessThan(0.01); checked++;
      } else if (x < R && y > h - R) {
        expect(rel(Math.pow(R - x, 2) + Math.pow(y - (h - R), 2))).toBeLessThan(0.01); checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    // 角占位：TL 角采样点包围盒恰为 [0,R]×[0,R]（与 G² 方案同一占位）
    const tl = pts.filter(([x, y]) => x <= R && y <= R);
    expect(Math.max(...tl.map((p) => p[0]))).toBeCloseTo(R, 3);
    expect(Math.max(...tl.map((p) => p[1]))).toBeCloseTo(R, 3);
    // 骨架（布局占位 + 直边）两方案逐字一致——差异只许出现在角采样点
    expect(skeleton(dArc)).toBe(skeleton(dG2));
  });

  it('同心链逐值一致：concentricRadius 内缩链在两方案下骨架相同', () => {
    for (const [R, pad] of [
      [20, 10],
      [20, 8],
      [18, 6],
      [16, 4],
      [12, 12],
    ] as const) {
      const inner = concentricRadius(R, pad);
      const arc = cornerPath(100, 60, inner, undefined, 'concentric');
      const g2 = cornerPath(100, 60, inner, undefined, 'g2');
      expect(arc.startsWith(`M${inner} 0`)).toBe(true);
      expect(g2.startsWith(`M${inner} 0`)).toBe(true);
      expect(skeleton(arc)).toBe(skeleton(g2));
    }
  });

  it('方案选择点：默认 g2（既有产物逐字不变），注入 concentric 后无方案调用跟随', () => {
    expect(getCornerScheme()).toBe('g2');
    expect(cornerPath(100, 60, 20)).toBe(
      cornerPath(100, 60, 20, undefined, 'g2')
    );
    setCornerScheme('concentric');
    try {
      expect(getCornerScheme()).toBe('concentric');
      expect(cornerPath(100, 60, 20)).toBe(
        cornerPath(100, 60, 20, undefined, 'concentric')
      );
      expect(cornerPath(100, 60, 20)).not.toBe(
        cornerPath(100, 60, 20, undefined, 'g2')
      );
      expect(cornerClipPath(120, 48, 12)).toBe(
        cornerClipPath(120, 48, 12, undefined, 'concentric')
      );
      const uri = cornerSvgDataUri(120, 48, 12, '#fff');
      expect(decodeURIComponent(uri)).toContain(
        cornerPath(120, 48, 12, undefined, 'concentric')
      );
    } finally {
      setCornerScheme('g2');
    }
    expect(cornerPath(100, 60, 20)).toBe(
      cornerPath(100, 60, 20, undefined, 'g2')
    );
  });

  it('显式 n 优先于 scheme（底层逃生口，既有调用口径不变）', () => {
    expect(cornerPath(100, 60, 20, CORNER_EXPONENT, 'concentric')).toBe(
      cornerPath(100, 60, 20)
    );
    expect(
      superellipseCornerPoints(20, CORNER_EXPONENT, 'concentric')
    ).toEqual(superellipseCornerPoints(20));
    expect(kappaPeak(20, CORNER_EXPONENT, 'concentric')).toBeCloseTo(
      0.0668553,
      5
    );
  });
});
