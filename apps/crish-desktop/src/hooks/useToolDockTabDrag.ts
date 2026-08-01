/**
 * 右坞工具 tab 拖拽控制器。
 *
 * 职责：
 * - 同坞重排：更新 session.rightDock.openPanelIds 顺序 + applyDockToTree
 * - 同 unit 内 split / merge：复用 layoutTreeStore.commitDrop + DropZoneOverlay
 * - 禁止落在其它 session 的 unit / chat 域
 *
 * 与 useTreeDrag / useTopBarDrag 共享 `usePointerDragBase`（PE-06 T06.8 组 3）
 * 的 phase 状态机 / 阈值 / pointerId 隔离 / ghost 跟随 / 监听注册；
 * 各自只保留 drop 语义差异层。共享 store 的 draggedSource / activeDropZone
 * 以复用 DropZoneOverlay。Ghost 自建 portal。
 *
 * @see docs/plans/2026-07-conversation-unit-shell.md R2 B2
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCompositionRoot } from '../app/compositionRoot';
import {
  useLayoutTreeStore,
  detectDropZone,
  findLeafAtPointer,
  rectFromDOM,
  isZoneSame,
  isChatDomain,
  collectLeaves,
  type DropZone,
  type Rect,
} from '../store/layout-tree';
import {
  applyDockToTree,
  useWorkspaceShellStore,
} from '../store/workspace-shell';
import {
  findToolLeafIdForPanel,
  listToolLeafIdsInUnit,
  reorderOpenPanelIds,
} from './toolDockTabOrder';
import {
  usePointerDragBase,
  DROP_DETECT_INTERVAL_MS,
} from './usePointerDragBase';

// ── 类型 ────────────────────────────────────────────────────────────

interface DockDragPayload {
  panelId: string;
  title: string;
}

interface LeafRectItem {
  id: string;
  panelId: string;
  tabCount: number;
  rect: Rect;
}

/** 落点意图：坞内 tab 重排 vs 树 drop zone */
type DropIntent =
  | { kind: 'reorder'; beforePanelId: string }
  | { kind: 'zone'; zone: DropZone };

export interface UseToolDockTabDragOptions {
  /** 当前 tool leaf id（header 挂载处；实际源 leaf 以 panel 归属为准） */
  leafId?: string;
  /** 所属会话；多 unit 时必填，用于 unit 作用域 */
  ownerSessionId?: string;
  /** shell tabId，用于 updateRightDock */
  tabId: string;
  /** 当前 openPanelIds（闭包快照；drop 时也会再读 store） */
  openPanelIds: readonly string[];
}

export interface UseToolDockTabDragResult {
  isDragging: boolean;
  /** 正在拖的 panelId（active 阶段） */
  draggingPanelId: string | null;
  ghostLabel: string | null;
  setGhostRef: (el: HTMLDivElement | null) => void;
  /** pointerdown 启动；close 按钮需 stopPropagation */
  startTabDrag: (
    panelId: string,
    title: string,
    e: React.PointerEvent
  ) => void;
  /** 本轮手势是否超过阈值（抑制 click） */
  consumeDidDrag: () => boolean;
}

// ── DOM 辅助 ────────────────────────────────────────────────────────

function collectUnitToolLeafRects(allowedIds: Set<string>): LeafRectItem[] {
  const container = document.querySelector(
    '[data-tree-canvas="true"]'
  ) as HTMLElement | null;
  if (!container) return [];
  const leafEls = container.querySelectorAll<HTMLElement>('[data-leaf-id]');
  const result: LeafRectItem[] = [];
  leafEls.forEach((el) => {
    const id = el.dataset.leafId;
    if (!id || !allowedIds.has(id)) return;
    const panelId = el.dataset.panelId || 'overview';
    if (isChatDomain(panelId)) return;
    const tabCount = parseInt(el.dataset.tabCount || '1', 10);
    result.push({
      id,
      panelId,
      tabCount,
      rect: rectFromDOM(el.getBoundingClientRect()),
    });
  });
  return result;
}

/**
 * 命中右坞 tab（同 owner session）。
 * 临时关闭 ghost pointer-events，避免挡 elementsFromPoint。
 */
