/**
 * 会话标签条拖拽控制器（D5；历史名 useTopBarDrag）。
 *
 * 挂载点：App 层 SessionTabDragProvider → GlobalSessionTabBar（AppTopBar 第 1 行）。
 *
 * 职责：
 * - 会话标签：条内拖拽排序（reorderSessionTab → openTabs 顺序）
 * - 拖到画布 split 区：planSessionCanvasDrop
 *   - 以 Conversation Unit root（H(chat|tools)）为锚点 move/create
 *   - 禁止只移 chat leaf 导致 tool 变成全局孤儿列
 * - 功能标签（legacy startToolDrag）：复用 layoutTreeStore 拖拽语义
 *
 * 与 useTreeDrag 的区别：
 * - useTreeDrag：面板 leaf/tab handle 启动
 * - 本 hook：GlobalSessionTabBar 会话 tab 启动，额外处理条带内重排 + 会话分屏
 *
 * 手势机制（阈值 / phase / pointerId 隔离 / ghost / 监听）收敛到
 * `usePointerDragBase`（PE-06 T06.8 组 3），本 hook 只保留 drop 语义差异层。
 */

import { useCallback, useRef, useState } from 'react';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  useLayoutTreeStore,
  findLeafAtPointer,
  rectFromDOM,
  detectDropZone,
  isZoneSame,
  isChatDomain,
  collectLeaves,
  findNodeById,
  findChatLeafBySessionId,
  findUnitRootId,
  type DropZone,
  type Rect,
} from '../../store/layout-tree';
import {
  findParent,
  insertLeafBesideNode,
  moveNode,
} from '../../store/layout-tree/operations';
import type { DropDirection, LayoutNode } from '../../store/layout-tree/types';
import type { TreeDragSource } from '../../store/layout-tree';
import {
  usePointerDragBase,
  DROP_DETECT_INTERVAL_MS,
} from '../../hooks/usePointerDragBase';

/** 延迟加载，避免 useTopBarDrag ↔ adapterShape 在 HMR 时形成循环依赖导致缺导出崩溃 */
function reprojectAllSessionDocksSafe(): void {
  void import('../../store/workspace-shell/adapterShape')
    .then((m) => {
      if (typeof m.reprojectAllSessionDocks === 'function') {
        m.reprojectAllSessionDocks();
      }
    })
    .catch(() => {
      /* ignore */
    });
}

// ── 拖拽源类型 ───────────────────────────────────────────────────────

type TopBarDragSource =
  | { kind: 'session'; sessionId: string; title: string }
  | { kind: 'tool'; leafId: string; tabId: string; panelId: string; title: string };

interface LeafRectItem {
  id: string;
  panelId: string;
  tabCount: number;
  rect: Rect;
}

// ── Hook 签名 ───────────────────────────────────────────────────────

export interface UseTopBarDragResult {
  /** 当前是否处于拖拽中 */
  isDragging: boolean;
  /** 启动会话标签拖拽 */
  startSessionDrag: (
    sessionId: string,
    title: string,
    e: React.PointerEvent
  ) => void;
  /** 启动功能标签拖拽 */
  startToolDrag: (
    leafId: string,
    tabId: string,
    panelId: string,
    title: string,
    e: React.PointerEvent
  ) => void;
  /** Ghost 元素回调 ref */
  setGhostRef: (el: HTMLDivElement | null) => void;
  /** 当前 ghost 标签文本 */
  ghostLabel: string | null;
}

// ── 工具：收集画布 leaf rects ───────────────────────────────────────

function collectLeafRects(): LeafRectItem[] {
  const container = document.querySelector(
    '[data-tree-canvas="true"]'
  ) as HTMLElement | null;
  if (!container) return [];
  const leafEls = container.querySelectorAll<HTMLElement>('[data-leaf-id]');
  const result: LeafRectItem[] = [];
  leafEls.forEach((el) => {
    const id = el.dataset.leafId;
    const panelId = el.dataset.panelId || 'chat';
    const tabCount = parseInt(el.dataset.tabCount || '1', 10);
    if (!id) return;
    result.push({ id, panelId, tabCount, rect: rectFromDOM(el.getBoundingClientRect()) });
  });
  return result;
}

