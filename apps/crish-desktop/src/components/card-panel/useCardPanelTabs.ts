import React, { useEffect, useMemo, useRef } from 'react';
import { useLayoutStore } from '../../store/storeAccess';
import { focusOrOpenPanel, setGroupActiveCard } from '../../api/storeAccess';
import { onUiEvent } from '../../api/uiEvents';
import { closeAgentSidePanel } from '../../api/openAgentPanel';
import { isClosableTab } from './CardPanelHeader';
import { getDockOverlayStyle } from './CardPanelLayout';
import type { GroupState } from '../../store/types';

export interface UseCardPanelTabsOptions {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  group: GroupState | undefined;
}

export function useCardPanelTabs({
  wsId,
  colIdx,
  groupIdx,
  group,
}: UseCardPanelTabsOptions) {
  const closeTabInGroup = useLayoutStore((s) => s.closeTabInGroup);
  const draggedTab = useLayoutStore((s) => s.draggedTab);
  const dropPreview = useLayoutStore((s) => s.dropPreview);

  const tabsBarRef = useRef<HTMLDivElement>(null);
  const tabAddBtnRef = useRef<HTMLButtonElement>(null);
  const sideActionBtnRef = useRef<HTMLButtonElement>(null);
  const pendingFocusCardIdRef = useRef<string | null>(null);

  const isTargetPanel = !!(
    dropPreview &&
    dropPreview.colIdx === colIdx &&
    dropPreview.groupIdx === groupIdx
  );
  const showDockOverlay = !!(
    isTargetPanel &&
    draggedTab &&
    draggedTab.isTabDrag
  );

  const dockOverlayStyle = useMemo(
    () => getDockOverlayStyle(showDockOverlay, dropPreview),
    [showDockOverlay, dropPreview]
  );

  const activeCardId = group?.activeCardId || 'chat';
  const cardsLen = group?.cards?.length || 0;
  const isPanelEventHost = colIdx === 0 && groupIdx === 0;

  const handleGlobalTabClick = (cardId: string) => {
    focusOrOpenPanel(wsId, cardId);
  };

  const handleTabClick = (cardId: string) => {
    setGroupActiveCard(wsId, colIdx, groupIdx, cardId);
  };

  useEffect(() => {
    if (!isPanelEventHost) return;
    return onUiEvent('open-agent-panel', () => {
      handleGlobalTabClick('agent');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, isPanelEventHost]);

  useEffect(() => {
    if (!isPanelEventHost) return;
    const onOpenFile = () => {
      handleGlobalTabClick('files');
    };
    const onOpenTerm = () => {
      handleGlobalTabClick('terminal');
    };
    window.addEventListener('crish-open-file', onOpenFile);
    window.addEventListener('crish-open-terminal', onOpenTerm);
    const offOverview = onUiEvent('open-overview', () => {
      handleGlobalTabClick('overview');
    });
    const offTasks = onUiEvent('open-tasks', () => {
      handleGlobalTabClick('overview');
    });
    return () => {
      window.removeEventListener('crish-open-file', onOpenFile);
      window.removeEventListener('crish-open-terminal', onOpenTerm);
      offOverview();
      offTasks();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, isPanelEventHost]);

  useEffect(() => {
    const el = tabsBarRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 1 && Math.abs(e.deltaX) < 1) return;
      if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onMouseDown);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onMouseDown);
    };
  }, [activeCardId, cardsLen]);

  useEffect(() => {
    const want = pendingFocusCardIdRef.current;
    if (!want) return;
    pendingFocusCardIdRef.current = null;
    requestAnimationFrame(() => {
      if (want === '__add__') {
        tabAddBtnRef.current?.focus();
        return;
      }
      if (want === '__side__') {
        sideActionBtnRef.current?.focus();
        return;
      }
      const el = tabsBarRef.current?.querySelector<HTMLElement>(
        `[role="tab"][data-card-id="${want}"]`
      );
      if (el) {
        el.focus();
        return;
      }
      tabAddBtnRef.current?.focus();
    });
  }, [activeCardId, cardsLen]);

  const closeToolTab = (cardId: string, focusAfter: string | null) => {
    if (!group) return;
    if (!isClosableTab(cardId)) return;
    if (focusAfter != null) {
      pendingFocusCardIdRef.current = focusAfter;
    }
    if (cardId === 'agent') {
      closeAgentSidePanel(wsId, group.id);
    } else {
      closeTabInGroup(wsId, group.id, cardId);
    }
  };

  const resolveFocusAfterClose = (cardId: string): string => {
    if (!group) return '__add__';
    const cards = group.cards;
    const idx = cards.findIndex((c) => c.id === cardId);
    if (idx < 0) return '__add__';
    const next = cards[idx + 1] ?? cards[idx - 1];
    if (next && next.id !== cardId) return next.id;
    return '__add__';
  };

  const focusTabByIndex = (index: number) => {
    if (!group) return;
    const cards = group.cards;
    if (cards.length === 0) return;
    const safe = Math.max(0, Math.min(index, cards.length - 1));
    const id = cards[safe]!.id;
    handleTabClick(id);
    requestAnimationFrame(() => {
      tabsBarRef.current
        ?.querySelector<HTMLElement>(`[role="tab"][data-card-id="${id}"]`)
        ?.focus();
    });
  };

  const onTabKeyDown = (
    e: React.KeyboardEvent,
    cardId: string,
    index: number
  ) => {
    if (!group) return;
    const n = group.cards.length;
    if (n === 0) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        focusTabByIndex((index + 1) % n);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        focusTabByIndex((index - 1 + n) % n);
        break;
      case 'Home':
        e.preventDefault();
        focusTabByIndex(0);
        break;
      case 'End':
        e.preventDefault();
        focusTabByIndex(n - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        handleTabClick(cardId);
        break;
      case 'Delete':
      case 'Backspace':
        if (isClosableTab(cardId)) {
          e.preventDefault();
          closeToolTab(cardId, resolveFocusAfterClose(cardId));
        }
        break;
      default:
        break;
    }
  };

  return {
    dockOverlayStyle,
    activeCardId,
    cardsLen,
    tabsBarRef,
    tabAddBtnRef,
    handleGlobalTabClick,
    handleTabClick,
    closeToolTab,
    resolveFocusAfterClose,
    onTabKeyDown,
  };
}