function findDockTabAt(
  pointer: { x: number; y: number },
  ownerSessionId: string,
  excludePanelId?: string
): HTMLElement | null {
  const ghosts = document.querySelectorAll<HTMLElement>(
    '[data-tool-dock-ghost="true"]'
  );
  ghosts.forEach((g) => {
    g.style.pointerEvents = 'none';
  });

  const stack =
    typeof document.elementsFromPoint === 'function'
      ? (document.elementsFromPoint(pointer.x, pointer.y) as Element[])
      : ([document.elementFromPoint(pointer.x, pointer.y)].filter(
          Boolean
        ) as Element[]);

  ghosts.forEach((g) => {
    g.style.pointerEvents = '';
  });

  for (const node of stack) {
    if (!(node instanceof HTMLElement)) continue;
    const tab = node.closest<HTMLElement>('[data-tool-dock-tab]');
    if (!tab) continue;
    const sid = tab.dataset.ownerSession || '';
    if (sid && ownerSessionId && sid !== ownerSessionId) continue;
    const pid = tab.dataset.panelId || '';
    if (excludePanelId && pid === excludePanelId) continue;
    if (!pid) continue;
    return tab;
  }
  return null;
}

// ── Hook ────────────────────────────────────────────────────────────

export function useToolDockTabDrag(
  options: UseToolDockTabDragOptions
): UseToolDockTabDragResult {
  const cachedLeafRectsRef = useRef<LeafRectItem[]>([]);
  const allowedLeafIdsRef = useRef<Set<string>>(new Set());
  /** 已解析的源 leaf id（enterActive 时确定，drop 分支区分同 leaf merge） */
  const sourceLeafIdRef = useRef<string | null>(null);
  const lastZoneRef = useRef<DropZone | null>(null);
  const lastIntentRef = useRef<DropIntent | null>(null);
  const lastDropDetectRef = useRef(0);

  const [ghostLabel, setGhostLabel] = useState<string | null>(null);
  const [draggingPanelId, setDraggingPanelId] = useState<string | null>(null);

  const setDraggedSource = useLayoutTreeStore((s) => s.setDraggedSource);
  const setActiveDropZone = useLayoutTreeStore((s) => s.setActiveDropZone);
  const commitDrop = useLayoutTreeStore((s) => s.commitDrop);
  const cancelDragStore = useLayoutTreeStore((s) => s.cancelDrag);
  const setLeafSessionId = useLayoutTreeStore((s) => s.setLeafSessionId);
  const updateRightDock = useWorkspaceShellStore((s) => s.updateRightDock);

  // 选项用 ref，避免 pointer handler 因 openPanelIds 每次渲染失效
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const updateZone = useCallback(
    (zone: DropZone | null) => {
      if (isZoneSame(lastZoneRef.current, zone)) return;
      lastZoneRef.current = zone;
      setActiveDropZone(zone);
    },
    [setActiveDropZone]
  );

  const resolveSourceLeafId = useCallback(
    (panelId: string): string | null => {
      const sid = (optionsRef.current.ownerSessionId || '').trim();
      const tree = getCompositionRoot().tree.getState().tree;
      if (sid) {
        const found = findToolLeafIdForPanel(tree.root, sid, panelId);
        if (found) return found;
      }
      // 回退：header 所在 leaf，或树中任意含该 tab 的 tool leaf
      if (optionsRef.current.leafId) return optionsRef.current.leafId;
      const hit = collectLeaves(tree.root).find(
        (l) => !isChatDomain(l.panelId) && l.tabs.includes(panelId)
      );
      return hit?.id ?? null;
    },
    []
  );

  const clearDragUi = useCallback(() => {
    cachedLeafRectsRef.current = [];
    allowedLeafIdsRef.current = new Set();
    sourceLeafIdRef.current = null;
    lastZoneRef.current = null;
    lastIntentRef.current = null;
    setGhostLabel(null);
    setDraggingPanelId(null);
  }, []);

  const commitReorder = useCallback(
    (fromPanelId: string, beforePanelId: string) => {
      const opt = optionsRef.current;
      const shell = getCompositionRoot().shell.getState();
      const tab =
        shell.openTabs.find((t) => t.tabId === opt.tabId) ??
        shell.openTabs.find((t) => t.sessionId === opt.ownerSessionId);
      if (!tab) return;

      const currentIds = tab.rightDock.openPanelIds;
      const nextIds = reorderOpenPanelIds(
        currentIds,
        fromPanelId,
        beforePanelId
      );
      if (nextIds === currentIds) {
        // 仅切换激活
        if (tab.rightDock.activePanelId !== fromPanelId) {
          updateRightDock(tab.tabId, { activePanelId: fromPanelId });
        }
        return;
      }
      const dock = {
        ...tab.rightDock,
        openPanelIds: nextIds,
        activePanelId: fromPanelId,
        collapsed: false,
      };
      updateRightDock(tab.tabId, {
        openPanelIds: nextIds,
        activePanelId: fromPanelId,
        collapsed: false,
      });
      // updateRightDock 内部已 applyDockToTree；显式再调一次保证 session 绑定
      applyDockToTree(dock, tab.sessionId || opt.ownerSessionId);
    },
    [updateRightDock]
  );

  /** commitDrop 后把本 unit 内尚无 sessionId 的 tool leaf 绑上 owner */
  const bindNewToolLeaves = useCallback(
    (sessionId: string) => {
      const sid = (sessionId || '').trim();
      if (!sid) return;
      const tree = getCompositionRoot().tree.getState().tree;
      const unitIds = listToolLeafIdsInUnit(tree.root, sid);
      for (const id of unitIds) {
        const node = collectLeaves(tree.root).find((l) => l.id === id);
        if (node && !node.sessionId) {
          setLeafSessionId(id, sid);
        }
      }
    },
    [setLeafSessionId]
  );

  // ── 手势基座（阈值 / phase / pointerId 隔离 / ghost / 监听） ──

  const base = usePointerDragBase<DockDragPayload>({
    bodyClass: 'tool-dock-tab-dragging',
    onDragStart: (payload) => {
      const srcLeafId = resolveSourceLeafId(payload.panelId);
      if (!srcLeafId) {
        // 源 leaf 不可解析：中止手势（不进入 active）
        return false;
      }

      const sid = (optionsRef.current.ownerSessionId || '').trim();
      const tree = getCompositionRoot().tree.getState().tree;
      const allowed = sid
        ? listToolLeafIdsInUnit(tree.root, sid)
        : new Set(
            collectLeaves(tree.root)
              .filter((l) => !isChatDomain(l.panelId))
              .map((l) => l.id)
          );
      // 确保源 leaf 在允许集合内
      allowed.add(srcLeafId);
      allowedLeafIdsRef.current = allowed;
      cachedLeafRectsRef.current = collectUnitToolLeafRects(allowed);
      sourceLeafIdRef.current = srcLeafId;

      lastZoneRef.current = null;
      lastIntentRef.current = null;
      lastDropDetectRef.current = 0;

      setGhostLabel(payload.title);
      setDraggingPanelId(payload.panelId);

      setDraggedSource({
        type: 'tab',
        leafId: srcLeafId,
        tabId: payload.panelId,
        panelId: payload.panelId,
      });
    },
    onDragMove: (payload, clientX, clientY) => {
      const now = performance.now();
      if (now - lastDropDetectRef.current < DROP_DETECT_INTERVAL_MS) return;
      lastDropDetectRef.current = now;

      const sid = (optionsRef.current.ownerSessionId || '').trim();
      const pointer = { x: clientX, y: clientY };
      const sourceLeafId = sourceLeafIdRef.current;

      // 1) 优先：同 session 坞内 tab 重排（指针在 tab 条上）
      const dockTab = findDockTabAt(pointer, sid, payload.panelId);
      if (dockTab) {
        const beforeId = dockTab.dataset.panelId || '';
        if (beforeId) {
          lastIntentRef.current = {
            kind: 'reorder',
            beforePanelId: beforeId,
          };
          // 用 merge-tab 覆盖源 leaf，给 DropZoneOverlay 一个弱反馈
          if (sourceLeafId) {
            updateZone({
              type: 'merge-tab',
              targetLeafId: sourceLeafId,
              targetTabId: beforeId,
              confidence: 1,
            });
          }
          return;
        }
      }

      // 2) 同 unit tool leaf 上的 split / merge
      const hit = findLeafAtPointer(pointer, cachedLeafRectsRef.current);
      if (!hit || !allowedLeafIdsRef.current.has(hit.id)) {
        lastIntentRef.current = null;
        updateZone(null);
        return;
      }
      if (isChatDomain(hit.panelId)) {
        lastIntentRef.current = null;
        updateZone(null);
        return;
      }

      let zone = detectDropZone(pointer, hit.rect, hit.id);
      if (hit.id === sourceLeafId && hit.tabCount <= 1) {
        // 单 tab 无法在自身 split
        if (zone.type !== 'merge-tab') {
          zone = { type: 'merge-tab', targetLeafId: hit.id, confidence: 1 };
        }
      }
      lastIntentRef.current = { kind: 'zone', zone };
      updateZone(zone);
    },
    onDrop: (payload, _clientX, _clientY, _cancelled) => {
      const intent = lastIntentRef.current;
      const zone = lastZoneRef.current;
      const sid = (optionsRef.current.ownerSessionId || '').trim();
      const sourceLeafId = sourceLeafIdRef.current;

      if (intent?.kind === 'reorder') {
        // 坞内重排：不走 commitDrop（避免误 merge）
        cancelDragStore();
        commitReorder(payload.panelId, intent.beforePanelId);
      } else if (zone && zone.type !== 'merge-tab') {
        // split：同 unit tool 域
        if (allowedLeafIdsRef.current.has(zone.targetLeafId)) {
          commitDrop();
          if (sid) bindNewToolLeaves(sid);
        } else {
          cancelDragStore();
        }
      } else if (
        zone &&
        zone.type === 'merge-tab' &&
        zone.targetLeafId !== sourceLeafId &&
        allowedLeafIdsRef.current.has(zone.targetLeafId)
      ) {
        // 跨 tool leaf 合并 tab（同 unit）
        commitDrop();
        if (sid) bindNewToolLeaves(sid);
      } else if (
        zone &&
        zone.type === 'merge-tab' &&
        zone.targetLeafId === sourceLeafId
      ) {
        // 同 leaf merge：仅激活（顺序未通过 tab 条指示则不改）
        cancelDragStore();
        updateRightDock(optionsRef.current.tabId, {
          activePanelId: payload.panelId,
          collapsed: false,
        });
      } else {
        cancelDragStore();
      }

      // 清理 store 拖拽态（commitDrop 已清；其它路径靠 cancel 或补刀）
      const st = getCompositionRoot().tree.getState();
      if (st.draggedSource || st.activeDropZone) {
        cancelDragStore();
      }
    },
    onCancel: () => {
      cancelDragStore();
    },
    onGestureEnd: () => {
      clearDragUi();
    },
  });

  // ── 拖拽启动 ──────────────────────────────────────────────────

  const startTabDrag = useCallback(
    (panelId: string, title: string, e: React.PointerEvent) => {
      // 关闭按钮 / 交互控件上不启动
      const t = e.target;
      if (t instanceof Element && t.closest('[data-no-tab-drag="true"]')) {
        return;
      }
      base.start({ panelId, title }, e);
    },
    [base]
  );

  // 卸载兜底：手势进行中强制清 store 拖拽态
  useEffect(() => {
    return () => {
      if (base.isActive()) {
        getCompositionRoot().tree.getState().cancelDrag();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 拖拽中 viewport resize：重收集 leaf rect
  useEffect(() => {
    if (!base.isDragging) return;
    const onResize = () => {
      cachedLeafRectsRef.current = collectUnitToolLeafRects(
        allowedLeafIdsRef.current
      );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [base.isDragging]);

  return {
    isDragging: base.isDragging,
    draggingPanelId,
    ghostLabel,
    setGhostRef: base.setGhostRef,
    startTabDrag,
    consumeDidDrag: base.consumeDidDrag,
  };
}