/** 找到指针下方的会话标签元素（忽略 ghost / overlay 等 pointer-events 干扰） */
function findSessionTabAt(pointer: { x: number; y: number }): HTMLElement | null {
  // 临时隐藏 ghost 避免命中测试干扰
  const ghosts = document.querySelectorAll<HTMLElement>('.topbar-drag-ghost');
  ghosts.forEach((g) => (g.style.pointerEvents = 'none'));

  // elementsFromPoint：即便有半透明层覆盖，也能找到 session tab
  const stack =
    typeof document.elementsFromPoint === 'function'
      ? (document.elementsFromPoint(pointer.x, pointer.y) as Element[])
      : ([document.elementFromPoint(pointer.x, pointer.y)].filter(
          Boolean
        ) as Element[]);

  ghosts.forEach((g) => (g.style.pointerEvents = ''));

  for (const node of stack) {
    if (!(node instanceof HTMLElement)) continue;
    // 跳过 ghost / drop overlay
    if (
      node.classList.contains('topbar-drag-ghost') ||
      node.closest('.topbar-drag-ghost')
    ) {
      continue;
    }
    const tab = node.closest<HTMLElement>('[data-topbar-session-id]');
    if (tab) return tab;
  }
  return null;
}

/** 找到指针下方的第一个 chat leaf */
function findChatLeafAt(
  pointer: { x: number; y: number },
  leafRects: LeafRectItem[]
): LeafRectItem | null {
  const chatRects = leafRects.filter((l) => isChatDomain(l.panelId));
  return findLeafAtPointer(pointer, chatRects);
}

// ── 会话落点决策（纯函数，保证 1 session ↔ 0..1 chat leaf） ──────────

/** split zone → DropDirection */
function splitZoneToDirection(zoneType: DropZone['type']): DropDirection | null {
  switch (zoneType) {
    case 'split-left':
      return 'left';
    case 'split-right':
      return 'right';
    case 'split-top':
      return 'top';
    case 'split-bottom':
      return 'bottom';
    default:
      return null;
  }
}

/**
 * 源 leaf 是否已在目标 leaf 的指定侧（直接兄弟 + 方向匹配）。
 * 已在正确侧时再 drop 只应 focus，避免无意义 move。
 */
function isAlreadyAdjacentOnSide(
  root: LayoutNode,
  sourceLeafId: string,
  targetLeafId: string,
  direction: DropDirection
): boolean {
  const parentInfo = findParent(root, targetLeafId);
  if (!parentInfo) return false;
  const { parent, index } = parentInfo;
  const sibling = parent.children[index === 0 ? 1 : 0];
  if (sibling.id !== sourceLeafId) return false;

  if (direction === 'left') {
    return parent.direction === 'horizontal' && parent.children[0].id === sourceLeafId;
  }
  if (direction === 'right') {
    return parent.direction === 'horizontal' && parent.children[1].id === sourceLeafId;
  }
  if (direction === 'top') {
    return parent.direction === 'vertical' && parent.children[0].id === sourceLeafId;
  }
  if (direction === 'bottom') {
    return parent.direction === 'vertical' && parent.children[1].id === sourceLeafId;
  }
  return false;
}

/**
 * 会话标签拖到画布 split 区的决策计划。
 *
 * - 已有 chat leaf → activate 或 move（绝不 clone）
 * - 尚无 leaf → create（split + 绑定一次）
 */
export type SessionCanvasDropPlan =
  | { action: 'activate'; leafId: string }
  | {
      action: 'move';
      sourceLeafId: string;
      targetLeafId: string;
      direction: DropDirection;
    }
  | {
      action: 'create';
      targetLeafId: string;
      direction: DropDirection;
      /** 目标 leaf 无 session 时，是否需要先绑 shell active */
      targetNeedsShellBind: boolean;
    }
  | { action: 'none' };

/**
 * 会话落点锚点 = Conversation Unit root（H(chat|tools) 或 chat-only），
 * 禁止锚到 unit 内部的 chat leaf（会把 tools 拆成全局孤儿列）。
 */
