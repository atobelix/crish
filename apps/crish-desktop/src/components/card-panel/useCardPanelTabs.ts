import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLayoutStore } from '../../api/store-access/componentAccess';
import { focusOrOpenPanel, setGroupActiveCard } from '../../api/storeAccess';
import { onUiEvent } from '../../api/uiEvents';
import { closeAgentSidePanel } from '../../api/openAgentPanel';
import { isClosableTab, placeTabsAddMenu } from './CardPanelHeader';
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

  const [tabAddOpen, setTabAddOpen] = useState(false);
  const [tabAddPos, setTabAddPos] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const tabsBarRef = useRef<HTMLDivElement>(null);
  const tabAddBtnRef = useRef<HTMLButtonElement>(null);
  const tabAddMenuRef = useRef<HTMLDivElement>(null);
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
    if (!tabAddOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (tabAddBtnRef.current?.contains(t)) return;
      if (tabAddMenuRef.current?.contains(t)) return;
      setTabAddOpen(false);
      setTabAddPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setTabAddOpen(false);
        setTabAddPos(null);
        requestAnimationFrame(() => tabAddBtnRef.current?.focus());
      }
    };
    const reposition = () => {
      const btn = tabAddBtnRef.current;
      if (!btn) return;
      setTabAddPos(placeTabsAddMenu(btn.getBoundingClientRect()));
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [tabAddOpen]);

  useEffect(() => {
    if (!tabAddOpen || !tabAddMenuRef.current) return;
    const first =
      tabAddMenuRef.current.querySelector<HTMLElement>('[role="menuitem"]');
    requestAnimationFrame(() => first?.focus());
  }, [tabAddOpen]);

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

  const onAddMenuKeyDown = (e: React.KeyboardEvent) => {
    const menu = tabAddMenuRef.current;
    if (!menu) return;
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"]')
    );
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  return {
    dockOverlayStyle,
    activeCardId,
    cardsLen,
    tabAddOpen,
    tabAddPos,
    setTabAddOpen,
    setTabAddPos,
    tabsBarRef,
    tabAddBtnRef,
    tabAddMenuRef,
    handleGlobalTabClick,
    handleTabClick,
    closeToolTab,
    resolveFocusAfterClose,
    onTabKeyDown,
    onAddMenuKeyDown,
  };
}
