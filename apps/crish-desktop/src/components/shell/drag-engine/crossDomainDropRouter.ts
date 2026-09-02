/**
 * crossDomainDropRouter.ts — 跨域视口空间索引落点探测器
 * 
 * 职责：根据光标全局坐标 (clientX, clientY) 与位移 (dx, dy)，
 * 判定着陆目标域（侧栏 / 顶栏 TabStrip / 窗格分屏 PaneSplit / 游离态）。
 */

import type { LayoutTree } from '../../../store/layout-tree/types';
import {
  detectPaneDropRegion,
  type PaneDropRegion,
} from '../sessionTabDragFeel';
import { evaluateSessionSplitGuard } from './sessionDragGuard';

export type CrossDomainTarget =
  | {
      domain: 'sidebar';
      sectionEl: HTMLElement;
      sectionKind: 'pinned' | 'general' | 'project';
      folder: string;
      insertIndex: number;
      targetSessionId: string | null;
      isPinned: boolean;
    }
  | {
      domain: 'tab-strip';
      targetLeafId: string;
      stripEl: HTMLElement;
      insertIndex: number;
    }
  | {
      domain: 'pane-split';
      targetLeafId: string;
      region: PaneDropRegion;
      paneRect: { left: number; top: number; width: number; height: number };
    }
  | {
      domain: 'outside';
    };

export function resolveCrossDomainTarget(
  clientX: number,
  clientY: number,
  dx: number,
  dy: number,
  draggedSessionId: string,
  tree: LayoutTree
): CrossDomainTarget {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit) return { domain: 'outside' };

  // 1. 优先探测是否命中顶栏 TabStrip
  const toolStrip = hit.closest('[data-leaf-tool-tab-strip]');
  const stripWrap = !toolStrip ? (hit.closest('[data-pane-header="true"]') as HTMLElement | null) : null;
  const tabStrip = stripWrap ? (stripWrap.querySelector('[role="tablist"]') as HTMLElement | null) : null;

  if (tabStrip && stripWrap) {
    const targetLeafId = stripWrap.closest('[data-leaf-id]')?.getAttribute('data-leaf-id') || '';
    if (targetLeafId) {
      return {
        domain: 'tab-strip',
        targetLeafId,
        stripEl: tabStrip,
        insertIndex: 0, // 由调用方依据 strip DOM 计算
      };
    }
  }

  // 2. 探测是否命中窗格内容区 (PaneCanvas)
  const paneLeaf = hit.closest('[data-tree-canvas="true"] [data-leaf-id]') as HTMLElement | null;
  if (paneLeaf) {
    const leafId = paneLeaf.getAttribute('data-leaf-id') || '';
    const r = paneLeaf.getBoundingClientRect();
    const region = detectPaneDropRegion(clientX, clientY, {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    });

    if (region && leafId) {
      // 执行互斥守门判定
      const guard = evaluateSessionSplitGuard(tree, draggedSessionId, leafId, region);
      if (guard.allowed) {
        return {
          domain: 'pane-split',
          targetLeafId: leafId,
          region,
          paneRect: { left: r.left, top: r.top, width: r.width, height: r.height },
        };
      }
    }
  }

  // 3. 探测是否位于侧栏区域
  const sidebarRoot = hit.closest('[data-sidebar-root="true"]') as HTMLElement | null;
  if (sidebarRoot) {
    return {
      domain: 'sidebar',
      sectionEl: sidebarRoot,
      sectionKind: 'general',
      folder: '',
      insertIndex: 0,
      targetSessionId: null,
      isPinned: false,
    };
  }

  return { domain: 'outside' };
}