export function resolveSessionUnitAnchorId(
  root: LayoutNode,
  chatLeafId: string,
  sessionId?: string | null
): string {
  const sid = (sessionId || '').trim();
  if (sid) {
    const unitId = findUnitRootId(root, sid);
    if (unitId) return unitId;
  }
  const leaf = findNodeById(root, chatLeafId);
  if (leaf && leaf.type === 'leaf' && isChatDomain(leaf.panelId) && leaf.sessionId) {
    const unitId = findUnitRootId(root, leaf.sessionId);
    if (unitId) return unitId;
  }
  return chatLeafId;
}

export function planSessionCanvasDrop(
  root: LayoutNode,
  sourceSessionId: string,
  zone: DropZone
): SessionCanvasDropPlan {
  const direction = splitZoneToDirection(zone.type);
  if (!direction) return { action: 'none' };

  const targetLeafId = zone.targetLeafId;
  const targetNode = findNodeById(root, targetLeafId);
  if (
    !targetNode ||
    targetNode.type !== 'leaf' ||
    !isChatDomain(targetNode.panelId)
  ) {
    return { action: 'none' };
  }

  // 锚到目标 unit root（含其右坞 tools），而不是 unit 内 chat leaf
  const targetAnchorId = resolveSessionUnitAnchorId(
    root,
    targetLeafId,
    targetNode.sessionId
  );

  const existing = findChatLeafBySessionId(root, sourceSessionId);
  if (existing) {
    const sourceAnchorId = resolveSessionUnitAnchorId(
      root,
      existing.id,
      sourceSessionId
    );
    // 落点即自身 / 目标已是该 session / 已在指定侧 → 仅激活
    if (
      existing.id === targetLeafId ||
      sourceAnchorId === targetAnchorId ||
      targetNode.sessionId === sourceSessionId ||
      isAlreadyAdjacentOnSide(root, sourceAnchorId, targetAnchorId, direction)
    ) {
      return { action: 'activate', leafId: existing.id };
    }
    // 已有 unit 在别处 → 整 unit（chat+tools）移到目标 unit 旁
    return {
      action: 'move',
      sourceLeafId: sourceAnchorId,
      targetLeafId: targetAnchorId,
      direction,
    };
  }

  // 尚无 leaf：在目标 unit 旁创建 chat（一次性）
  return {
    action: 'create',
    targetLeafId: targetAnchorId,
    direction,
    targetNeedsShellBind: !targetNode.sessionId,
  };
}

// ── Hook 实现 ───────────────────────────────────────────────────────

