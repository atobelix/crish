/**
 * paneEdgeGeometry — 二叉树窗格几何边缘感知微内核。
 *
 * 核心职责：
 * 根据布局树派生的百分比归一化矩形 rect (0 <= x,y < 1, 0 < w,h <= 1)，
 * 精确计算该窗格是否触达视口四周物理边界。
 *
 * 容差防线：
 * 引入 epsilon = 0.001 消除 Sash live resize 过程中的浮点累积误差。
 */

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneEdgeFlags {
  /** 是否位于顶行（需要考虑避让系统顶栏/交通灯/窗控三键） */
  isTopRow: boolean;
  /** 是否位于最左列（需要考虑避让折叠状态侧栏开关） */
  isLeftEdge: boolean;
  /** 是否位于最右列（需要考虑避让 Windows 窗控三键） */
  isRightEdge: boolean;
  /** 是否位于最底行 */
  isBottomRow: boolean;
}

const EPSILON = 0.001;
const RIGHT_BOTTOM_THRESHOLD = 0.99;

/**
 * 计算窗格是否触及四周物理边界
 */
export function computePaneEdges(rect: PaneRect): PaneEdgeFlags {
  // 折叠域或零尺寸节点保护
  if (rect.width <= EPSILON || rect.height <= EPSILON) {
    return {
      isTopRow: false,
      isLeftEdge: false,
      isRightEdge: false,
      isBottomRow: false,
    };
  }

  const isTopRow = rect.y <= EPSILON;
  const isLeftEdge = rect.x <= EPSILON;
  const isRightEdge = rect.x + rect.width >= RIGHT_BOTTOM_THRESHOLD;
  const isBottomRow = rect.y + rect.height >= RIGHT_BOTTOM_THRESHOLD;

  return {
    isTopRow,
    isLeftEdge,
    isRightEdge,
    isBottomRow,
  };
}
