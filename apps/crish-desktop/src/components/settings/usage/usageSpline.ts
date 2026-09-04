/**
 * 单调三次样条插值与图表几何数学纯逻辑库（Fritsch-Carlson Monotone Cubic Spline）
 * 严格保证插值单调性，极值点处导数为 0，数学上杜绝假性下凹与向上振荡超调。
 */

export interface SplinePoint {
  x: number;
  y: number;
  val?: number;
}

/**
 * 格式化 Token 数（万分位缩写与千分位兜底）
 */
export function formatTokens(v: number): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '0';
  if (v >= 100_000_000) {
    const yi = v / 100_000_000;
    return `${yi >= 10 ? yi.toFixed(1) : yi.toFixed(2)} 亿`;
  }
  if (v >= 10_000) {
    const w = v / 10_000;
    return `${w >= 100 ? w.toFixed(0) : w >= 10 ? w.toFixed(1) : w.toFixed(2)} 万`;
  }
  return v.toLocaleString('zh-CN');
}

/**
 * 格式化费用（保留 2 位小数）
 */
export function formatCost(v: number, prefix = '¥ '): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return `${prefix}0.00`;
  return `${prefix}${v.toFixed(2)}`;
}

/**
 * 格式化百分比
 */
export function formatPercentage(ratio: number): string {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return '0.0%';
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * 单调三次样条曲线生成算法 (Fritsch-Carlson)
 * @param points 带有 x, y 坐标的连续有序点集
 * @returns SVG `<path d="...">` 字符串
 */
export function getMonotoneSplinePath(points: SplinePoint[]): string {
  const n = points.length;
  if (n === 0) return '';
  const pt0 = points[0]!;
  if (n === 1) return `M ${pt0.x.toFixed(1)},${pt0.y.toFixed(1)}`;
  const pt1 = points[1]!;
  if (n === 2) {
    return `M ${pt0.x.toFixed(1)},${pt0.y.toFixed(1)} L ${pt1.x.toFixed(1)},${pt1.y.toFixed(1)}`;
  }

  const deltas: number[] = [];
  const dxs: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const cur = points[i]!;
    const next = points[i + 1]!;
    const dx = next.x - cur.x;
    const dy = next.y - cur.y;
    dxs.push(dx);
    deltas.push(dx === 0 ? 0 : dy / dx);
  }

  const m: number[] = [deltas[0] ?? 0];
  for (let i = 1; i < n - 1; i++) {
    const prevDelta = deltas[i - 1] ?? 0;
    const curDelta = deltas[i] ?? 0;
    m.push((prevDelta + curDelta) / 2);
  }
  m.push(deltas[n - 2] ?? 0);

  for (let i = 0; i < n - 1; i++) {
    const curDelta = deltas[i] ?? 0;
    if (curDelta === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const curM = m[i] ?? 0;
      const nextM = m[i + 1] ?? 0;
      let alpha = curM / curDelta;
      let beta = nextM / curDelta;
      if (alpha < 0) alpha = 0;
      if (beta < 0) beta = 0;
      const s = alpha * alpha + beta * beta;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        m[i] = tau * alpha * curDelta;
        m[i + 1] = tau * beta * curDelta;
      }
    }
  }

  let path = `M ${pt0.x.toFixed(1)},${pt0.y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const cur = points[i]!;
    const next = points[i + 1]!;
    const dx = dxs[i] ?? 0;
    const curM = m[i] ?? 0;
    const nextM = m[i + 1] ?? 0;
    const cp1x = cur.x + dx / 3;
    const cp1y = cur.y + curM * (dx / 3);
    const cp2x = next.x - dx / 3;
    const cp2y = next.y - nextM * (dx / 3);
    path += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${next.x.toFixed(1)},${next.y.toFixed(1)}`;
  }
  return path;
}

/**
 * 生成底闭合渐变填充面积区域路径
 * @param points 带有 x, y 坐标的连续有序点集
 * @param bottomY 底边 Y 坐标
 */
export function getAreaSplinePath(points: SplinePoint[], bottomY = 140): string {
  if (!points || points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return '';
  const linePath = getMonotoneSplinePath(points);
  return `${linePath} L ${last.x.toFixed(1)},${bottomY.toFixed(1)} L ${first.x.toFixed(1)},${bottomY.toFixed(1)} Z`;
}

/**
 * 视口边缘安全钳位函数（Edge Clamping），防止浮层卡片被容器截断
 * @param idealX 理想居中定位坐标
 * @param cardWidth 卡片实际测量宽度
 * @param containerWidth 容器视口宽度
 * @param margin 安全内边距缓冲
 */
export function clampViewportX(
  idealX: number,
  cardWidth: number,
  containerWidth: number,
  margin = 6
): number {
  const half = cardWidth / 2;
  const minX = half + margin;
  const maxX = Math.max(minX, containerWidth - half - margin);
  return Math.min(Math.max(idealX, minX), maxX);
}
