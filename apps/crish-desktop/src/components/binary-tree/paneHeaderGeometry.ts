/**
 * paneHeaderGeometry — 窗格会话标签条的纯几何与关闭数学（零 DOM、零副作用）。
 *
 * 数值一律来自 utils/tabStripGeometry 单一来源；本模块可独立穷举测试。
 */

import {
  CLOSE_BTN_RIGHT_OFFSET_PX,
  NON_TAB_SPACE_PX,
  TAB_GAP_PX,
  TAB_WIDTH_MAX_PX,
  TAB_WIDTH_MIN_PX,
} from '../../utils/tabStripGeometry';

/** 本叶条带成员：维 01 SessionTab 形状（含草稿） */
export interface LeafSessionTab {
  tabId: string;
  sessionId: string;
  title?: string;
}

/** 关 active 时的邻居：优先左邻，否则右邻（与维 02 removeTab 一致），排除已在离场中的标签 */
export function nextAvailableNeighborId(
  tabs: LeafSessionTab[],
  closingTabId: string,
  closingIds: Set<string>
): string | null {
  const alive = tabs.filter(
    (t) => t.tabId === closingTabId || !closingIds.has(t.tabId)
  );
  if (alive.length <= 1) return null;
  const idx = alive.findIndex((t) => t.tabId === closingTabId);
  if (idx < 0) return null;
  const neighbor = idx > 0 ? alive[idx - 1] : alive[idx + 1];
  return neighbor?.tabId ?? null;
}

/** 严格等宽基准宽度：有空余时标准 240px，空间紧缩时全员严格同比例均分压缩，严禁溢出视野 */
export function computeNaturalTabWidth(
  count: number,
  containerWidth: number
): number {
  if (count <= 0 || containerWidth <= 0) {
    return TAB_WIDTH_MAX_PX;
  }
  const available = Math.max(0, containerWidth - NON_TAB_SPACE_PX);
  const totalNeeded = count * TAB_WIDTH_MAX_PX + (count - 1) * TAB_GAP_PX;
  if (totalNeeded <= available) {
    return TAB_WIDTH_MAX_PX;
  }
  const fitted = Math.floor((available - (count - 1) * TAB_GAP_PX) / count);
  return Math.max(TAB_WIDTH_MIN_PX, fitted);
}

export interface CloseLockInput {
  /** 是否删除的是最右端标签（右侧已无标签可向左补位） */
  isRightmost: boolean;
  /** 关闭后仍存活的标签数 */
  remainingCount: number;
  /** 光标在容器内容坐标系中的 X（含 scrollLeft 修正）；量测失败为 null */
  mouseXInContainer: number | null;
  /** 事件派发期内同步量测到的当前标签宽度 */
  measuredWidth: number;
  /** 容器可用最大宽度（可选防御，防止锁宽超过容器导致横向溢出） */
  maxFittingWidth?: number;
}

/**
 * 关闭锁定宽度：
 * 分支 A（右侧还有存活标签）：直接用实测等宽让右邻补位；
 * 分支 B（删末尾标签）：按光标位置反推等宽，使前序标签的叉号精准落到光标下，
 * 反推值超出标准宽度或容器容纳极限时严格钳制，绝不强行拉伸或横向溢出。
 * 坐标缺失时安全回退当前宽度 measuredWidth。
 */
export function computeCloseLockWidth(input: CloseLockInput): number {
  const {
    isRightmost,
    remainingCount,
    mouseXInContainer,
    measuredWidth,
    maxFittingWidth,
  } = input;
  if (!isRightmost || remainingCount <= 0) {
    return measuredWidth;
  }
  const maxWidth =
    maxFittingWidth != null && maxFittingWidth > 0
      ? Math.min(TAB_WIDTH_MAX_PX, maxFittingWidth)
      : TAB_WIDTH_MAX_PX;

  if (mouseXInContainer != null && mouseXInContainer > 0) {
    const neededWidth =
      (mouseXInContainer +
        CLOSE_BTN_RIGHT_OFFSET_PX -
        (remainingCount - 1) * TAB_GAP_PX) /
      remainingCount;
    if (neededWidth <= maxWidth) {
      return Math.max(TAB_WIDTH_MIN_PX, Math.round(neededWidth));
    }
    return maxWidth;
  }
  return Math.min(measuredWidth, maxWidth);
}
