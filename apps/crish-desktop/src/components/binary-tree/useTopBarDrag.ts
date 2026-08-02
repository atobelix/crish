/**
 * 会话标签条拖拽控制器（D5；历史名 useTopBarDrag）。
 *
 * 挂载点：App 层 SessionTabDragProvider → GlobalSessionTabBar（AppTopBar 第 1 行）。
 *
 * 壳 hook：手势基座装配 + 拖拽源/落点 zone 状态 + 拖拽启动入口。
 * 能力拆分：条内重排见 useSessionTabReorder；画布 split 落点见 useCanvasDropPlanner；
 * 落点规划纯函数见 topBarDragLib；类型/常量见 topBarDragTypes / topBarDragConst。
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
import {
  detectDropZone,
  isZoneSame,
  useLayoutTreeStore,
  findLeafAtPointer,
  isChatDomain,
  type DropZone,
} from '../../store/layout-tree';
import type { TreeDragSource } from '../../store/layout-tree';
import {
  usePointerDragBase,
  DROP_DETECT_INTERVAL_MS,
} from '../../hooks/usePointerDragBase';
import {
  TOP_BAR_DRAG_BODY_CLASS,
  SESSION_DRAG_GHOST_PANEL_ID,
} from './topBarDragConst';
import type { LeafRectItem, TopBarDragSource } from './topBarDragTypes';
import {
  collectLeafRects,
  findChatLeafAt,
  findSessionTabAt,
} from './topBarDragLib';
import { useSessionTabReorder } from './useSessionTabReorder';
import { useCanvasDropPlanner } from './useCanvasDropPlanner';

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

  const { commitSessionReorder } = useSessionTabReorder({ refreshTabs });
  const { commitSessionSplit } = useCanvasDropPlanner({ refreshTabs });

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

  // ── 手势基座（阈值 / phase / pointerId 隔离 / ghost / 监听） ──

  const base = usePointerDragBase<TopBarDragSource>({
    bodyClass: TOP_BAR_DRAG_BODY_CLASS,
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
          panelId: SESSION_DRAG_GHOST_PANEL_ID,
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
