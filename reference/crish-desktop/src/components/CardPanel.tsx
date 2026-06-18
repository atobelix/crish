import React, { useState } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import * as Lucide from 'lucide-react';

interface CardPanelProps {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  onShowToast: (message: string) => void;
  heightRatio?: number;
}

export const CardPanel: React.FC<CardPanelProps> = ({
  wsId,
  colIdx,
  groupIdx,
  onShowToast,
  heightRatio,
}) => {
  const {
    workspaces,
    sessions,
    activeSessionId,
    draggedTab,
    setDraggedTab,
    mergeTab,
    detachTabToStandalone,
    closeTabInGroup,
    setPanelsDropdownCoords,
  } = useLayoutStore();

  const ws = workspaces.find((w) => w.id === wsId);
  const col = ws?.columns[colIdx];
  const group = col?.groups[groupIdx];
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<Array<{ text: string; sender: 'user' | 'assistant' }>>([]);

  if (!ws || !col || !group) return null;

  const activeCardId = group.activeCardId;

  // Handle tab click switching
  const handleTabClick = (cardId: string) => {
    useLayoutStore.setState((state) => {
      const targetWs = state.workspaces.find((w) => w.id === wsId);
      const targetCol = targetWs?.columns[colIdx];
      const targetGroup = targetCol?.groups[groupIdx];
      if (targetGroup) {
        targetGroup.activeCardId = cardId;
      }
    });
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Drag and Drop
  //
  // Two drag sources:
  //   • Tab button (.card-tab)  → can merge into other cards, reorder within same card, or split
  //   • Drag handle (.card-drag-handle)  → can only split / move as standalone, never merge
  // ──────────────────────────────────────────────────────────────────────────
  const handleTabPointerDown = (e: React.PointerEvent<HTMLDivElement>, cardId: string) => {
    if (e.button === 1) {
      // Middle click: close tab / active card in group
      if (cardId !== 'chat') {
        e.preventDefault();
        e.stopPropagation();
        closeTabInGroup(wsId, group.id, cardId);
        onShowToast(`关闭标签页: ${cardId}`);
      }
      return;
    }
    if (e.button !== 0) return;

    // Is this drag originating from a tab button? (enables merge)
    const isDragFromTabButton = (e.currentTarget as HTMLElement).classList.contains('card-tab');

    // Resolve source card DOM element synchronously (before async events)
    const sourceCard = e.currentTarget?.closest('.workspace-card') as HTMLElement;

    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;
    let dragOverlay: HTMLDivElement | null = null;

    // State tracked during drag, committed on drop
    let lastDropType: string | null = null;
    let lastTargetColIdx = 0;
    let lastTargetGroupIdx: number | undefined = undefined;
    let lastTargetGroupId: string | null = null;
    let lastTabInsertIdx: number | undefined = undefined;

    const cardRect = sourceCard ? sourceCard.getBoundingClientRect() : null;
    const startWidth = cardRect ? cardRect.width : 0;
    const startHeight = cardRect ? cardRect.height : 0;
    const clickOffsetX = cardRect ? (startX - cardRect.left) : 0;
    const clickOffsetY = cardRect ? (startY - cardRect.top) : 0;

    // Snapshot original cards' positions in the workspace
    const cardElements = Array.from(document.querySelectorAll('.workspace-card:not(.placeholder-card-group)')) as HTMLElement[];
    const cardSnapshots = cardElements.map((el) => {
      const r = el.getBoundingClientRect();
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
        colIdx: parseInt(el.getAttribute('data-col-idx') || '0'),
        groupIdx: parseInt(el.getAttribute('data-group-idx') || '0'),
        groupId: el.getAttribute('data-group-id') || '',
      };
    });

    const canvasEl = document.querySelector('.workspace-canvas') as HTMLElement;
    const canvasRect = canvasEl ? canvasEl.getBoundingClientRect() : null;

    const safeSetDropPreview = (nextPreview: any) => {
      const currentPreview = useLayoutStore.getState().dropPreview;
      if (!nextPreview) {
        if (currentPreview !== null) {
          useLayoutStore.getState().setDropPreview(null);
        }
        return;
      }
      if (
        !currentPreview ||
        currentPreview.colIdx !== nextPreview.colIdx ||
        currentPreview.groupIdx !== nextPreview.groupIdx ||
        currentPreview.direction !== nextPreview.direction
      ) {
        useLayoutStore.getState().setDropPreview(nextPreview);
      }
    };

    // ── Helpers ──────────────────────────────────────────────────────────
    const getIndicator = () => document.getElementById(`drop-indicator-${wsId}`) as HTMLDivElement | null;

    const clearIndicator = () => {
      const ind = getIndicator();
      if (ind) {
        ind.style.display = 'none';
        ind.removeAttribute('data-drop-type');
      }
      document.querySelectorAll('.tab-insert-line').forEach((el) => el.remove());
    };



    const showTabInsertLine = (tabsBar: HTMLElement, mouseX: number): { insertX: number; insertIdx: number } => {
      const tabs = Array.from(tabsBar.querySelectorAll('.card-tab:not(.dragging-tab-hidden)')) as HTMLElement[];
      const barRect = tabsBar.getBoundingClientRect();
      let insertX = barRect.right;
      let insertIdx = tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const tabRect = tabs[i].getBoundingClientRect();
        if (mouseX < tabRect.left + tabRect.width / 2) {
          insertX = tabRect.left;
          insertIdx = i;
          break;
        }
      }

      // Clean previous lines
      document.querySelectorAll('.tab-insert-line').forEach((el) => el.remove());

      const line = document.createElement('div');
      line.className = 'tab-insert-line';
      line.style.cssText = `
        position: fixed;
        left: ${insertX - 1}px;
        top: ${barRect.top + 3}px;
        width: 2px;
        height: ${barRect.height - 6}px;
        background: #374151;
        border-radius: 2px;
        pointer-events: none;
        z-index: 10001;
      `;
      document.body.appendChild(line);

      return { insertX, insertIdx };
    };

    // ── Pointer Move ─────────────────────────────────────────────────────
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      if (!isDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        isDragging = true;
        setDraggedTab({ cardId, sourceGroupId: group.id, workspaceId: wsId, isTabDrag: isDragFromTabButton });

        if (sourceCard) {
          dragOverlay = sourceCard.cloneNode(true) as HTMLDivElement;
          dragOverlay.className = 'drag-overlay-preview-card';
          dragOverlay.removeAttribute('id');
          dragOverlay.style.cssText = `
            position: fixed;
            width: ${startWidth}px;
            height: ${startHeight}px;
            overflow: hidden;
            box-shadow: 0 8px 28px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.1);
            border-radius: 0;
            border: 1.5px solid rgba(55, 65, 81, 0.3);
            background: var(--bg-card, #f8f9fa);
            opacity: 0.92;
            pointer-events: none;
            z-index: 10000;
            transition: width 0.18s cubic-bezier(0.2, 0.8, 0.2, 1), height 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
          `;
          dragOverlay.querySelectorAll('input, textarea, button').forEach((el) => {
            (el as HTMLInputElement).disabled = true;
          });
          document.body.appendChild(dragOverlay);
          document.body.classList.add('dragging-card');
        }
      }

      if (!isDragging || !dragOverlay) return;

      dragOverlay.style.left = `${moveEvent.clientX - clickOffsetX}px`;
      dragOverlay.style.top = `${moveEvent.clientY - clickOffsetY}px`;

      const mouseX = moveEvent.clientX;
      const mouseY = moveEvent.clientY;

      let matchedSnapshot = cardSnapshots.find(snap => 
        mouseX >= snap.rect.left && mouseX <= snap.rect.right &&
        mouseY >= snap.rect.top && mouseY <= snap.rect.bottom
      );

      if (!matchedSnapshot && cardSnapshots.length > 0) {
        let minDistance = Infinity;
        for (const snap of cardSnapshots) {
          const centerX = snap.rect.left + snap.rect.width / 2;
          const centerY = snap.rect.top + snap.rect.height / 2;
          const dist = Math.hypot(mouseX - centerX, mouseY - centerY);
          if (dist < minDistance) {
            minDistance = dist;
            matchedSnapshot = snap;
          }
        }
      }

      if (!matchedSnapshot) {
        clearIndicator();
        lastDropType = null;
        safeSetDropPreview(null);
        return;
      }

      const targetRect = matchedSnapshot.rect;
      const relX = mouseX - targetRect.left;
      const relY = mouseY - targetRect.top;

      const targetColIdx = matchedSnapshot.colIdx;
      const targetGroupIdx = matchedSnapshot.groupIdx;
      const targetGroupId = matchedSnapshot.groupId;

      // Always read current sourceGroupId from store (may have changed due to realtime moves)
      const currentDraggedTab = useLayoutStore.getState().draggedTab;
      const currentSourceGroupId = currentDraggedTab?.sourceGroupId ?? group.id;

      // Find current position of dragged group in workspace
      const currentWs = useLayoutStore.getState().workspaces.find((w) => w.id === wsId);
      let currentColIdx = -1;
      let currentGroupIdx = -1;
      if (currentWs) {
        currentWs.columns.forEach((c, cIdx) => {
          c.groups.forEach((g, gIdx) => {
            if (g.id === currentSourceGroupId) {
              currentColIdx = cIdx;
              currentGroupIdx = gIdx;
            }
          });
        });
      }

      const sourceCol = currentWs?.columns.find((c) => c.groups.some((g) => g.id === currentSourceGroupId));
      const isOnlyCardInCol = sourceCol && 
        sourceCol.groups.length === 1 && 
        sourceCol.groups[0].cards.length === 1;

      const isSelfHover = targetGroupId === currentSourceGroupId;

      (window as any).lastDragTrace = {
        cardId,
        isSelfHover,
        targetGroupId,
        currentSourceGroupId,
        relY,
        height: targetRect.height,
        isDragFromTabButton,
        cardsLength: group.cards.length
      };

      // Detect if target is directly adjacent to dragged card in same column
      const isDirectlyAbove = currentColIdx === targetColIdx && currentGroupIdx === targetGroupIdx - 1;
      const isDirectlyBelow = currentColIdx === targetColIdx && currentGroupIdx === targetGroupIdx + 1;

      const edgePaddingX = 50;
      const edgePaddingY = 38;
      const tabBarH = 36;

      let currentDropType: string | null = null;
      let currentTargetColIdx = targetColIdx;
      let currentTargetGroupIdx = targetGroupIdx;
      let currentTargetGroupId = targetGroupId;
      let currentTabInsertIdx: number | undefined = undefined;

      if (isSelfHover) {
        document.querySelectorAll('.tab-insert-line').forEach((el) => el.remove());
        const tabsBar = matchedSnapshot.element.querySelector('.tabs-bar') as HTMLElement;
        if (relY < tabBarH && tabsBar && isDragFromTabButton) {
          const { insertIdx } = showTabInsertLine(tabsBar, mouseX);
          currentDropType = 'self-reorder';
          currentTargetGroupId = currentSourceGroupId;
          currentTabInsertIdx = insertIdx;
          safeSetDropPreview(null);
        } else if (isDragFromTabButton && group.cards.length > 1) {
          // Allow splitting a tab out of the card even if hovering over itself
          const isUpperHalf = relY < targetRect.height / 2;
          if (isUpperHalf) {
            currentDropType = 'split-card-top';
            currentTargetColIdx = targetColIdx;
            currentTargetGroupIdx = targetGroupIdx;
            safeSetDropPreview({ colIdx: targetColIdx, groupIdx: targetGroupIdx, direction: 'top' });
          } else {
            currentDropType = 'split-card-bottom';
            currentTargetColIdx = targetColIdx;
            currentTargetGroupIdx = targetGroupIdx;
            safeSetDropPreview({ colIdx: targetColIdx, groupIdx: targetGroupIdx, direction: 'bottom' });
          }
        } else {
          currentDropType = null;
          safeSetDropPreview(null);
        }
      } else {
        const isChatCol = targetGroupId.includes('chat');
        // ── Chat Column (locked, cannot be split vertically, but can split col left/right) ──────────────────────
        if (isChatCol) {
          document.querySelectorAll('.tab-insert-line').forEach((el) => el.remove());
          if (relX < targetRect.width * 0.45) {
            const isRedundant = isOnlyCardInCol && (
              (currentColIdx === targetColIdx) ||
              (currentColIdx === targetColIdx - 1)
            );
            if (isRedundant) {
              currentDropType = null;
              safeSetDropPreview(null);
            } else {
              currentDropType = 'split-col-left';
              currentTargetColIdx = targetColIdx;
              safeSetDropPreview({ colIdx: targetColIdx, groupIdx: 0, direction: 'left' });
            }
          } else if (relX > targetRect.width * 0.55) {
            const isRedundant = isOnlyCardInCol && (
              (currentColIdx === targetColIdx) ||
              (currentColIdx === targetColIdx + 1)
            );
            if (isRedundant) {
              currentDropType = null;
              safeSetDropPreview(null);
            } else {
              currentDropType = 'split-col-right';
              currentTargetColIdx = targetColIdx + 1;
              safeSetDropPreview({ colIdx: targetColIdx, groupIdx: 0, direction: 'right' });
            }
          } else {
            currentDropType = null;
            safeSetDropPreview(null);
          }
        }
        // ── Tab bar zone ────────────────────────────────────────────────────
        else if (relY < tabBarH) {
          const tabsBar = matchedSnapshot.element.querySelector('.tabs-bar') as HTMLElement;
          if (isDragFromTabButton) {
            if (tabsBar) {
              const { insertIdx } = showTabInsertLine(tabsBar, moveEvent.clientX);
              currentDropType = 'merge';
              currentTargetGroupId = targetGroupId;
              currentTabInsertIdx = insertIdx;
            }
            safeSetDropPreview(null);
          } else {
            document.querySelectorAll('.tab-insert-line').forEach((el) => el.remove());
            if (isDirectlyAbove) {
              currentDropType = null;
              safeSetDropPreview(null);
            } else {
              currentDropType = 'split-card-top';
              currentTargetColIdx = targetColIdx;
              currentTargetGroupIdx = targetGroupIdx;
              safeSetDropPreview({ colIdx: targetColIdx, groupIdx: targetGroupIdx, direction: 'top' });
            }
          }
        }
        else {
          // Clear tab insert lines for non-tab-bar zones
          document.querySelectorAll('.tab-insert-line').forEach((el) => el.remove());

          // ── Left edge zone ──────────────────────────────────────────────────
          if (relX < edgePaddingX && targetColIdx > 0) {
            const isRedundant = (currentColIdx === targetColIdx && (currentWs?.columns[currentColIdx]?.groups.length ?? 0) <= 1) ||
                                (isOnlyCardInCol && targetColIdx === currentColIdx);
            if (isRedundant) {
              currentDropType = null;
              safeSetDropPreview(null);
            } else {
              currentDropType = 'split-col-left';
              currentTargetColIdx = targetColIdx;
              safeSetDropPreview({ colIdx: targetColIdx, groupIdx: 0, direction: 'left' });
            }
          }
          // ── Right edge zone ─────────────────────────────────────────────────
          else if (relX > targetRect.width - edgePaddingX) {
            const isRedundant = (currentColIdx === targetColIdx && (currentWs?.columns[currentColIdx]?.groups.length ?? 0) <= 1) ||
                                (isOnlyCardInCol && targetColIdx + 1 === currentColIdx);
            if (isRedundant) {
              currentDropType = null;
              safeSetDropPreview(null);
            } else {
              currentDropType = 'split-col-right';
              currentTargetColIdx = targetColIdx + 1;
              safeSetDropPreview({ colIdx: targetColIdx, groupIdx: 0, direction: 'right' });
            }
          }
          // ── Top body strip ──────────────────────────────────────────────────
          else if (relY < tabBarH + edgePaddingY) {
            if (isDirectlyAbove) {
              currentDropType = null;
              safeSetDropPreview(null);
            } else {
              currentDropType = 'split-card-top';
              currentTargetColIdx = targetColIdx;
              currentTargetGroupIdx = targetGroupIdx;
              safeSetDropPreview({ colIdx: targetColIdx, groupIdx: targetGroupIdx, direction: 'top' });
            }
          }
          // ── Bottom body strip ───────────────────────────────────────────────
          else if (relY > targetRect.height - edgePaddingY) {
            if (isDirectlyBelow) {
              currentDropType = null;
              safeSetDropPreview(null);
            } else {
              currentDropType = 'split-card-bottom';
              currentTargetColIdx = targetColIdx;
              currentTargetGroupIdx = targetGroupIdx;
              safeSetDropPreview({ colIdx: targetColIdx, groupIdx: targetGroupIdx, direction: 'bottom' });
            }
          }
          // ── Middle body zone — split top or bottom based on pointer half ──
          else {
            const isUpperHalf = relY < targetRect.height / 2;
            if (isUpperHalf) {
              if (isDirectlyAbove) {
                currentDropType = null;
                safeSetDropPreview(null);
              } else {
                currentDropType = 'split-card-top';
                currentTargetColIdx = targetColIdx;
                currentTargetGroupIdx = targetGroupIdx;
                safeSetDropPreview({ colIdx: targetColIdx, groupIdx: targetGroupIdx, direction: 'top' });
              }
            } else {
              if (isDirectlyBelow) {
                currentDropType = null;
                safeSetDropPreview(null);
              } else {
                currentDropType = 'split-card-bottom';
                currentTargetColIdx = targetColIdx;
                currentTargetGroupIdx = targetGroupIdx;
                safeSetDropPreview({ colIdx: targetColIdx, groupIdx: targetGroupIdx, direction: 'bottom' });
              }
            }
          }
        }
      }

      // Assign back to outer scope variables
      lastDropType = currentDropType;
      lastTargetColIdx = currentTargetColIdx;
      lastTargetGroupIdx = currentTargetGroupIdx;
      lastTargetGroupId = currentTargetGroupId;
      lastTabInsertIdx = currentTabInsertIdx;

      // Calculate and update drag overlay dimensions
      let targetWidth = startWidth;
      let targetHeight = startHeight;

      if (lastDropType === 'merge' || lastDropType === 'self-reorder') {
        targetWidth = targetRect.width;
        targetHeight = targetRect.height;
      } else if (lastDropType === 'split-card-top' || lastDropType === 'split-card-bottom') {
        targetWidth = targetRect.width;
        const targetCol = currentWs?.columns[lastTargetColIdx];
        const targetColGroupsCount = targetCol ? targetCol.groups.length : 1;
        targetHeight = canvasRect ? (canvasRect.height / (targetColGroupsCount + 1)) : (targetRect.height * 0.5);
      } else if (lastDropType === 'split-col-left' || lastDropType === 'split-col-right') {
        targetWidth = canvasRect ? canvasRect.width * 0.25 : targetRect.width * 0.75;
        targetHeight = canvasRect ? canvasRect.height : targetRect.height;
      }

      dragOverlay.style.width = `${targetWidth}px`;
      dragOverlay.style.height = `${targetHeight}px`;
    };

    // ── Pointer Up ───────────────────────────────────────────────────────
    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);

      document.querySelectorAll('.tab-insert-line').forEach((el) => el.remove());
      useLayoutStore.getState().setDropPreview(null);

      if (!isDragging) {
        if (dragOverlay) dragOverlay.remove();
        document.body.classList.remove('dragging-card');
        return;
      }

      const latestDraggedTab = useLayoutStore.getState().draggedTab;
      const latestSourceGroupId = latestDraggedTab?.sourceGroupId ?? group.id;

      clearIndicator();
      setDraggedTab(null);

      // Commit layout state changes once on release
      if (lastDropType === 'merge' && lastTargetGroupId && lastTargetGroupId !== latestSourceGroupId) {
        mergeTab(wsId, cardId, latestSourceGroupId, lastTargetGroupId, lastTabInsertIdx);
        onShowToast(`合并标签页: ${cardId}`);
      } else if (lastDropType === 'self-reorder' && lastTabInsertIdx !== undefined) {
        // Reorder within same group
        mergeTab(wsId, cardId, latestSourceGroupId, latestSourceGroupId, lastTabInsertIdx);
      } else if (lastDropType === 'split-card-top') {
        detachTabToStandalone(wsId, cardId, latestSourceGroupId, lastTargetColIdx, 'top', lastTargetGroupIdx);
        onShowToast(`拆分卡片置顶: ${cardId}`);
      } else if (lastDropType === 'split-card-bottom') {
        detachTabToStandalone(wsId, cardId, latestSourceGroupId, lastTargetColIdx, 'bottom', lastTargetGroupIdx);
        onShowToast(`拆分卡片置底: ${cardId}`);
      } else if (lastDropType === 'split-col-left') {
        detachTabToStandalone(wsId, cardId, latestSourceGroupId, lastTargetColIdx, 'new-col');
        onShowToast(`向左侧拆分列: ${cardId}`);
      } else if (lastDropType === 'split-col-right') {
        detachTabToStandalone(wsId, cardId, latestSourceGroupId, lastTargetColIdx, 'new-col');
        onShowToast(`向右侧拆分列: ${cardId}`);
      }

      if (dragOverlay) {
        document.body.classList.remove('dragging-card');
        const overlay = dragOverlay;

        // Find the dropped card's final DOM element after React finishes re-rendering
        setTimeout(() => {
          let targetCardDOM: HTMLElement | null = null;
          const workspaceCards = Array.from(document.querySelectorAll('.workspace-card')) as HTMLElement[];
          for (const cardEl of workspaceCards) {
            // Find the workspace-card containing the dropped card tab
            const tabs = Array.from(cardEl.querySelectorAll('.card-tab')) as HTMLElement[];
            const hasTab = tabs.some(t => t.textContent?.toLowerCase().includes(cardId.toLowerCase()) || t.innerHTML.includes(cardId));
            const isChat = cardId === 'chat' && cardEl.classList.contains('flat-layout');

            if (hasTab || isChat) {
              targetCardDOM = cardEl;
              break;
            }
          }

          if (targetCardDOM) {
            const destRect = targetCardDOM.getBoundingClientRect();
            overlay.style.transition = 'all 0.28s cubic-bezier(0.19, 1, 0.22, 1)';
            overlay.style.left = `${destRect.left}px`;
            overlay.style.top = `${destRect.top}px`;
            overlay.style.width = `${destRect.width}px`;
            overlay.style.height = `${Math.min(destRect.height, 160)}px`;
            overlay.style.transform = 'scale(1.0)';
            overlay.style.opacity = '0.2';

            setTimeout(() => {
              overlay.remove();
            }, 280);
          } else {
            // Fallback: shrink and fade out
            overlay.style.transition = 'all 0.2s ease-out';
            overlay.style.transform = 'scale(0.5)';
            overlay.style.opacity = '0';
            setTimeout(() => {
              overlay.remove();
            }, 200);
          }
        }, 30);
      } else {
        document.body.classList.remove('dragging-card');
      }
      // Middle-body real-time moves are already committed during drag
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleSendChat = () => {
    if (!chatInput.trim()) return;
    setChatMessages((prev) => [...prev, { sender: 'user', text: chatInput }]);
    const input = chatInput;
    setChatInput('');

    setTimeout(() => {
      setChatMessages((prev) => [
        ...prev,
        { sender: 'assistant', text: `收到反馈！我们将围绕您的请求 "${input}" 展开深入的代码统一性审计。` },
      ]);
    }, 1000);
  };

  // Render icons corresponding to tabs
  const renderCardIcon = (id: string) => {
    switch (id) {
      case 'chat': return <Lucide.MessageSquare size={13} />;
      case 'plan': return <Lucide.Scroll size={13} />;
      case 'preview': return <Lucide.Eye size={13} />;
      case 'diff': return <Lucide.GitBranch size={13} />;
      case 'tasks': return <Lucide.CheckSquare size={13} />;
      case 'terminal': return <Lucide.Terminal size={13} />;
      default: return <Lucide.Layout size={13} />;
    }
  };

  const isDraggingThisGroup = draggedTab && draggedTab.sourceGroupId === group.id &&
    (!draggedTab.isTabDrag || group.cards.length === 1);

  return (
    <div
      className={`workspace-card ${activeCardId === 'chat' ? 'flat-layout' : ''} ${isDraggingThisGroup ? 'drag-ghost-hidden' : ''}`}
      data-group-id={group.id}
      data-col-idx={colIdx}
      data-group-idx={groupIdx}
      style={{
        height: `${(heightRatio !== undefined ? heightRatio : group.heightRatio) * 100}%`,
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* Tab Header Bar */}
      <div className="card-header">
        {activeCardId === 'chat' ? (
          <div className="card-header-left chat-breadcrumb-header">
            <span className="breadcrumb-item folder-trigger">
              <Lucide.Folder size={12} className="folder-icon" />
              <span className="folder-name-txt">{activeSession?.folder || '审计与代码分析'}</span>
            </span>
            <span className="breadcrumb-separator">/</span>
            <span className="breadcrumb-item session-trigger">
              <span className="session-name-txt">{activeSession?.title || '审计三个项目的代码统一性问题'}</span>
              <Lucide.ChevronDown size={10} className="breadcrumb-chevron" />
            </span>
          </div>
        ) : (
          <div className="tabs-bar">
            {group.cards.map((c) => (
              <div
                key={c.id}
                className={`card-tab ${c.id === activeCardId ? 'active' : ''} ${
                  draggedTab && draggedTab.cardId === c.id && draggedTab.sourceGroupId === group.id ? 'dragging-tab-hidden' : ''
                }`}
                onClick={() => handleTabClick(c.id)}
                onPointerDown={(e) => handleTabPointerDown(e, c.id)}
                style={{ touchAction: 'none' }}
              >
                <div className="tab-icon-container">
                  {renderCardIcon(c.id)}
                  {c.id !== 'chat' && (
                    <button
                      className="tab-close-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTabInGroup(wsId, group.id, c.id);
                      }}
                    >
                      <Lucide.X size={10} />
                    </button>
                  )}
                </div>
                <span>{c.title}</span>
              </div>
            ))}
          </div>
        )}
        
        {/* Card Drag Handle: Blank area in the middle of header */}
        <div
          className="card-drag-handle"
          onPointerDown={(e) => handleTabPointerDown(e, activeCardId)}
          style={{ flex: 1, height: '100%', touchAction: 'none' }}
        />

        <div className="card-header-right">
          <button
            className="card-action-btn panel-menu-btn"
            title="Toggle Panels"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setPanelsDropdownCoords({
                x: rect.left + rect.width - 210,
                y: rect.top + rect.height + 4,
              });
            }}
          >
            <Lucide.Layout size={14} />
          </button>
        </div>
      </div>

      {/* Switch Panel Contents dynamically based on activeCardId */}
      <div className="card-body">
        {activeCardId === 'chat' && (
          <>
            <div className="chat-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div className="chat-doc-flow" style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
                <p className="user-text">Let me try directly creating a test trigger to isolate the issue.</p>

                <div className="tool-line">
                  <span className="tool-text">Searched code, read 2 files, used 3 tools</span>
                  <Lucide.ChevronRight size={12} className="tool-arrow" />
                </div>

                <p className="assistant-text">The inline button DOES exist (1 found)! Let me find where it is:</p>

                <div className="tool-line">
                  <span className="tool-text">Used 2 tools</span>
                  <Lucide.ChevronRight size={12} className="tool-arrow" />
                </div>

                <p className="assistant-text">Found the culprit! Another extension is creating <code>&lt;button data-flowbit-inline="1"&gt;F&lt;/button&gt;</code>, and our code reuses it. Let me find which extension:</p>

                <div className="tool-line">
                  <span className="tool-text">Searched code, used a tool</span>
                  <Lucide.ChevronRight size={12} className="tool-arrow" />
                </div>

                <p className="assistant-text">找到根源了！另一个扩展创建了 <code>&lt;button data-flowbit-inline="1"&gt;F&lt;/button&gt;</code>，我们的 <code>acquireInlineBtn</code> 找到并重用它，但没有覆盖它的 <code>innerHTML</code>，所以按钮只显示 "F"，而非 SVG 图标。</p>

                <div className="tool-line diff-action-line">
                  <span className="tool-text">Edited <span className="file-hl">trigger-injector.ts</span> <span className="diff-add-count">+12</span> <span className="diff-remove-count">-5</span></span>
                  <Lucide.ChevronRight size={12} className="tool-arrow" />
                </div>

                <p className="assistant-text">Now rebuild and reload:</p>

                <div className="tool-line">
                  <span className="tool-text">Ran 7 commands, searched code, read a file, edited a file, used 13 tools</span>
                  <Lucide.ChevronRight size={12} className="tool-arrow" />
                </div>

                <div className="assistant-report">
                  <p>我已经追踪到这个问题的根源了，总结一下发现：</p>
                  <p><strong>当前状态：</strong></p>
                  <ul>
                    <li>扩展已加载，service worker 正常</li>
                    <li>内容脚本已注入 (overlay 面板创建成功)
                      <ul>
                        <li>但 <code>mountTrigger()</code> 函数没有正常执行——<code>flowbit-inline-style</code> style 元素没有被创建，触发按钮也没有生成</li>
                      </ul>
                    </li>
                  </ul>
                  <p><strong>根源：</strong> 还有一个其他扩展（如 "All API Hub" 或 "HiSider"）在页面上注入了 <code>&lt;button data-flowbit-inline="1"&gt;F&lt;/button&gt;</code>，我们的 <code>acquireInlineBtn</code> 会找到并重用这个按钮，但不会覆盖它的 <code>innerHTML</code>，导致按钮只显示 "F" 而不是 SVG 图标。</p>
                  <p>我已经修复了 <code>acquireInlineBtn</code> 让它检测到外部按钮时重新创建。</p>
                  <p>但现在有一个更基础的问题：在新加载 of 页面上，<code>mountTrigger</code> 根本没有被触发（连 <code>&lt;style&gt;</code> 元素都没有），这说明内容脚本执行到 <code>showFlowbitFab()</code> 时可能抛出了异常，被 <code>bootstrap()</code> 的 <code>try-catch</code> 吞掉了。</p>
                  <p>需要你手动做：</p>
                  <ol>
                    <li>打开 <code>chrome://extensions</code></li>
                    <li>找到 "Chat Sync Bridge"，点 移除 <Lucide.Trash2 size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /></li>
                    <li>点击 <strong>加载已解压的扩展程序</strong> ➔ 选择 <code>C:\Software\codex_chatHistory\apps\browser-extension\dist</code></li>
                    <li>刷新 Claude 或 ChatGPT 页面</li>
                  </ol>
                  <p>这次移除再重新加载会触发全新的内容脚本注册，应该能解决 <code>mountTrigger</code> 不触发的问题。</p>
                </div>

                {chatMessages.map((msg, i) => (
                  <p key={i} className={msg.sender === 'user' ? 'user-text' : 'assistant-text'}>
                    {msg.text}
                  </p>
                ))}
              </div>

              {/* Chat Bottom Control Area */}
              <div className="chat-footer">
                {/* PR Panel */}
                <div className="pr-banner">
                  <div className="pr-info">
                    <Lucide.GitBranch size={12} className="branch-icon" />
                    <span className="branch-text">feature/schedule-panel-enhancements ➔ feature/schedule-panel-enhancements</span>
                    <span className="pr-badge plus-minus">+16039 -863</span>
                  </div>
                  <button className="create-pr-btn">Create PR</button>
                </div>
                
                {/* Input Area */}
                <div className="input-container">
                  <textarea
                    placeholder="Type / for commands"
                    rows={1}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendChat();
                      }
                    }}
                  />
                  <button className="send-btn" title="Send" onClick={handleSendChat}>
                    <Lucide.CornerDownLeft size={14} />
                  </button>
                </div>

                {/* Footer Controls */}
                <div className="footer-actions">
                  <div className="left-actions">
                    <div className="bypass-link">
                      <span className="orange-dot"></span>
                      <span className="bypass-text">Bypass permissions</span>
                    </div>
                    <button className="plus-btn" title="Add files"><Lucide.Plus size={14} /></button>
                  </div>
                  <div className="right-actions">
                    <div className="model-badge">
                      <span className="model-text">Dee***** 4 Flash 1M - High</span>
                      <div className="model-spinner"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {activeCardId === 'plan' && (
          <>
            <div className="card-subheader plan-subheader">
              <div className="subheader-left">
                <span className="plan-status-text">Drafting plan...</span>
              </div>
              <div className="subheader-right" style={{ display: 'flex', gap: '4px' }}>
                <button className="sub-btn" title="Export Plan"><Lucide.Download size={13} /></button>
                <button className="sub-btn" title="Clear Plan"><Lucide.Trash2 size={13} /></button>
              </div>
            </div>
            <div className="plan-body centered-placeholder">
              <div className="placeholder-icon-wrapper">
                <svg viewBox="0 0 24 24" className="svg-placeholder-lines" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 6h16M4 12h10M4 18h14" strokeLinecap="round"/>
                </svg>
              </div>
              <h4>No plan yet.</h4>
              <p>Claude writes the plan here as it explores. Keep chatting</p>
            </div>
          </>
        )}

        {activeCardId === 'preview' && (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1 }}>
            <div className="card-subheader preview-subheader">
              <div className="subheader-left" style={{ display: 'flex', gap: '2px' }}>
                <button className="sub-btn" title="Back"><Lucide.ChevronLeft size={13} /></button>
                <button className="sub-btn" title="Forward"><Lucide.ChevronRight size={13} /></button>
                <button className="sub-btn" title="Refresh"><Lucide.RotateCw size={13} /></button>
              </div>
              <div className="url-bar">
                <Lucide.Lock size={11} className="lock-icon" />
                <input type="text" value="http://localhost:3000/" readOnly />
              </div>
              <div className="subheader-right">
                <button className="sub-btn" title="Open in browser"><Lucide.ExternalLink size={13} /></button>
              </div>
            </div>
            <div className="preview-body centered-placeholder">
              <div className="broken-image-box">
                <Lucide.Image size={24} className="broken-img-icon" />
              </div>
              <div className="setup-loading">
                <div className="loading-spinner"></div>
                <span>Setting up preview</span>
              </div>
            </div>
          </div>
        )}

        {activeCardId === 'diff' && (
          <>
            <div className="card-subheader diff-subheader">
              <div className="subheader-left">
                <Lucide.GitBranch size={12} className="branch-icon" />
                <span className="branch-text">feature/schedule-panel-enhancements ➔ working tree</span>
              </div>
              <div className="subheader-right" style={{ display: 'flex', gap: '4px' }}>
                <button className="sub-btn" title="Stage All"><Lucide.Check size={13} /></button>
                <button className="sub-btn" title="Discard All"><Lucide.Trash2 size={13} /></button>
              </div>
            </div>
            <div className="diff-body">
              <div className="diff-file-path">
                <Lucide.ChevronDown size={12} className="path-arrow" style={{ display: 'inline', marginRight: '4px' }} />
                <span className="filepath-text">zennav-server/.env.example</span>
                <span className="diff-green-red">+23 -0</span>
              </div>
              
              <div className="diff-unmodified-tag">
                <Lucide.ChevronUp size={11} className="unmodified-arrow" style={{ display: 'inline', marginRight: '4px' }} />
                <span>11 unmodified lines</span>
              </div>

              {/* Code lines */}
              <div className="diff-code-block">
                <div className="code-line"><span className="line-num">12</span><span className="line-content"></span></div>
                <div className="code-line"><span className="line-num">13</span><span className="line-content"># Access/refresh token settings</span></div>
                <div className="code-line"><span className="line-num">14</span><span className="line-content">AUTH_TOKEN_SECRET=replace-with-a-long-random-secret</span></div>
                <div className="code-line added"><span className="line-num">15</span><span className="line-content">AI_CREDENTIAL_SECRET=replace-with-a-long-random-secret</span></div>
                <div className="code-line added"><span className="line-num">16</span><span className="line-content">AUTH_SERVICE_TOKEN=replace-with-a-long-random-secret-token</span></div>
                <div className="code-line"><span className="line-num">17</span><span className="line-content">ACCESS_TOKEN_TTL_SECONDS=900</span></div>
                <div className="code-line"><span className="line-num">18</span><span className="line-content">REFRESH_TOKEN_TTL_DAYS=30</span></div>
              </div>
            </div>
          </>
        )}

        {activeCardId === 'tasks' && (
          <>
            <div className="card-subheader tasks-subheader">
              <div className="subheader-left">
                <span className="task-count-text">0/0 Tasks Completed</span>
              </div>
              <div className="subheader-right" style={{ display: 'flex', gap: '4px' }}>
                <button className="sub-btn" title="Add Task"><Lucide.Plus size={13} /></button>
                <button className="sub-btn" title="Filter Tasks"><Lucide.Filter size={13} /></button>
              </div>
            </div>
            <div className="tasks-body centered-placeholder">
              <div className="tasks-placeholder-icon">
                <Lucide.CheckSquare size={32} className="task-placeholder-img" />
              </div>
              <h4>No tasks.</h4>
            </div>
          </>
        )}

        {activeCardId === 'terminal' && (
          <>
            <div className="card-subheader terminal-subheader">
              <div className="subheader-left">
                <Lucide.Terminal size={12} className="term-icon" />
                <span className="term-title">bash (local)</span>
              </div>
              <div className="subheader-right" style={{ display: 'flex', gap: '4px' }}>
                <button className="sub-btn" title="New Terminal"><Lucide.Plus size={13} /></button>
                <button className="sub-btn" title="Clear Buffer"><Lucide.Trash2 size={13} /></button>
              </div>
            </div>
            <div className="terminal-body">
              <div className="terminal-output">
                <div className="terminal-line"><span className="term-prompt">orange@Windows-PC MINGW64 /c/Software/conex</span></div>
                <div className="terminal-line"><span className="term-command">$ npm run dev</span></div>
                <div className="terminal-line term-log"></div>
                <div className="terminal-line term-log">&gt; zennav-server@1.0.0 dev</div>
                <div className="terminal-line term-log">&gt; node server.js</div>
                <div className="terminal-line term-log"></div>
                <div className="terminal-line term-success">[ready] Server started on http://localhost:3000</div>
                <div className="terminal-line term-success">[ready] Database connection established.</div>
                <div className="terminal-line"><span className="term-cursor">█</span></div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
