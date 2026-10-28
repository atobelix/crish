/**
 * apps/crish-desktop/src/components/binary-tree/detectDockDropZone.ts
 *
 * 右坞专属落点探测与物理围栏硬防线（Phase 3 架构）
 *
 * 核心铁律：
 * 1. 物理包围盒刚性切断（Physical Bounding Fence）：
 *    以 dockRootRef.getBoundingClientRect() 为物理硬边界。
 *    指针坐标 (x, y) 一旦超出包围盒（例如移向顶栏 _tabsContainer_1wzf4_71 或左侧聊天区），
 *    立即短路返回 null，绝不触发任何顶栏 DOM 查询或位移。
 * 2. 放置区域判定与几何五分法（Five-Zone Geometry）：
 *    在目标窗格内部根据指针相对比例划定：
 *    - 中心 50%：合并入目标窗格标签栏末尾 (kind: 'tab-strip')
 *    - 左侧 25%：向左分屏切分 (kind: 'split-left')
 *    - 右侧 25%：向右分屏切分 (kind: 'split-right')
 *    - 顶部 25%：向上分屏切分 (kind: 'split-top')
 *    - 底部 25%：向下分屏切分 (kind: 'split-bottom')
 * 3. 尺寸下限守卫（Min-size Split Guard）：
 *    目标窗格宽度 < 240px 时禁止水平切分（降级为 'tab-strip' 合并）；
 *    目标窗格高度 < 160px 时禁止垂直切分（降级为 'tab-strip' 合并）。
 * 4. 纯函数设计、零副作用、无任何 patch 或 `any`。
 */

import { collectStripTabs } from '../shell/sessionTabDragDom';
import { computeSessionTabInsertIndex } from '../shell/sessionTabDragFeel';

export type DockDropKind =
  'tab-strip' | 'split-left' | 'split-right' | 'split-top' | 'split-bottom';

