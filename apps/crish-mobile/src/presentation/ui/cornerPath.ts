/**
 * apps/crish-mobile/src/presentation/ui/cornerPath.ts
 *
 * G² 连续曲率圆角 · 生成层的移动端同构转写（立项 docs/g2-corner-rollout-20261106
 * §2.2 / §三第 0 波试点）：与桌面 apps/crish-desktop/src/utils/cornerPath.ts
 * 同一数学、同一采样律（等角采样）、同一坐标格式化（3 位小数）——数值测试
 * 向量两端共用（κ_peak、对角点、偏差预算），任一端漂移都会在自己一侧变红。
 * 参数单值 n = 2.42 与桌面 tokens 的 --corner-exponent 同值；移动端名义半径
 * 的真相源仍是 theme.ts 的 ThemeRadius，形状指数不在移动端另立第二来源。
 *
 * 试点落点（第 0 波）：本文件是 SoftShadow 体系未来的轮廓生成点——
 * SoftShadow.tsx / SoftShadowSurface.tsx 现以 SvgRect(rx/ry) 画普通圆弧阴影
 * 源形；第 4 波把源形换成本文件的 cornerSvgPath 输出（Path d），填充层
 * borderRadius 同步换 clip。**第 0 波不翻默认**：现有表面的阴影轮廓与视觉
 * 输出零变化，翻转动作与真机帧率数据归第 4 波（立项方案试点口径）。
 */

/** 超椭圆指数 n（全产品单值；与桌面 --corner-exponent 必须一致） */
export const CORNER_EXPONENT = 2.42;

/** κ_peak 系数：κ_peak = CORNER_KAPPA_PEAK_FACTOR / R（n=2.42 时 = 1.337106…，与桌面共用向量） */
export const CORNER_KAPPA_PEAK_FACTOR =
  ((CORNER_EXPONENT - 1) / 2) * Math.pow(2, 1 / 2 + 1 / CORNER_EXPONENT);

/** 峰值曲率 κ_peak = ((n−1)/2)·2^(1/2+1/n) / R；R≤0 时返回 0 */
export function kappaPeak(R: number, n: number = CORNER_EXPONENT): number {
  if (!(R > 0)) return 0;
  const factor = ((n - 1) / 2) * Math.pow(2, 1 / 2 + 1 / n);
  return factor / R;
}

/** 四角名义半径（逐角独立；0 = 该角直角/关闭） */
export interface CornerRadii {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

export type CornerRadiiInput = number | Partial<CornerRadii>;

/** 同心链在生成层收口：内层名义半径 = max(0, R − padding) */
export function concentricRadius(R: number, padding: number): number {
  return Math.max(0, R - padding);
}

function normalizeRadii(
  input: CornerRadiiInput,
  w: number,
  h: number,
): CornerRadii {
  const cap = Math.max(0, Math.min(w, h) / 2);
  const one = (v: number | undefined, fallback: number): number => {
    const raw = v === undefined ? fallback : v;
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(raw, cap);
  };
  if (typeof input === 'number') {
    const r = one(input, 0);
    return { tl: r, tr: r, br: r, bl: r };
  }
  return {
    tl: one(input.tl, 0),
    tr: one(input.tr, 0),
    br: one(input.br, 0),
    bl: one(input.bl, 0),
  };
}

/** 每角采样点数（与桌面同一律）：随 R 自适应，折线对解析轮廓偏差 < 0.02px */
function samplesFor(R: number): number {
  return Math.min(64, Math.max(24, Math.ceil(R * 1.5)));
}

/**
 * 典范角采样点（与桌面逐字同律）：等角采样——以 (ξ, η) = (R−x, R−y) 计，
 * ξ = R·cos^(2/n)θ、η = R·sin^(2/n)θ，θ 自 π/2 等分递减至 0，端点字面钉死。
 * 点列自 (R, 0) 至 (0, R)，每点满足 (R−x)^n + (R−y)^n = R^n。
 */
export function superellipseCornerPoints(
  R: number,
  n: number = CORNER_EXPONENT,
): Array<readonly [number, number]> {
  if (!(R > 0)) return [[0, 0]];
  const N = samplesFor(R);
  const pts: Array<readonly [number, number]> = [];
  for (let k = 0; k <= N; k++) {
    if (k === 0) {
      pts.push([R, 0] as const);
      continue;
    }
    if (k === N) {
      pts.push([0, R] as const);
      continue;
    }
    const theta = (Math.PI / 2) * (1 - k / N);
    const xi = R * Math.pow(Math.cos(theta), 2 / n);
    const eta = R * Math.pow(Math.sin(theta), 2 / n);
    pts.push([R - xi, R - eta] as const);
  }
  return pts;
}

const fmt = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};

/**
 * 整径轮廓 → SVG Path `d`（与桌面 cornerPath 同一实现律；四角由典范角点列
 * 镜像生成）。SoftShadow 试点接入形态：作为 react-native-svg <Path d> 的
 * 阴影源形数据（第 4 波翻转）。w/h ≤ 0 返回空串；全角为 0 返回普通矩形路径。
 */
export function cornerSvgPath(
  w: number,
  h: number,
  radii: CornerRadiiInput,
  n: number = CORNER_EXPONENT,
): string {
  if (!(w > 0) || !(h > 0)) return '';
  const r = normalizeRadii(radii, w, h);
  const { tl, tr, br, bl } = r;
  if (tl === 0 && tr === 0 && br === 0 && bl === 0) {
    return `M0 0H${fmt(w)}V${fmt(h)}H0Z`;
  }
  const seg: string[] = [`M${fmt(tl)} 0`, `H${fmt(w - tr)}`];
  // TR：(cx, cy) → (w − cx, cy)，跳过首点
  if (tr > 0) {
    const pts = superellipseCornerPoints(tr, n);
    for (let k = 1; k < pts.length; k++) {
      const pt = pts[k];
      if (!pt) continue;
      seg.push(`L${fmt(w - pt[0])} ${fmt(pt[1])}`);
    }
  } else {
    seg.push(`L${fmt(w)} 0`);
  }
  seg.push(`V${fmt(h - br)}`);
  // BR：(cx, cy) → (w − cy, h − cx)，跳过首点
  if (br > 0) {
    const pts = superellipseCornerPoints(br, n);
    for (let k = 1; k < pts.length; k++) {
      const pt = pts[k];
      if (!pt) continue;
      seg.push(`L${fmt(w - pt[1])} ${fmt(h - pt[0])}`);
    }
  } else {
    seg.push(`L${fmt(w)} ${fmt(h)}`);
  }
  seg.push(`H${fmt(bl)}`);
  // BL：(cx, cy) → (cx, h − cy)，跳过首点
  if (bl > 0) {
    const pts = superellipseCornerPoints(bl, n);
    for (let k = 1; k < pts.length; k++) {
      const pt = pts[k];
      if (!pt) continue;
      seg.push(`L${fmt(pt[0])} ${fmt(h - pt[1])}`);
    }
  } else {
    seg.push(`L0 ${fmt(h)}`);
  }
  seg.push(`V${fmt(tl)}`);
  // TL：典范角逆序，跳过两端点（与 V/Z 重合）
  if (tl > 0) {
    const pts = superellipseCornerPoints(tl, n);
    for (let k = pts.length - 2; k >= 1; k--) {
      const pt = pts[k];
      if (!pt) continue;
      seg.push(`L${fmt(pt[0])} ${fmt(pt[1])}`);
    }
  }
  seg.push('Z');
  return seg.join('');
}
