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
 *
 * Conversation Unit 作用域：
 * - isUnitScopedDropAllowed 约束 tool 拖拽不得跨 session（同 unit 内 split/merge）
 * - chat 源不做 session 隔离（多 unit 并排由 session drag 负责）
 * - 域隔离（chat vs tool）由 types.isSameDomain 另行处理
 */

import { isChatDomain } from './types';

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
  /** 可选目标 tab id（用于同 leaf 内 tab 拖拽排序/目标位置计算） */
  targetTabId?: string;
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
 * Conversation Unit 作用域：判断 tool 拖放是否允许落在目标 leaf。
 *
 * 规则（与 applyDrop / useTreeDrag 共用，单一可信源）：
 * 1. chat 域源：不按 session 隔离 → 允许（多 unit 并排由 session drag 负责）
 * 2. tool 源无 ownerSessionId：无 unit 约束 → 允许（兼容旧单坞）
 * 3. tool 源有 ownerSessionId：
 *    - 目标有不同的非空 sessionId → 拒绝（跨 session tool / 他 session 的 chat）
 *    - 目标同 session 或未绑定 → 允许（merge 时再回写 owner）
 *
 * 注意：域隔离（tool→chat）由 isSameDomain 在上游处理；本函数是 session 层防御。
 *
 * @param srcPanelId 拖拽源 panelId
 * @param srcOwnerSessionId 源 leaf 的 sessionId（tool 叶 = ownerSessionId）
 * @param targetPanelId 目标 leaf panelId
 * @param targetOwnerSessionId 目标 leaf 的 sessionId
 */
export function isUnitScopedDropAllowed(
  srcPanelId: string,
  srcOwnerSessionId: string | undefined,
  _targetPanelId: string,
  targetOwnerSessionId: string | undefined
): boolean {
  // chat 源：不在此做 session 隔离
  if (isChatDomain(srcPanelId)) return true;

  const srcSid = (srcOwnerSessionId || '').trim();
  if (!srcSid) return true;

  const tgtSid = (targetOwnerSessionId || '').trim();
  // 目标已绑定其它 session（tool 或 chat）→ 跨 unit，拒绝
  // 域隔离（tool→chat）由 isSameDomain 上游处理；此处是 session 层防御
  if (tgtSid && tgtSid !== srcSid) return false;

  return true;
}

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
export function findLeafAtPointer<T extends { id: string; rect: Rect }>(
  pointer: Pointer,
  leafRects: T[]
): T | null {
  let best: { item: T; dist: number } | null = null;

  for (const item of leafRects) {
    if (!isPointerInRect(pointer, item.rect)) continue;
    const cx = item.rect.left + item.rect.width / 2;
    const cy = item.rect.top + item.rect.height / 2;
    const dist = Math.hypot(pointer.x - cx, pointer.y - cy);
    if (!best || dist < best.dist) {
      best = { item, dist };
    }
  }

  return best ? best.item : null;
}

/**
 * DropZone 浅相等比较 — 仅比较语义字段（type + targetLeafId）。
 *
 * confidence 是检测置信度（0-1），不参与相等判断：
 * 同一目标 leaf + 同一 zone 类型即视为"未变化"，避免每次 pointermove
 * 因 confidence 浮动触发 store setActiveDropZone → 订阅组件 re-render。
 *
 * 系统性约束：拖拽期间 tree 不可变（commitDrop 仅 pointerUp 触发），
 * 故 targetLeafId 在单次拖拽内是稳定标识符，可作为相等判据。
 *
 * 放置位置选择（系统性设计）：
 * isZoneSame 是 DropZone 类型的语义比较函数，与 DropZone 类型同模块。
 * 旧实现放在 useTreeDrag.ts 内部 — 但 useTreeDrag 是 hook，不应承载
 * 可独立的纯函数逻辑。移到 dropDetection.ts 让 hook 更聚焦于生命周期，
 * 且测试可直接从 dropDetection 导入，无需通过 hook 间接验证。
 */
export function isZoneSame(a: DropZone | null, b: DropZone | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.targetLeafId === b.targetLeafId;
}
