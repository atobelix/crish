/**
 * 自适应 Drop Zone 检测算法。
 *
 * 替代旧 fiveZoneDetection 的硬编码比例（12.5%/20%），
 * 使用距离梯度加权 + 面板尺寸自适应，提供精确的分割方向判定。
 *
 * 核心思路：
 * 1. 计算指针到 leaf 四条边的归一化距离（0=边缘, 1=中心）
 * 2. 边缘区域 → split 方向取最近边
 * 3. 中心区域 → merge-tab（合并为 tab）
 * 4. 过渡区 → 按距离梯度加权取最高分
 * 5. 窄面板自适应：面板越窄/矮，边缘区域占比越大
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Pointer {
  x: number;
  y: number;
}

export type DropZoneType =
  'split-left' | 'split-right' | 'split-top' | 'split-bottom' | 'merge-tab';

export interface DropZone {
  type: DropZoneType;
  targetLeafId: string;
  /** 置信度 0-1，可用于指示器透明度/动画强度 */
  confidence: number;
}

export interface DropDetectionOptions {
  /** 边缘判定阈值（归一化，默认 0.15） */
  edgeThreshold?: number;
  /** 中心判定阈值（归一化，默认 0.35） */
  centerBias?: number;
  /** 窄面板自适应的最小尺寸（px，低于此值边缘区域扩大） */
  minAdaptiveSize?: number;
}

const DEFAULT_EDGE_THRESHOLD = 0.15;
const DEFAULT_CENTER_BIAS = 0.35;
const DEFAULT_MIN_ADAPTIVE_SIZE = 200;

/**
 * 检测指针相对于目标 leaf 的 drop zone。
 *
 * @param pointer 指针位置（viewport 坐标）
 * @param leafRect 目标 leaf 的 rect（viewport 坐标）
 * @param leafId 目标 leaf 的 id
 * @param options 检测参数
 */
export function detectDropZone(
  pointer: Pointer,
  leafRect: Rect,
  leafId: string,
  options?: DropDetectionOptions
): DropZone {
  const edgeThreshold = options?.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD;
  const centerBias = options?.centerBias ?? DEFAULT_CENTER_BIAS;
  const minAdaptiveSize = options?.minAdaptiveSize ?? DEFAULT_MIN_ADAPTIVE_SIZE;

  const { width, height } = leafRect;

  // 归一化距离：指针到各边的距离 / 对应维度尺寸
  // 0 = 在边上，0.5 = 中心，1 = 在对面边上
  const dLeft = width > 0 ? (pointer.x - leafRect.left) / width : 0.5;
  const dRight = width > 0 ? (leafRect.right - pointer.x) / width : 0.5;
  const dTop = height > 0 ? (pointer.y - leafRect.top) / height : 0.5;
  const dBottom = height > 0 ? (leafRect.bottom - pointer.y) / height : 0.5;

  // 自适应阈值：面板越窄/矮，边缘区域越大
  const adaptiveScale = Math.min(1, minAdaptiveSize / Math.min(width, height));
  const effectiveEdge = edgeThreshold * (1 + (adaptiveScale - 1) * 0.5);
  const effectiveCenter = centerBias * (1 - (adaptiveScale - 1) * 0.3);

  //  clamp 归一化距离到 [0, 1]
  const clampedLeft = Math.max(0, Math.min(1, dLeft));
  const clampedRight = Math.max(0, Math.min(1, dRight));
  const clampedTop = Math.max(0, Math.min(1, dTop));
  const clampedBottom = Math.max(0, Math.min(1, dBottom));

  // 找最近边
  const minDist = Math.min(
    clampedLeft,
    clampedRight,
    clampedTop,
    clampedBottom
  );

  // 1. 中心区域：所有边距离都大于 centerBias → merge-tab
  if (minDist > effectiveCenter) {
    return {
      type: 'merge-tab',
      targetLeafId: leafId,
      confidence: Math.min(
        1,
        (minDist - effectiveCenter) / (0.5 - effectiveCenter + 0.01)
      ),
    };
  }

  // 2. 边缘区域：最近边距离 < edgeThreshold → split
  if (minDist < effectiveEdge) {
    const type = edgeToDropZoneType(
      clampedLeft,
      clampedRight,
      clampedTop,
      clampedBottom
    );
    const confidence = 1 - minDist / effectiveEdge;
    return {
      type,
      targetLeafId: leafId,
      confidence: Math.max(0.3, confidence),
    };
  }

  // 3. 过渡区：按距离梯度加权
  // 分数越高越倾向于该方向
  const scores: Array<{ type: DropZoneType; score: number }> = [
    {
      type: 'split-left',
      score: scoreForEdge(clampedLeft, effectiveEdge, effectiveCenter),
    },
    {
      type: 'split-right',
      score: scoreForEdge(clampedRight, effectiveEdge, effectiveCenter),
    },
    {
      type: 'split-top',
      score: scoreForEdge(clampedTop, effectiveEdge, effectiveCenter),
    },
    {
      type: 'split-bottom',
      score: scoreForEdge(clampedBottom, effectiveEdge, effectiveCenter),
    },
    {
      type: 'merge-tab',
      score: scoreForCenter(minDist, effectiveEdge, effectiveCenter),
    },
  ];

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0]!;

  return {
    type: best.type,
    targetLeafId: leafId,
    confidence: Math.max(0.1, Math.min(1, best.score)),
  };
}

/** 根据最近边确定 split 方向 */
function edgeToDropZoneType(
  dLeft: number,
  dRight: number,
  dTop: number,
  dBottom: number
): DropZoneType {
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dLeft) return 'split-left';
  if (min === dRight) return 'split-right';
  if (min === dTop) return 'split-top';
  return 'split-bottom';
}

/** 边缘方向的分数：距离越小分越高 */
function scoreForEdge(dist: number, edge: number, center: number): number {
  if (dist <= edge) return 1;
  if (dist >= center) return 0;
  // 线性插值：edge→1, center→0
  return 1 - (dist - edge) / (center - edge);
}

/** 中心方向的分数：所有边距离都大时分高 */
function scoreForCenter(minDist: number, edge: number, center: number): number {
  if (minDist >= center) return 1;
  if (minDist <= edge) return 0;
  return (minDist - edge) / (center - edge);
}

// ── 辅助：从 DOM rect 构建 Rect ──────────────────────────────────────

export function rectFromDOM(domRect: DOMRect): Rect {
  return {
    left: domRect.left,
    top: domRect.top,
    right: domRect.right,
    bottom: domRect.bottom,
    width: domRect.width,
    height: domRect.height,
  };
}

/** 判断指针是否在 rect 内 */
export function isPointerInRect(pointer: Pointer, rect: Rect): boolean {
  return (
    pointer.x >= rect.left &&
    pointer.x <= rect.right &&
    pointer.y >= rect.top &&
    pointer.y <= rect.bottom
  );
}

/**
 * 从多个 leaf rect 中找到指针所在的 leaf。
 * 返回最近中心的 leaf（如果有多个重叠）。
 */
export function findLeafAtPointer(
  pointer: Pointer,
  leafRects: Array<{ id: string; rect: Rect }>
): { id: string; rect: Rect } | null {
  let best: { id: string; rect: Rect; dist: number } | null = null;

  for (const { id, rect } of leafRects) {
    if (!isPointerInRect(pointer, rect)) continue;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(pointer.x - cx, pointer.y - cy);
    if (!best || dist < best.dist) {
      best = { id, rect, dist };
    }
  }

  return best ? { id: best.id, rect: best.rect } : null;
}
