import React from 'react';
import { closeAgentSidePanel } from '../../api/openAgentPanel';
import { getWorkspaceStoreState, setDropPreview } from '../../store/workspaceStore';
import type { DropType } from './tabDragGeometry';
import {
  animateOverlayAway,
  clearDropIndicator,
  createCardDragOverlay,
  createTabDragOverlay,
  setDragOverlayPosition,
} from './tabDragGhost';
import {
  useTabDragReorder,
  type CardSnapshot,
} from './useTabDragReorder';
import { buildCardSnapshots, type TabDragPayload } from './tabDragSnapshot';
import { usePointerDragBase } from '../usePointerDragBase';

export interface UseTabDragOptions {
  wsId: string;
  groupId: string;
  cardsLength: number;
}

export function useTabDragEvents({
  wsId,
  groupId,
  cardsLength,
}: UseTabDragOptions) {
  const { setDraggedTab, closeTabInGroup, evaluateMoveDrop, commitTabDrop } =
    useTabDragReorder();

  // 手势进行中的状态（ref，避免 re-render）
  const finishedRef = React.useRef(false);
  const draggingRef = React.useRef(false);
  const dragOverlayRef = React.useRef<HTMLDivElement | null>(null);
  const rafIdRef = React.useRef<number | null>(null);
  const pendingClientXRef = React.useRef(0);
  const pendingClientYRef = React.useRef(0);
  const hasPendingMoveRef = React.useRef(false);
  const captureElRef = React.useRef<HTMLElement | null>(null);
  const wsIdRef = React.useRef(wsId);
  wsIdRef.current = wsId;

  const lastDropTypeRef = React.useRef<DropType | null>(null);
  const lastTargetColIdxRef = React.useRef(0);
  const lastTargetGroupIdxRef = React.useRef<number | undefined>(undefined);
  const lastTargetGroupIdRef = React.useRef<string | null>(null);
  const lastTabInsertIdxRef = React.useRef<number | undefined>(undefined);

  const cancelPendingRaf = () => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  };

  const detachListeners = () => {
    const el = captureElRef.current;
    if (el) {
      el.removeEventListener('lostpointercapture', handleLostCapture);
      captureElRef.current = null;
      try {
        if (el.hasPointerCapture?.(lastPointerIdRef.current)) {
          el.releasePointerCapture(lastPointerIdRef.current);
        }
      } catch {
        /* ignore */
      }
    }
  };

  const lastPointerIdRef = React.useRef(0);

  /** 统一收尾（幂等）：取消 rAF、解绑 lostpointercapture、清 drop 指示 */
  const cleanupGesture = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    cancelPendingRaf();
    detachListeners();
    clearDropIndicator(wsIdRef.current);
    setDropPreview(null);
    if (dragOverlayRef.current) {
      dragOverlayRef.current.remove();
      dragOverlayRef.current = null;
    }
    document.body.classList.remove('dragging-card');
  };

  const processMove = React.useCallback(
    (payload: TabDragPayload, clientX: number, clientY: number) => {
      if (finishedRef.current) return;
      const overlay = dragOverlayRef.current;
      if (!overlay) return;

      // compositor 友好：transform，不写 left/top
      setDragOverlayPosition(
        overlay,
        clientX - payload.clickOffsetX,
        clientY - payload.clickOffsetY
      );

      const resolved = evaluateMoveDrop({
        mouseX: clientX,
        mouseY: clientY,
        cardSnapshots: payload.cardSnapshots,
        wsId: payload.wsId,
        sourceGroupId: payload.groupId,
        cardsLength: payload.cardsLength,
        isDragFromTabButton: payload.isDragFromTabButton,
        cardId: payload.cardId,
      });

      if (!resolved) {
        clearDropIndicator(payload.wsId);
        lastDropTypeRef.current = null;
        return;
      }

      lastDropTypeRef.current = resolved.dropType;
      lastTargetColIdxRef.current = resolved.targetColIdx;
      lastTargetGroupIdxRef.current = resolved.targetGroupIdx;
      lastTargetGroupIdRef.current = resolved.targetGroupId;
      lastTabInsertIdxRef.current = resolved.tabInsertIdx;
    },
    [evaluateMoveDrop]
  );

  /** 提交（drop / pointercancel 共用；cancelled 语义与 commitTabDrop 对齐） */
  const commitDropNow = React.useCallback(
    (payload: TabDragPayload, cancelled: boolean) => {
      if (!draggingRef.current) return;

      const latestDraggedTab = getWorkspaceStoreState().draggedTab;
      const latestSourceGroupId =
        latestDraggedTab?.sourceGroupId ?? payload.groupId;

      setDraggedTab(null);

      const { destGroupId } = commitTabDrop({
        wsId: payload.wsId,
        cardId: payload.cardId,
        sourceGroupId: latestSourceGroupId,
        lastDropType: lastDropTypeRef.current,
        cancelled,
        lastTargetGroupId: lastTargetGroupIdRef.current,
        lastTargetColIdx: lastTargetColIdxRef.current,
        lastTargetGroupIdx: lastTargetGroupIdxRef.current,
        lastTabInsertIdx: lastTabInsertIdxRef.current,
      });

      const overlay = dragOverlayRef.current;
      dragOverlayRef.current = null;
      if (overlay) {
        animateOverlayAway(overlay, payload.cardId, destGroupId);
      } else {
        document.body.classList.remove('dragging-card');
      }
      draggingRef.current = false;
    },
    [commitTabDrop, setDraggedTab]
  );

  const handleLostCapture = React.useCallback(() => {
    // capture 丢失：按取消收尾（带 cancelled 标记提交，与旧实现一致）
    baseRef.current?.endGesture(true);
  }, []);

  // 基座引用（在 hook 内定义后回填，供 lostpointercapture 使用）
  const baseRef = React.useRef<{
    endGesture: (cancelled?: boolean, clientX?: number, clientY?: number) => void;
  } | null>(null);

  const base = usePointerDragBase<TabDragPayload>({
    // 卡片拖拽自建 DOM overlay（tabDragGhost），不走基座 ghost 跟随
    followGhost: false,
    // 旧实现无 Escape 取消（卡片拖拽由 capture 收尾）
    handleEscape: false,
    onDragStart: (payload) => {
      draggingRef.current = true;
      finishedRef.current = false;
      setDraggedTab({
        cardId: payload.cardId,
        sourceGroupId: payload.groupId,
        workspaceId: payload.wsId,
        isTabDrag: payload.isDragFromTabButton,
      });

      if (payload.isDragFromTabButton) {
        dragOverlayRef.current = createTabDragOverlay(payload.targetEl);
      } else if (payload.sourceCard) {
        dragOverlayRef.current = createCardDragOverlay(
          payload.sourceCard,
          payload.startWidth,
          payload.startHeight
        );
      }
    },
    onDragMove: (payload, clientX, clientY) => {
      pendingClientXRef.current = clientX;
      pendingClientYRef.current = clientY;
      hasPendingMoveRef.current = true;
      if (rafIdRef.current != null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (!hasPendingMoveRef.current || finishedRef.current) return;
        hasPendingMoveRef.current = false;
        processMove(payload, pendingClientXRef.current, pendingClientYRef.current);
      });
    },
    onDrop: (payload, clientX, clientY, cancelled) => {
      // 提交前取消 rAF；若有未刷帧或已在拖，用最终坐标再评估一次
      cancelPendingRaf();
      if (draggingRef.current || hasPendingMoveRef.current) {
        hasPendingMoveRef.current = false;
        processMove(payload, clientX, clientY);
      }
      commitDropNow(payload, cancelled);
    },
    onCancel: (payload) => {
      // pointercancel：与旧 finishPointer(cancelled=true) 语义一致
      cancelPendingRaf();
      if (payload && draggingRef.current) {
        if (hasPendingMoveRef.current) {
          hasPendingMoveRef.current = false;
          processMove(payload, pendingClientXRef.current, pendingClientYRef.current);
        }
        commitDropNow(payload, true);
      }
    },
    onGestureEnd: () => {
      cleanupGesture();
    },
  });
  baseRef.current = base;

  const handleTabPointerDown = React.useCallback(
    (e: React.PointerEvent, cardId: string) => {
      if (e.button === 1) {
        // Middle click: close tab / active card in group
        if (cardId !== 'chat') {
          e.preventDefault();
          e.stopPropagation();
          if (cardId === 'agent') {
            closeAgentSidePanel(wsId, groupId);
          } else {
            closeTabInGroup(wsId, groupId, cardId);
          }
        }
        return;
      }
      if (e.button !== 0) return;
      const eventTarget = e.target;
      if (
        eventTarget instanceof HTMLElement &&
        eventTarget.closest('.tab-close-btn')
      )
        return;

      if (!(e.currentTarget instanceof HTMLElement)) return;
      const targetEl = e.currentTarget;
      const isDragFromTabButton = targetEl.classList.contains('card-tab');
      const sourceCardCandidate = targetEl.closest('.workspace-card');
      const sourceCard =
        sourceCardCandidate instanceof HTMLElement
          ? sourceCardCandidate
          : null;
      const pointerId = e.pointerId;
      lastPointerIdRef.current = pointerId;

      try {
        targetEl.setPointerCapture(pointerId);
      } catch {
        /* fallback to window listener */
      }

      // pointerdown 时一次性快照卡片/tab 栏几何，move 路径只读缓存
      const cardElements = Array.from(
        document.querySelectorAll(
          '.workspace-card:not(.placeholder-card-group)'
        )
      ).filter((el): el is HTMLElement => el instanceof HTMLElement);
      const cardSnapshots: CardSnapshot[] = buildCardSnapshots(cardElements);

      const cardRect = sourceCard ? sourceCard.getBoundingClientRect() : null;
      const tabRect = targetEl ? targetEl.getBoundingClientRect() : null;
      const startWidth = cardRect ? cardRect.width : 0;
      const startHeight = cardRect ? cardRect.height : 0;
      const clickOffsetX =
        isDragFromTabButton && tabRect
          ? e.clientX - tabRect.left
          : cardRect
            ? e.clientX - cardRect.left
            : 0;
      const clickOffsetY =
        isDragFromTabButton && tabRect
          ? e.clientY - tabRect.top
          : cardRect
            ? e.clientY - cardRect.top
            : 0;

      // 手势状态复位（幂等：上次手势已由 cleanupGesture 收尾）
      finishedRef.current = false;
      draggingRef.current = false;
      dragOverlayRef.current = null;
      lastDropTypeRef.current = null;
      lastTargetColIdxRef.current = 0;
      lastTargetGroupIdxRef.current = undefined;
      lastTargetGroupIdRef.current = null;
      lastTabInsertIdxRef.current = undefined;
      captureElRef.current = targetEl;
      targetEl.addEventListener('lostpointercapture', handleLostCapture);

      base.start(
        {
          cardId,
          wsId,
          groupId,
          cardsLength,
          isDragFromTabButton,
          targetEl,
          sourceCard,
          cardSnapshots,
          clickOffsetX,
          clickOffsetY,
          startWidth,
          startHeight,
        },
        e
      );
    },
    [base, wsId, groupId, cardsLength, closeTabInGroup, handleLostCapture]
  );

  return { handleTabPointerDown };
}
