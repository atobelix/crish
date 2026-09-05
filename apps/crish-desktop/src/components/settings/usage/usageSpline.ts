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
  // 若四舍五入后达 1 亿，直接进位至亿，杜绝 "10000 万"
  if (v >= 99_950_000) {
    const yi = v / 100_000_000;
    return `${yi.toFixed(1)} 亿`;
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
 * 比例归一化函数，将 0.0 ~ 100.0 的百分制数值规约为 0.0 ~ 1.0 的比例
 * 杜绝启发式阈值截断，对 <= 1% 的小模型占比（如 0.5%）执行精确的除以 100
 */
export function normalizeModelRatio(rawVal: number): number {
  if (typeof rawVal !== 'number' || !Number.isFinite(rawVal) || rawVal <= 0) {
    return 0.0;
  }
  return Math.min(1.0, rawVal / 100.0);
}

/**
 * 格式化百分比
 */
export function formatPercentage(ratio: number): string {
  const norm = normalizeModelRatio(ratio);
  return `${(norm * 100).toFixed(1)}%`;
}

export interface ModelColorTheme {
  stroke: string;
  bg: string;
}

export const GLOBAL_MODEL_PALETTE: ModelColorTheme[] = [
  { stroke: 'var(--usage-color-brand)', bg: 'var(--usage-color-brand-bg)' },
  { stroke: 'var(--usage-color-claude)', bg: 'var(--usage-color-claude-bg)' },
  { stroke: 'var(--usage-color-minimax)', bg: 'var(--usage-color-minimax-bg)' },
  { stroke: 'var(--usage-color-kimi)', bg: 'var(--usage-color-kimi-bg)' },
  { stroke: 'var(--usage-color-other)', bg: 'var(--usage-color-other-bg)' },
  { stroke: 'var(--usage-color-cost-total)', bg: 'var(--usage-color-cost-total-bg)' },
];

/**
 * 全局统一的模型语义配色算法，杜绝跨组件颜色语义断层
 */
export function getModelColor(modelName: string, fallbackIdx = 0): ModelColorTheme {
  const lower = (modelName || '').toLowerCase();
  if (lower === 'other' || lower === '__others__') return GLOBAL_MODEL_PALETTE[4]!;
  if (lower.includes('deepseek')) return GLOBAL_MODEL_PALETTE[0]!;
  if (lower.includes('claude')) return GLOBAL_MODEL_PALETTE[1]!;
  if (lower.includes('minimax')) return GLOBAL_MODEL_PALETTE[2]!;
  if (lower.includes('kimi') || lower.includes('moonshot')) return GLOBAL_MODEL_PALETTE[3]!;
  if (lower.includes('openai') || lower.includes('gpt')) return GLOBAL_MODEL_PALETTE[5]!;
  return GLOBAL_MODEL_PALETTE[fallbackIdx % GLOBAL_MODEL_PALETTE.length] ?? GLOBAL_MODEL_PALETTE[0]!;
}

export interface DecimatedTick {
  index: number;
  label: string;
  leftPercent: number;
  transform: string;
}

/**
 * X 轴刻度均匀抽稀算法，根据几何等分采样并施加 Delta >= 3 物理防碰撞保护，
 * 杜绝在任意滑动时钟窗口下发生相邻刻度文字叠字。
 */
export function computeDecimatedTicks(
  points: { label: string }[],
  range: '24h' | '7d' | '30d',
  xStart = 40,
  xEnd = 750,
  totalWidth = 760
): DecimatedTick[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) {
    return [{ index: 0, label: points[0]!.label, leftPercent: 50, transform: 'translateX(-50%)' }];
  }

  // 7d 且采样点少于等于 8 时（如 7 天），相邻点物理跨距已达 ~118px，无需套用抽稀，全部保留输出
  if (range === '7d' && n <= 8) {
    return points.map((pt, idx) => {
      const posRatio = idx / (n - 1);
      const chartX = xStart + posRatio * (xEnd - xStart);
      const leftPercent = (chartX / totalWidth) * 100;

      let transform = 'translateX(-50%)';
      if (idx === 0) transform = 'translateX(0%)';
      else if (idx === n - 1) transform = 'translateX(-100%)';

      return {
        index: idx,
        label: pt.label,
        leftPercent,
        transform,
      };
    });
  }

  const candidateIndices: number[] = [0];

  if (range === '24h' && n >= 20) {
    // 24h 序列采样 5 个点：首点、3个四等分点、尾点
    const step = (n - 1) / 4;
    for (let k = 1; k < 4; k++) {
      candidateIndices.push(Math.round(k * step));
    }
  } else if (range === '30d' && n >= 25) {
    const step = (n - 1) / 5;
    for (let k = 1; k < 5; k++) {
      candidateIndices.push(Math.round(k * step));
    }
  } else {
    if (n <= 8) {
      for (let i = 1; i < n - 1; i++) candidateIndices.push(i);
    } else {
      const step = (n - 1) / 4;
      for (let k = 1; k < 4; k++) {
        candidateIndices.push(Math.round(k * step));
      }
    }
  }
  candidateIndices.push(n - 1);

  // 物理防碰撞过滤：确保任意相邻两点索引差值 >= 3 (物理间距 >= 90px)
  const validIndices: number[] = [];
  for (let i = 0; i < candidateIndices.length; i++) {
    const cur = candidateIndices[i]!;
    if (validIndices.length === 0) {
      validIndices.push(cur);
    } else {
      const last = validIndices[validIndices.length - 1]!;
      if (i === candidateIndices.length - 1) {
        if (cur - last < 3 && validIndices.length > 1) {
          validIndices.pop();
        }
        validIndices.push(cur);
      } else if (cur - last >= 3) {
        validIndices.push(cur);
      }
    }
  }

  return validIndices.map((idx) => {
    const pt = points[idx]!;
    const posRatio = idx / (n - 1);
    const chartX = xStart + posRatio * (xEnd - xStart);
    const leftPercent = (chartX / totalWidth) * 100;

    let transform = 'translateX(-50%)';
    if (idx === 0) transform = 'translateX(0%)';
    else if (idx === n - 1) transform = 'translateX(-100%)';

    return {
      index: idx,
      label: pt.label,
      leftPercent,
      transform,
    };
  });
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
