/**
 * tab 拖拽几何快照子模块（从 useTabDragEvents.ts 拆出，降低 hub 行数）。
 *
 * 职责：pointerdown 时一次性快照卡片 tab 栏几何，move / drop 路径只读缓存。
 * 纯 DOM 测量，无 React / hook 依赖。
 *
 * hub（useTabDragEvents.ts）通过 import 保持调用关系；接口类型随此模块导出，
 * 供 hub 与 reorder 子模块复用。
 */

import { resolveTabBarHeight } from './tabDragGeometry';
import type { TabBarTabRect } from './tabDragTypes';
import type { CardSnapshot } from './useTabDragReorder';

export interface TabBarGeometrySnapshot {
  tabBarH: number;
  tabsBar: HTMLElement | null;
  tabRects: TabBarTabRect[];
  barRight: number;
}

/**
 * 快照单张卡片的 tab 栏几何：tab 栏高度、tabs-bar 元素、各 tab 矩形、栏右边界。
 */
export function snapshotTabBarGeometry(cardEl: HTMLElement): TabBarGeometrySnapshot {
  const header = cardEl.querySelector('.card-header');
  const tabsBarCandidate = cardEl.querySelector('.tabs-bar');
  const tabsBar =
    tabsBarCandidate instanceof HTMLElement ? tabsBarCandidate : null;

  let measuredH: number | null = null;
  if (header instanceof HTMLElement) {
    measuredH = header.getBoundingClientRect().height;
  } else if (tabsBar) {
    measuredH = tabsBar.getBoundingClientRect().height;
  }
  const tabBarH = resolveTabBarHeight(measuredH);

  let tabRects: TabBarTabRect[] = [];
  let barRight = 0;
  if (tabsBar) {
    barRight = tabsBar.getBoundingClientRect().right;
    const tabs = Array.from(
      tabsBar.querySelectorAll(
        '.card-tab:not(.dragging-tab-hidden):not(.tab-placeholder-indicator)'
      )
    ).filter((el): el is HTMLElement => el instanceof HTMLElement);
    tabRects = tabs.map((t) => {
      const tr = t.getBoundingClientRect();
      return { left: tr.left, width: tr.width };
    });
  }

  return { tabBarH, tabsBar, tabRects, barRight };
}

/** pointerdown 一次性快照，move / drop 路径只读缓存 */
export interface TabDragPayload {
  cardId: string;
  wsId: string;
  groupId: string;
  cardsLength: number;
  isDragFromTabButton: boolean;
  /** pointerdown 的 e.currentTarget（tab 元素） */
  targetEl: HTMLElement;
  sourceCard: HTMLElement | null;
  cardSnapshots: CardSnapshot[];
  clickOffsetX: number;
  clickOffsetY: number;
  startWidth: number;
  startHeight: number;
}

/**
 * 从工作区卡片集合构造拖拽快照：每张卡片的 rect + tab 栏几何 + 列/组/组 id。
 */
export function buildCardSnapshots(
  cardElements: HTMLElement[],
): CardSnapshot[] {
  return cardElements.map((el) => {
    const r = el.getBoundingClientRect();
    const barGeom = snapshotTabBarGeometry(el);
    return {
      element: el,
      rect: {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      },
      colIdx: parseInt(el.getAttribute('data-col-idx') || '0', 10),
      groupIdx: parseInt(el.getAttribute('data-group-idx') || '0', 10),
      groupId: el.getAttribute('data-group-id') || '',
      tabBarH: barGeom.tabBarH,
      tabsBar: barGeom.tabsBar,
      tabRects: barGeom.tabRects,
      barRight: barGeom.barRight,
    };
  });
}