export function useTopBarDrag(
  _folderKey: string,
  refreshTabs: () => void
): UseTopBarDragResult {
  const cachedLeafRectsRef = useRef<LeafRectItem[]>([]);
  const lastZoneRef = useRef<DropZone | null>(null);
  const lastDropDetectRef = useRef(0);

  const [ghostLabel, setGhostLabel] = useState<string | null>(null);

  const setDraggedSource = useLayoutTreeStore((s) => s.setDraggedSource);
  const setActiveDropZone = useLayoutTreeStore((s) => s.setActiveDropZone);
  const commitDrop = useLayoutTreeStore((s) => s.commitDrop);
  const setActiveLeaf = useLayoutTreeStore((s) => s.setActiveLeaf);
  const setLeafSessionId = useLayoutTreeStore((s) => s.setLeafSessionId);

  const updateZone = useCallback(
    (zone: DropZone | null) => {
      if (isZoneSame(lastZoneRef.current, zone)) return;
      lastZoneRef.current = zone;
      setActiveDropZone(zone);
    },
    [setActiveDropZone]
  );

  const toTreeDragSource = useCallback(
    (src: TopBarDragSource): TreeDragSource | null => {
      if (src.kind === 'tool') {
        return {
          type: 'tab',
          leafId: src.leafId,
          tabId: src.tabId,
          panelId: src.panelId,
        };
      }
      return null;
    },
    []
  );

  const commitSessionReorder = useCallback(
    (sourceSessionId: string, targetSessionId?: string) => {
      // 顶栏真相源：shell.openTabs；legacy map 在 reorderSessionTab 内同步
      getCompositionRoot()
        .shell.getState()
        .reorderSessionTab(sourceSessionId, targetSessionId ?? null);
      refreshTabs();
    },
    [refreshTabs]
  );

  /** 激活 chat leaf + shell 切到对应 session（drop 后统一收尾） */
  const activateSessionOnLeaf = useCallback(
    (leafId: string, sourceSessionId: string) => {
      setActiveLeaf(leafId);
      const shell = getCompositionRoot().shell.getState();
      const existing = shell.openTabs.find((t) => t.sessionId === sourceSessionId);
      if (existing) {
        shell.activateTab(existing.tabId);
      } else {
        shell.openOrFocusSession(sourceSessionId);
      }
      refreshTabs();
    },
    [setActiveLeaf, refreshTabs]
  );

  /**
   * 会话标签拖到 chat 画布 split 区：
   * - 已有该 session 的 unit → 整 unit（chat+其 tools）MOVE 或 ACTIVATE
   * - 尚无 leaf → 在目标 unit 旁创建 chat 并绑定 sessionId
   * 保证 1 session ↔ 0..1 chat leaf，且 tools 不脱离对话 unit。
   */
  const commitSessionSplit = useCallback(
    (sourceSessionId: string, zone: DropZone) => {
      const store = getCompositionRoot().tree.getState();
      const plan = planSessionCanvasDrop(
        store.tree.root,
        sourceSessionId,
        zone
      );

      if (plan.action === 'none') return;

      if (plan.action === 'activate') {
        activateSessionOnLeaf(plan.leafId, sourceSessionId);
        return;
      }

      if (plan.action === 'move') {
        // 整 unit 移到目标 unit 旁（sourceLeafId 实为 unit root id）
        const next = moveNode(
          store.tree,
          plan.sourceLeafId,
          plan.targetLeafId,
          plan.direction
        );
        if (next !== store.tree) {
          store.pushHistory();
          store.setTree(next);
        }
        const chat = findChatLeafBySessionId(
          getCompositionRoot().tree.getState().tree.root,
          sourceSessionId
        );
        activateSessionOnLeaf(chat?.id ?? plan.sourceLeafId, sourceSessionId);
        // 纠偏：若历史树里曾有孤儿 tool，按 shell dock 重投影
        reprojectAllSessionDocksSafe();
        return;
      }

      // ── create：在目标 unit 旁新建 chat leaf（不拆 unit 内 chat|tool） ─
      const shell = getCompositionRoot().shell.getState();
      const shellSid =
        shell.openTabs.find((t) => t.tabId === shell.activeTabId)?.sessionId ??
        null;

      // 目标 unit 内 chat 未绑定时，先绑 shell active
      if (
        plan.targetNeedsShellBind &&
        shellSid &&
        shellSid !== sourceSessionId
      ) {
        const targetChat =
          findChatLeafBySessionId(store.tree.root, shellSid) ??
          collectLeaves(store.tree.root).find(
            (l) => isChatDomain(l.panelId) && l.id === plan.targetLeafId
          );
        if (targetChat && !targetChat.sessionId) {
          setLeafSessionId(targetChat.id, shellSid);
        }
      }

      const beforeIds = new Set(
        collectLeaves(getCompositionRoot().tree.getState().tree.root).map(
          (l) => l.id
        )
      );

      const treeNow = getCompositionRoot().tree.getState().tree;
      const inserted = insertLeafBesideNode(
        treeNow,
        plan.targetLeafId,
        plan.direction,
        'chat',
        sourceSessionId,
        0.5
      );
      if (inserted !== treeNow) {
        store.pushHistory();
        store.setTree(inserted);
      }

      const after = getCompositionRoot().tree.getState();
      const newLeaf = collectLeaves(after.tree.root).find(
        (l) => isChatDomain(l.panelId) && !beforeIds.has(l.id)
      );
      if (newLeaf) {
        if (newLeaf.sessionId !== sourceSessionId) {
          setLeafSessionId(newLeaf.id, sourceSessionId);
        }
        activateSessionOnLeaf(newLeaf.id, sourceSessionId);
      } else {
        activateSessionOnLeaf(plan.targetLeafId, sourceSessionId);
      }
      reprojectAllSessionDocksSafe();
    },
    [setLeafSessionId, activateSessionOnLeaf]
  );

  // ── 手势基座（阈值 / phase / pointerId 隔离 / ghost / 监听） ──

  const base = usePointerDragBase<TopBarDragSource>({
    bodyClass: 'topbar-dragging',
    onDragStart: (source) => {
      cachedLeafRectsRef.current = collectLeafRects();
      lastZoneRef.current = null;
      lastDropDetectRef.current = 0;
      setGhostLabel(source.title);

      if (source.kind === 'tool') {
        const treeSrc = toTreeDragSource(source);
        if (treeSrc) setDraggedSource(treeSrc);
      } else {
        // 会话标签拖拽：用特殊 draggedSource（panelId='chat'）让 DropZoneOverlay 能渲染 ghost
        setDraggedSource({
          type: 'tab',
          leafId: source.sessionId,
          tabId: source.sessionId,
          panelId: 'chat',
        });
      }
    },
    onDragMove: (source, clientX, clientY) => {
      const now = performance.now();
      if (now - lastDropDetectRef.current < DROP_DETECT_INTERVAL_MS) return;
      lastDropDetectRef.current = now;

      if (source.kind === 'tool') {
        const leafRects = cachedLeafRectsRef.current;
        const hit = findLeafAtPointer({ x: clientX, y: clientY }, leafRects);
        if (
          !hit ||
          isChatDomain(source.panelId) !== isChatDomain(hit.panelId)
        ) {
          updateZone(null);
          return;
        }
        if (source.leafId === hit.id) {
          // 同 leaf：若只有 1 个 tab 只能 merge-tab（重排），否则正常检测
          if (hit.tabCount <= 1) {
            updateZone({ type: 'merge-tab', targetLeafId: hit.id, confidence: 1 });
            return;
          }
        }
        updateZone(detectDropZone({ x: clientX, y: clientY }, hit.rect, hit.id));
      } else {
        // 会话标签：优先检测是否悬停在另一个会话标签上（重排）
        const tabEl = findSessionTabAt({ x: clientX, y: clientY });
        if (tabEl) {
          const targetId = tabEl.dataset.topbarSessionId;
          if (targetId && targetId !== source.sessionId) {
            updateZone({
              type: 'merge-tab',
              targetLeafId: `session-tab-${targetId}`,
              confidence: 1,
              targetTabId: targetId,
            });
            return;
          }
          // 悬停在自身标签上：清除 zone
          if (targetId === source.sessionId) {
            updateZone(null);
            return;
          }
        }
        // 拖到 chat 画布：显示 split 落点（多 chat 分屏）
        const leafRects = cachedLeafRectsRef.current;
        const hit = findChatLeafAt(
          { x: clientX, y: clientY },
          leafRects
        );
        if (!hit) {
          updateZone(null);
          return;
        }
        updateZone(
          detectDropZone({ x: clientX, y: clientY }, hit.rect, hit.id)
        );
      }
    },
    onDrop: (source) => {
      const zone = lastZoneRef.current;

      if (source.kind === 'tool') {
        // 功能标签：直接复用 store commitDrop
        commitDrop();
      } else if (zone) {
        if (zone.type === 'merge-tab' && zone.targetTabId) {
          commitSessionReorder(source.sessionId, zone.targetTabId);
        } else if (zone.type.startsWith('split-')) {
          commitSessionSplit(source.sessionId, zone);
        }
      }
      setDraggedSource(null);
      setActiveDropZone(null);
    },
    onCancel: () => {
      setDraggedSource(null);
      setActiveDropZone(null);
    },
    onGestureEnd: () => {
      cachedLeafRectsRef.current = [];
      lastZoneRef.current = null;
      setGhostLabel(null);
    },
  });

  // ── 拖拽启动 ──────────────────────────────────────────────────

  const startSessionDrag = useCallback(
    (sessionId: string, title: string, e: React.PointerEvent) => {
      base.start({ kind: 'session', sessionId, title }, e);
    },
    [base]
  );

  const startToolDrag = useCallback(
    (
      leafId: string,
      tabId: string,
      panelId: string,
      title: string,
      e: React.PointerEvent
    ) => {
      base.start({ kind: 'tool', leafId, tabId, panelId, title }, e);
    },
    [base]
  );

  return {
    isDragging: base.isDragging,
    startSessionDrag,
    startToolDrag,
    setGhostRef: base.setGhostRef,
    ghostLabel,
  };
}
