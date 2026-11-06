/**
 * apps/crish-desktop/src/utils/cornerPath.ts
 *
 * G² 连续曲率圆角 · 生成层（全产品唯一实现，@g2-generator）
 *
 * 规格：立项方案《G² 连续曲率圆角全产品推广》§2.2（docs/g2-corner-rollout-20261106/），
 * 几何基准 = 设计说明第十一节（reference/muse-approval-card-design-20261106/）：
 * 超椭圆角族 (R−x)^n + (R−y)^n = R^n，n = CORNER_EXPONENT = 2.42（参数层单值，
 * tokens-radius.css 的 --corner-exponent，两处由 g2-corner.contract.test.ts 钉住一致）。
 * 性质：角与直边交界处曲率为 0、沿弧平滑升至对角峰值 κ_peak = 1.337/R（位置/切线/
 * 曲率三连续的真 G²）；角占位恰为名义半径 R（同心算术 R−padding 与既有同心契约兼容）。
 *
 * 纪律（禁止清单，守卫见 styles/g2-corner.contract.test.ts）：
 * - 本文件是桌面端唯一角轮廓生成实现；禁止把生成函数复制到第二个文件；
 * - 移动端有一份同构转写（crish-mobile/src/presentation/ui/cornerPath.ts），
 *   是禁止清单⑤的唯一例外，两端共用同一组数值测试向量互校验；
 * - 接入面只声明档位名（G2_TIERS）或名义半径数值，不手写路径数据。
 */

/** 超椭圆指数 n（全产品单值；与 tokens-radius.css 的 --corner-exponent 必须一致） */
export const CORNER_EXPONENT = 2.42;

/** κ_peak 系数：κ_peak = CORNER_KAPPA_PEAK_FACTOR / R（n=2.42 时 = 1.337106…） */
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

/**
 * 档位 → 名义半径映射（参数层 §2.1 的代码侧镜像；契约与 tokens 定义逐项对账）。
 * r16 为单独立档：16 是聊天域用量最大的外框档之一，角色 token 系在 card 12 与
 * dock 20 之间是空档，其 token 事实源为别名 --radius-xl(16)。
 */
export const G2_TIERS = {
  dock: 20,
  modal: 24,
  menuOuter: 18,
  r16: 16,
  card: 12,
  btn: 10,
  control: 8,
  row: 6,
} as const;

export type G2RadiusTier = keyof typeof G2_TIERS;

/** 同心链在生成层收口：内层名义半径 = max(0, R − padding)（禁止各模块再手写 calc 推导） */
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

/** 每角采样点数：随 R 自适应，保证折线对解析轮廓的逼近偏差 < 0.02px（数值测试实证） */
function samplesFor(R: number): number {
  return Math.min(64, Math.max(24, Math.ceil(R * 1.5)));
}

/**
 * 典范角采样点：R×R 角域内从 (R, 0) 到 (0, R) 的超椭圆四分之一段（含两端点），
 * 满足 (R−x)^n + (R−y)^n = R^n。cornerPath 四角均由本点列以镜像式生成；
 * 本函数同时是两端共享测试向量的采样基准导出。
 *
 * 采样律 = 等角采样：以 (ξ, η) = (R−x, R−y) 计，ξ = R·cos^(2/n)θ、
 * η = R·sin^(2/n)θ，θ 自 π/2 等分递减至 0。不可用 u 参数化等分：u 式在
 * (0, R) 端切线竖直奇点处折线偏差实测达 0.21px（R=20），等角采样全域
 * ≤0.008px（数值测试实证，预算 0.02px）。端点以字面值钉死（浮点 cos(π/2)
 * 非精确 0），保证角占位恰为 R。
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
 * 生成闭合轮廓路径（SVG path 字符串），顺时针、自顶边 TL 角后开始。
 * - 逐角独立半径，0 = 直角（逐角开关：覆盖分角面如引用块、GoalRibbon docked）；
 * - 同一表面两态半径不同（双轮廓切换）时以不同 r 调用本函数产出两条轮廓；
 * - 尺寸口径：仅应在尺寸落定时调用并按 (w,h,R) 缓存结果，动画/拖拽中冻结
 *   起始尺寸轮廓（立项方案 §2.2-5，槽 E 首个实测此策略）；
 * - w/h ≤ 0 返回空串；全角为 0 返回普通矩形路径。
 */
export function cornerPath(
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
  // 四角均由典范角点列（superellipseCornerPoints，自 (R,0) 至 (0,R)）镜像生成，
  // 逐角的局部方程 (R−a)^n + (R−b)^n = R^n 由典范方程直接传递（数值测试逐角验）：
  // TR：(cx, cy) → (w − cx, cy)，跳过首点（与 H 端点重合）
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
  // BR：(cx, cy) → (w − cy, h − cx)，跳过首点（与 V 端点重合）
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
  // BL：(cx, cy) → (cx, h − cy)，跳过首点（与 H 端点重合）
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
  // TL：典范角逆序（自 (0, tl) 回到 (tl, 0)），跳过两端点（与直线/Z 重合）
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

/**
 * 可拉伸 SVG 背景层（max-content 宽表面首选，立项方案 §2.2-3）：
 * 以生成尺寸 (w,h) 产出路径并以 preserveAspectRatio="none" 拉伸至宿主实测尺寸；
 * 宿主尺寸相对生成尺寸偏差越大角部比例失真越大，接入清单须逐面注明生成尺寸口径。
 */
export function cornerSvgDataUri(
  w: number,
  h: number,
  radii: CornerRadiiInput,
  fill: string,
  n: number = CORNER_EXPONENT,
): string {
  const d = cornerPath(w, h, radii, n);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}" ` +
    `preserveAspectRatio="none"><path d="${d}" fill="${fill}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** void 元素（<input> 类）承载形态：同路径 clip-path（Chromium path() 语法） */
export function cornerClipPath(
  w: number,
  h: number,
  radii: CornerRadiiInput,
  n: number = CORNER_EXPONENT,
): string {
  return `path('${cornerPath(w, h, radii, n)}')`;
}
