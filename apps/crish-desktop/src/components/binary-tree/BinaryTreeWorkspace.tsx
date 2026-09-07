/**
 * 二叉树工作区 — 拖拽式布局工作区主入口。
 *
 * 渲染流程：
 * 1. layoutTreeStore → flattenTree（树上只有 chat 叶，不传 collapsedDomain）
 * 2. leaf chrome：
 *    - 会话身份在本叶 PaneHeader ← leaf.tabs / activeTabId
 *    - 工具条是叶内抽屉头 LeafToolTabStrip，树上无 tool 叶
 *    - 侧栏只列会话，不拥有打开集
 *    - UnitChromeActions 仍是对话列覆盖层
 * 3. sash / sessionTabIndicator / 面板 resize
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useLayoutTreeStore,
  flattenTree,
  listChatLeaves,
  type LayoutLeaf,
  type FlatBranch,
} from '../../store/storeAccess';
import { useTreeResize } from '../../hooks/useTreeResize';
import { useTreePanelEvents } from '../../hooks/useTreePanelEvents';
import { useChatPanelSync } from '../../hooks/useChatPanelSync';
import { readTokenMs, DURATION_FAST_MS } from '../../utils/motionTokens';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { TreeLeafPanel } from './TreeLeafPanel';
import { TreeResizeSash, flatBranchEqual } from './TreeResizeSash';
import styles from './BinaryTreeWorkspace.module.css';

export interface BinaryTreeWorkspaceProps {
  className?: string;
}

// flattenTree 每次产出新 FlatPanel / FlatBranch / rect 字面量；按 id 复用引用。

type FlatPanelItem = ReturnType<typeof flattenTree>['leaves'][number];
type LeafRect = FlatPanelItem['rect'];

interface StableLeafEntry {
  leaf: LayoutLeaf;
  rect: LeafRect;
}

function dockIdentityEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const da = a as {
    collapsed?: boolean;
    activePanelId?: string | null;
    openPanelIds?: string[];
    widthRatio?: number;
  };
  const db = b as typeof da;
  if (da.collapsed !== db.collapsed) return false;
  if (da.activePanelId !== db.activePanelId) return false;
  if (da.widthRatio !== db.widthRatio) return false;
  const pa = da.openPanelIds ?? [];
  const pb = db.openPanelIds ?? [];
  if (pa.length !== pb.length) return false;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) return false;
  }
  return true;
}

function tabsIdentityEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as { tabId?: string; dock?: unknown } | string;
    const y = b[i] as { tabId?: string; dock?: unknown } | string;
    if (x === y) continue;
    if (
      typeof x === 'object' &&
      typeof y === 'object' &&
      x &&
      y &&
      x.tabId === y.tabId &&
      dockIdentityEqual(x.dock, y.dock)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function rectEqual(a: LeafRect, b: LeafRect): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

function readPanelActiveTabId(panel: FlatPanelItem): string {
  return panel.activeTabId ?? '';
}

function toLayoutLeaf(panel: FlatPanelItem): LayoutLeaf {
  const activeTabId = readPanelActiveTabId(panel);
  return {
    type: 'leaf',
    id: panel.leafId,
    panelId: 'chat',
    tabs: panel.tabs,
    activeTabId,
    dock: panel.dock,
  };
}

function stabilizeLeafEntries(
  panels: FlatPanelItem[],
  prev: Map<string, StableLeafEntry>
): Map<string, StableLeafEntry> {
  const next = new Map<string, StableLeafEntry>();
  for (const panel of panels) {
    const cached = prev.get(panel.leafId);
    const activeTabId = readPanelActiveTabId(panel);
    const cachedActive = cached
      ? (cached.leaf as LayoutLeaf & { activeTabId?: string }).activeTabId
      : undefined;
    let leaf: LayoutLeaf;
    if (
      cached &&
      cachedActive === activeTabId &&
      tabsIdentityEqual(cached.leaf.tabs, panel.tabs) &&
      dockIdentityEqual(cached.leaf.dock, panel.dock)
    ) {
      leaf = cached.leaf;
    } else {
      leaf = toLayoutLeaf(panel);
    }

    const rect =
      cached && rectEqual(cached.rect, panel.rect) ? cached.rect : panel.rect;

    next.set(panel.leafId, { leaf, rect });
  }
  return next;
}

function stabilizeBranches(
  branches: FlatBranch[],
  prev: Map<string, FlatBranch>
): Map<string, FlatBranch> {
  const next = new Map<string, FlatBranch>();
  for (const branch of branches) {
    const cached = prev.get(branch.branchId);
    next.set(
      branch.branchId,
      cached && flatBranchEqual(cached, branch) ? cached : branch
    );
  }
  return next;
}

export const BinaryTreeWorkspace: React.FC<BinaryTreeWorkspaceProps> =
  React.memo(() => {
    const tree = useLayoutTreeStore((s) => s.tree);
    const activeLeafId = useLayoutTreeStore((s) => s.activeLeafId);

    const canvasRef = useRef<HTMLDivElement>(null);
    const resizeController = useTreeResize();
    useTreePanelEvents();
    useChatPanelSync();

    const {
      leaves: panels,
      branches,
      isMultiChat,
    } = React.useMemo(() => {
      const multi = listChatLeaves(tree.root).length > 1;
      const result = flattenTree(tree.root);
      return { ...result, isMultiChat: multi };
    }, [tree.root]);

    const leafEntryCacheRef = useRef<Map<string, StableLeafEntry>>(new Map());
    const stableLeafEntries = React.useMemo(() => {
      const next = stabilizeLeafEntries(panels, leafEntryCacheRef.current);
      leafEntryCacheRef.current = next;
      return next;
    }, [panels]);

    const branchCacheRef = useRef<Map<string, FlatBranch>>(new Map());
    const stableBranches = React.useMemo(() => {
      const next = stabilizeBranches(branches, branchCacheRef.current);
      branchCacheRef.current = next;
      return next;
    }, [branches]);

    const { startResize, resizingBranchId } = resizeController;

    // 叶子几何过渡门控：仅树结构变更（叶/分支集合变化）时短暂开启，
    // 窗口 resize 等纯 rect 变化不启用，杜绝整树橡皮筋滞后
    const structureSignature = React.useMemo(
      () =>
        `${panels.map((p) => p.leafId).join('|')}#${branches
          .map((b) => b.branchId)
          .join('|')}`,
      [panels, branches]
    );
    const [structureAnimating, setStructureAnimating] = useState(false);
    const prevStructureRef = React.useRef(structureSignature);
    const structureTimerRef = React.useRef<number | null>(null);
    useEffect(() => {
      if (prevStructureRef.current === structureSignature) return;
      prevStructureRef.current = structureSignature;
      setStructureAnimating(true);
      if (structureTimerRef.current != null) {
        window.clearTimeout(structureTimerRef.current);
      }
      const ms = readTokenMs('--transition-fast', DURATION_FAST_MS) * 2;
      structureTimerRef.current = window.setTimeout(() => {
        structureTimerRef.current = null;
        setStructureAnimating(false);
      }, ms);
    }, [structureSignature]);
    useEffect(
      () => () => {
        if (structureTimerRef.current != null) {
          window.clearTimeout(structureTimerRef.current);
        }
      },
      []
    );

    return (
      <div className={styles.section} data-tree-workspace="true">
        <AppErrorBoundary compact>
          <div
            ref={canvasRef}
            className={`${styles.canvas} ${styles.treeBody}`}
            data-tree-canvas="true"
            data-structure-animating={
              structureAnimating ? 'true' : undefined
            }
            role="group"
            aria-label="二叉树布局画布"
          >
            {panels.map((panel) => {
              const entry = stableLeafEntries.get(panel.leafId)!;
              return (
                <TreeLeafPanel
                  key={panel.leafId}
                  leaf={entry.leaf}
                  rect={entry.rect}
                  isActive={panel.leafId === activeLeafId}
                  isMultiChat={isMultiChat}
                />
              );
            })}

            {branches.map((branch) => {
              const stable = stableBranches.get(branch.branchId) ?? branch;
              return (
                <TreeResizeSash
                  key={branch.branchId}
                  branch={stable}
                  startResize={startResize}
                  isResizing={resizingBranchId === branch.branchId}
                />
              );
            })}
          </div>
        </AppErrorBoundary>
      </div>
    );
  });
BinaryTreeWorkspace.displayName = 'BinaryTreeWorkspace';