export interface DockDropTarget {
  readonly kind: DockDropKind;
  readonly targetDockLeafId: string;
  readonly insertIndex?: number;
  readonly indicatorRect?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export interface DockDragSourceInfo {
  readonly sourceLeafId: string;
  readonly tabId: string;
}

export interface DetectDockDropZoneOptions {
  /** 允许自定义最小水平切分宽度阈值（缺省 240px） */
  minSplitWidth?: number;
  /** 允许自定义最小垂直切分高度阈值（缺省 160px） */
  minSplitHeight?: number;
}

export const MIN_DOCK_SPLIT_WIDTH = 240;
export const MIN_DOCK_SPLIT_HEIGHT = 160;
export const DOCK_SPLIT_EDGE_RATIO = 0.25;

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 计算落点指示高亮框的视口矩形
 */
export function computeDockIndicatorRect(
  kind: DockDropKind,
  r: RectLike
): RectLike {
  const pad = 2;
  switch (kind) {
    case 'split-left':
      return {
        left: r.left + pad,
        top: r.top + pad,
        width: Math.max(0, r.width * 0.5 - pad * 2),
        height: Math.max(0, r.height - pad * 2),
      };
    case 'split-right':
      return {
        left: r.left + r.width * 0.5 + pad,
        top: r.top + pad,
        width: Math.max(0, r.width * 0.5 - pad * 2),
        height: Math.max(0, r.height - pad * 2),
      };
    case 'split-top':
      return {
        left: r.left + pad,
        top: r.top + pad,
        width: Math.max(0, r.width - pad * 2),
        height: Math.max(0, r.height * 0.5 - pad * 2),
      };
    case 'split-bottom':
      return {
        left: r.left + pad,
        top: r.top + r.height * 0.5 + pad,
        width: Math.max(0, r.width - pad * 2),
        height: Math.max(0, r.height * 0.5 - pad * 2),
      };
    case 'tab-strip':
    default:
      return {
        left: r.left + pad,
        top: r.top + pad,
        width: Math.max(0, r.width - pad * 2),
        height: Math.max(0, r.height - pad * 2),
      };
  }
}

/**
 * 几何五分法纯函数计算
 */
export function computePaneDropKind(
  p: { x: number; y: number },
  rect: RectLike,
  minWidth = MIN_DOCK_SPLIT_WIDTH,
  minHeight = MIN_DOCK_SPLIT_HEIGHT
): DockDropKind {
  const w = rect.width > 0 ? rect.width : 1;
  const h = rect.height > 0 ? rect.height : 1;
  const rx = (p.x - rect.left) / w;
  const ry = (p.y - rect.top) / h;

  let kind: DockDropKind = 'tab-strip';

  const isLeft = rx < DOCK_SPLIT_EDGE_RATIO;
  const isRight = rx > 1 - DOCK_SPLIT_EDGE_RATIO;
  const isTop = ry < DOCK_SPLIT_EDGE_RATIO;
  const isBottom = ry > 1 - DOCK_SPLIT_EDGE_RATIO;

  if (isLeft || isRight || isTop || isBottom) {
    const distLeft = rx;
    const distRight = 1 - rx;
    const distTop = ry;
    const distBottom = 1 - ry;

    const minHorizontal = Math.min(distLeft, distRight);
    const minVertical = Math.min(distTop, distBottom);

    if (minHorizontal <= minVertical) {
      kind = distLeft < distRight ? 'split-left' : 'split-right';
    } else {
      kind = distTop < distBottom ? 'split-top' : 'split-bottom';
    }
  }

  // 尺寸下限守卫：宽度 < 240px 禁止水平切分，高度 < 160px 禁止垂直切分
  if (
    (kind === 'split-left' || kind === 'split-right') &&
    rect.width < minWidth
  ) {
    kind = 'tab-strip';
  } else if (
    (kind === 'split-top' || kind === 'split-bottom') &&
    rect.height < minHeight
  ) {
    kind = 'tab-strip';
  }

  return kind;
}

/**
 * 右坞落点探测入口函数
 *
 * @param p 指针视口坐标 { x, y }
 * @param dockRootEl 当前会话右坞抽屉根容器 DOM（.leafDockDrawer 或 .dockSplitWorkspace）
 * @param source 正在拖拽的标签信息 { sourceLeafId, tabId }
 * @param options 可选配置（如尺寸阈值）
 */
export function detectDockDropZone(
  p: { x: number; y: number },
  dockRootEl: HTMLElement | null,
  source: DockDragSourceInfo,
  options?: DetectDockDropZoneOptions
): DockDropTarget | null {
  if (!dockRootEl) return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;

  // ── 刚性防线 1：物理硬围栏校验 ──
  const dockRect = dockRootEl.getBoundingClientRect();
  if (
    dockRect.width <= 0 ||
    dockRect.height <= 0 ||
    p.x < dockRect.left ||
    p.x > dockRect.right ||
    p.y < dockRect.top ||
    p.y > dockRect.bottom
  ) {
    // 移出右坞边界（如拖至顶栏或左侧聊天区）立即短路！绝不触碰任何顶栏 DOM！
    return null;
  }

  const minWidth = options?.minSplitWidth ?? MIN_DOCK_SPLIT_WIDTH;
  const minHeight = options?.minSplitHeight ?? MIN_DOCK_SPLIT_HEIGHT;

  // ── 刚性防线 2：优先探测子窗格微型 TabStrip ──
  const strips = Array.from(
    dockRootEl.querySelectorAll<HTMLElement>(
      '[data-dock-tab-strip="true"], [data-leaf-tool-tab-strip="true"], [data-tab-strip-leaf-id]'
    )
  );

  for (const strip of strips) {
    const sRect = strip.getBoundingClientRect();
    if (sRect.width <= 0 || sRect.height <= 0) continue;
    if (
      p.x >= sRect.left &&
      p.x <= sRect.right &&
      p.y >= sRect.top - 6 &&
      p.y <= sRect.bottom + 8
    ) {
      const targetLeafId =
        strip.getAttribute('data-dock-leaf-id') ||
        strip.getAttribute('data-tab-strip-leaf-id') ||
        strip.getAttribute('data-pane-id') ||
        '';
      if (!targetLeafId) continue;

      const cached = collectStripTabs(strip, source.tabId, 'data-tab-id');
      const insertIdx = computeSessionTabInsertIndex(cached.tabs, p.x, 0);

      return {
        kind: 'tab-strip',
        targetDockLeafId: targetLeafId,
        insertIndex: insertIdx,
        indicatorRect: {
          left: sRect.left,
          top: sRect.top,
          width: sRect.width,
          height: sRect.height,
        },
      };
    }
  }

  // ── 刚性防线 3：探测子窗格内容区（几何五分法 + 尺寸下限守卫） ──
  const paneCandidates = Array.from(
    dockRootEl.querySelectorAll<HTMLElement>(
      '[data-dock-leaf-id], [data-leaf-id]'
    )
  ).filter((el) => {
    // 排除 strip 自身
    return (
      !el.hasAttribute('data-leaf-tool-tab-strip') &&
      !el.hasAttribute('data-dock-tab-strip')
    );
  });

  // 按 DOM 深度倒序优先匹配最内层叶片
  const panes = paneCandidates.reverse();

  for (const pane of panes) {
    const r = pane.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom) {
      continue;
    }

    const leafId =
      pane.getAttribute('data-dock-leaf-id') ||
      pane.getAttribute('data-leaf-id') ||
      '';
    if (!leafId) continue;

    const kind = computePaneDropKind(p, r, minWidth, minHeight);
    const indicatorRect = computeDockIndicatorRect(kind, r);

    return {
      kind,
      targetDockLeafId: leafId,
      indicatorRect,
    };
  }

  return null;
}
