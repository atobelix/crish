/**
 * 右坞工具 tab 拖拽控制器。
 *
 * 职责：
 * - 同坞重排：更新 session.rightDock.openPanelIds 顺序 + applyDockToTree
 * - 同 unit 内 split / merge：复用 layoutTreeStore.commitDrop + DropZoneOverlay
 * - 禁止落在其它 session 的 unit / chat 域
 *
 * 与 useTreeDrag / useTopBarDrag 独立维护 phase；共享 store 的
 * draggedSource / activeDropZone 以复用 DropZoneOverlay。
 * Ghost 自建 portal（BinaryTreeWorkspace ghost 绑定 useTreeDrag.isDragging）。
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

// ── 常量 ────────────────────────────────────────────────────────────

const DRAG_THRESHOLD_PX = 5;
const GHOST_OFFSET_X = 16;
const GHOST_OFFSET_Y = 16;
const DROP_DETECT_INTERVAL_MS = 16;

// ── 类型 ────────────────────────────────────────────────────────────

interface PendingDrag {
  panelId: string;
  title: string;
  startX: number;
  startY: number;
  pointerId: number;
}

interface ActiveDrag {
  panelId: string;
  title: string;
  leafId: string;
  currentX: number;
  currentY: number;
  pointerId: number;
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
  const phaseRef = useRef<'idle' | 'pending' | 'active' | 'committed' | 'cancelled'>(
    'idle'
  );
  const pendingRef = useRef<PendingDrag | null>(null);
  const activeRef = useRef<ActiveDrag | null>(null);
  const cachedLeafRectsRef = useRef<LeafRectItem[]>([]);
  const allowedLeafIdsRef = useRef<Set<string>>(new Set());
  const lastZoneRef = useRef<DropZone | null>(null);
  const lastIntentRef = useRef<DropIntent | null>(null);
  const lastDropDetectRef = useRef(0);
  const didDragRef = useRef(false);

  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ghostPosRef = useRef<{ x: number; y: number } | null>(null);

  const [isDragging, setIsDragging] = useState(false);
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

  const applyGhostPos = useCallback(() => {
    const el = ghostRef.current;
    const pos = ghostPosRef.current;
    if (el && pos) {
      el.style.transform = `translate(${pos.x}px, ${pos.y}px) rotate(1.5deg)`;
    }
  }, []);

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

  const startTabDrag = useCallback(
    (panelId: string, title: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (phaseRef.current !== 'idle') return;
      // 关闭按钮 / 交互控件上不启动
      const t = e.target;
      if (t instanceof Element && t.closest('[data-no-tab-drag="true"]')) {
        return;
      }
      pendingRef.current = {
        panelId,
        title,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
      };
      phaseRef.current = 'pending';
      didDragRef.current = false;
    },
    []
  );

  const enterActive = useCallback(
    (clientX: number, clientY: number) => {
      const pending = pendingRef.current;
      if (!pending) return;

      const srcLeafId = resolveSourceLeafId(pending.panelId);
      if (!srcLeafId) {
        pendingRef.current = null;
        phaseRef.current = 'idle';
        return;
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

      const active: ActiveDrag = {
        panelId: pending.panelId,
        title: pending.title,
        leafId: srcLeafId,
        currentX: clientX,
        currentY: clientY,
        pointerId: pending.pointerId,
      };
      activeRef.current = active;
      pendingRef.current = null;
      phaseRef.current = 'active';
      lastZoneRef.current = null;
      lastIntentRef.current = null;
      lastDropDetectRef.current = 0;
      didDragRef.current = true;

      ghostPosRef.current = {
        x: clientX + GHOST_OFFSET_X,
        y: clientY + GHOST_OFFSET_Y,
      };
      setGhostLabel(pending.title);
      setDraggingPanelId(pending.panelId);
      setIsDragging(true);

      setDraggedSource({
        type: 'tab',
        leafId: srcLeafId,
        tabId: pending.panelId,
        panelId: pending.panelId,
      });
    },
    [resolveSourceLeafId, setDraggedSource]
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const phase = phaseRef.current;
      if (phase === 'idle' || phase === 'committed' || phase === 'cancelled') {
        return;
      }

      if (phase === 'pending') {
        const pending = pendingRef.current;
        if (!pending || e.pointerId !== pending.pointerId) return;
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        enterActive(e.clientX, e.clientY);
      } else {
        const active = activeRef.current;
        if (!active || e.pointerId !== active.pointerId) return;
      }

      const active = activeRef.current;
      if (!active) return;
      active.currentX = e.clientX;
      active.currentY = e.clientY;
      ghostPosRef.current = {
        x: e.clientX + GHOST_OFFSET_X,
        y: e.clientY + GHOST_OFFSET_Y,
      };
      applyGhostPos();

      const now = performance.now();
      if (now - lastDropDetectRef.current < DROP_DETECT_INTERVAL_MS) return;
      lastDropDetectRef.current = now;

      const sid = (optionsRef.current.ownerSessionId || '').trim();
      const pointer = { x: e.clientX, y: e.clientY };

      // 1) 优先：同 session 坞内 tab 重排（指针在 tab 条上）
      const dockTab = findDockTabAt(pointer, sid, active.panelId);
      if (dockTab) {
        const beforeId = dockTab.dataset.panelId || '';
        if (beforeId) {
          lastIntentRef.current = {
            kind: 'reorder',
            beforePanelId: beforeId,
          };
          // 用 merge-tab 覆盖源 leaf，给 DropZoneOverlay 一个弱反馈
          updateZone({
            type: 'merge-tab',
            targetLeafId: active.leafId,
            targetTabId: beforeId,
            confidence: 1,
          });
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
      if (hit.id === active.leafId && hit.tabCount <= 1) {
        // 单 tab 无法在自身 split
        if (zone.type !== 'merge-tab') {
          zone = { type: 'merge-tab', targetLeafId: hit.id, confidence: 1 };
        }
      }
      lastIntentRef.current = { kind: 'zone', zone };
      updateZone(zone);
    },
    [enterActive, applyGhostPos, updateZone]
  );

  const clearDragUi = useCallback(() => {
    activeRef.current = null;
    pendingRef.current = null;
    cachedLeafRectsRef.current = [];
    allowedLeafIdsRef.current = new Set();
    ghostPosRef.current = null;
    lastZoneRef.current = null;
    lastIntentRef.current = null;
    phaseRef.current = 'idle';
    setIsDragging(false);
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

  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      const phase = phaseRef.current;
      if (phase === 'idle') return;

      const expectedPointerId =
        pendingRef.current?.pointerId ?? activeRef.current?.pointerId;
      if (
        expectedPointerId !== undefined &&
        e.pointerId !== expectedPointerId
      ) {
        return;
      }

      if (phase === 'pending') {
        pendingRef.current = null;
        phaseRef.current = 'idle';
        return;
      }

      const active = activeRef.current;
      const intent = lastIntentRef.current;
      const zone = lastZoneRef.current;
      const sid = (optionsRef.current.ownerSessionId || '').trim();

      if (phase === 'active' && active) {
        phaseRef.current = 'committed';

        if (intent?.kind === 'reorder') {
          // 坞内重排：不走 commitDrop（避免误 merge）
          cancelDragStore();
          commitReorder(active.panelId, intent.beforePanelId);
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
          zone.targetLeafId !== active.leafId &&
          allowedLeafIdsRef.current.has(zone.targetLeafId)
        ) {
          // 跨 tool leaf 合并 tab（同 unit）
          commitDrop();
          if (sid) bindNewToolLeaves(sid);
        } else if (
          zone &&
          zone.type === 'merge-tab' &&
          zone.targetLeafId === active.leafId
        ) {
          // 同 leaf merge：仅激活（顺序未通过 tab 条指示则不改）
          cancelDragStore();
          const opt = optionsRef.current;
          updateRightDock(opt.tabId, {
            activePanelId: active.panelId,
            collapsed: false,
          });
        } else {
          cancelDragStore();
        }
      }

      clearDragUi();
      // 清理 store 拖拽态（commitDrop 已清；其它路径靠 cancel 或补刀）
      const st = getCompositionRoot().tree.getState();
      if (st.draggedSource || st.activeDropZone) {
        cancelDragStore();
      }
    },
    [
      cancelDragStore,
      commitDrop,
      commitReorder,
      bindNewToolLeaves,
      updateRightDock,
      clearDragUi,
    ]
  );

  const handlePointerCancel = useCallback(() => {
    if (phaseRef.current === 'idle') return;
    phaseRef.current = 'cancelled';
    cancelDragStore();
    clearDragUi();
  }, [cancelDragStore, clearDragUi]);

  const setGhostRef = useCallback(
    (el: HTMLDivElement | null) => {
      ghostRef.current = el;
      if (el && ghostPosRef.current) applyGhostPos();
    },
    [applyGhostPos]
  );

  const consumeDidDrag = useCallback(() => {
    const v = didDragRef.current;
    didDragRef.current = false;
    return v;
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handlePointerCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [handlePointerMove, handlePointerUp, handlePointerCancel]);

  useEffect(() => {
    if (isDragging) {
      document.body.classList.add('tool-dock-tab-dragging');
    } else {
      document.body.classList.remove('tool-dock-tab-dragging');
    }
    return () => document.body.classList.remove('tool-dock-tab-dragging');
  }, [isDragging]);

  // 拖拽中 viewport resize：重收集 leaf rect
  useEffect(() => {
    if (!isDragging) return;
    const onResize = () => {
      cachedLeafRectsRef.current = collectUnitToolLeafRects(
        allowedLeafIdsRef.current
      );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isDragging]);

  // 卸载兜底
  useEffect(() => {
    return () => {
      if (phaseRef.current === 'active' || phaseRef.current === 'pending') {
        getCompositionRoot().tree.getState().cancelDrag();
      }
    };
  }, []);

  return {
    isDragging,
    draggingPanelId,
    ghostLabel,
    setGhostRef,
    startTabDrag,
    consumeDidDrag,
  };
}
