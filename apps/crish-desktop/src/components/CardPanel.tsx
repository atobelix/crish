import React from 'react';
import { useLayoutStore } from '../store/layoutStore';
import * as Lucide from 'lucide-react';
import { RuntimePanel } from './RuntimePanel';
import { ChatCard } from './ChatCard';
import { PreviewCard } from './PreviewCard';
import { DiffCard } from './DiffCard';
import { TasksCard } from './TasksCard';
import { TerminalCard } from './TerminalCard';
import { AgentCard } from './AgentCard';
import { FilesCard } from './FilesCard';

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
    setPanelAgentId,
  } = useLayoutStore();

  React.useEffect(() => {
    const onOpenAgent = (ev: Event) => {
      const detail = (ev as CustomEvent<{ agentId?: string }>).detail;
      if (detail?.agentId) setPanelAgentId(detail.agentId);
      handleGlobalTabClick('agent');
    };
    window.addEventListener('crish-open-agent-panel', onOpenAgent);
    return () => window.removeEventListener('crish-open-agent-panel', onOpenAgent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  // 文件 / 终端：外部入口先展开右侧对应面板
  React.useEffect(() => {
    const onOpenFile = () => {
      handleGlobalTabClick('files');
    };
    const onOpenTerm = () => {
      handleGlobalTabClick('terminal');
    };
    window.addEventListener('crish-open-file', onOpenFile);
    window.addEventListener('crish-open-terminal', onOpenTerm);
    return () => {
      window.removeEventListener('crish-open-file', onOpenFile);
      window.removeEventListener('crish-open-terminal', onOpenTerm);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  const ws = workspaces.find((w) => w.id === wsId);
  const col = ws?.columns[colIdx];
  const group = col?.groups[groupIdx];
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  if (!ws || !col || !group) return null;

  const activeCardId = group.activeCardId;

  // Render icons corresponding to tabs
  const renderCardIcon = (id: string) => {
    switch (id) {
      case 'chat': return <Lucide.MessageSquare size={13} />;
      case 'plan': return <Lucide.Scroll size={13} />;
      case 'preview': return <Lucide.Globe size={13} />;
      case 'files': return <Lucide.FolderTree size={13} />;
      case 'diff': return <Lucide.GitBranch size={13} />;
      case 'tasks': return <Lucide.CheckSquare size={13} />;
      case 'terminal': return <Lucide.Terminal size={13} />;
      case 'settings': return <Lucide.Settings size={13} />;
      case 'runtime': return <Lucide.Gauge size={13} />;
      case 'agent': return <Lucide.Bot size={13} />;
      default: return <Lucide.Layout size={13} />;
    }
  };

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

  /** Open or focus a tool panel in the right area (preview/diff/terminal/tasks/…) */
  const handleGlobalTabClick = (cardId: string) => {
    const targetWs = useLayoutStore.getState().workspaces.find((w) => w.id === wsId);
    if (!targetWs) return;

    let found = false;
    for (const c of targetWs.columns) {
      for (const g of c.groups) {
        if (g.cards.some((card) => card.id === cardId)) {
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      // Panel not mounted — open it as a real workspace column/group via store
      useLayoutStore.getState().togglePanel(wsId, cardId, true);
    }

    // Focus the card wherever it lives
    useLayoutStore.setState((state) => {
      const ws2 = state.workspaces.find((w) => w.id === wsId);
      if (!ws2) return;
      for (const c of ws2.columns) {
        for (const g of c.groups) {
          if (g.cards.some((card) => card.id === cardId)) {
            g.activeCardId = cardId;
            return;
          }
        }
      }
    });
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Drag and Drop window layout management logic
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

    const isDragFromTabButton = (e.currentTarget as HTMLElement).classList.contains('card-tab');
    const sourceCard = e.currentTarget?.closest('.workspace-card') as HTMLElement;

    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;
    let dragOverlay: HTMLDivElement | null = null;

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

      document.querySelectorAll('.tab-insert-line').forEach((el) => el.remove());

      const line = document.createElement('div');
      line.className = 'tab-insert-line';
      line.style.cssText = `
        position: fixed;
        left: ${insertX - 1}px;
        top: ${barRect.top + 3}px;
        width: 2px;
        height: ${barRect.height - 6}px;
        background: #333333;
        border-radius: 2px;
        pointer-events: none;
        z-index: 10001;
      `;
      document.body.appendChild(line);

      return { insertX, insertIdx };
    };

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
            box-shadow: 0 0 16px rgba(0,0,0,0.12);
            border-radius: 0;
            border: 1.5px solid rgba(55, 65, 81, 0.3);
            background: var(--bg-card, #f9f9f9);
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

      const currentDraggedTab = useLayoutStore.getState().draggedTab;
      const currentSourceGroupId = currentDraggedTab?.sourceGroupId ?? group.id;

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
          document.querySelectorAll('.tab-insert-line').forEach((el) => el.remove());

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

      lastDropType = currentDropType;
      lastTargetColIdx = currentTargetColIdx;
      lastTargetGroupIdx = currentTargetGroupIdx;
      lastTargetGroupId = currentTargetGroupId;
      lastTabInsertIdx = currentTabInsertIdx;

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

      if (lastDropType === 'merge' && lastTargetGroupId && lastTargetGroupId !== latestSourceGroupId) {
        mergeTab(wsId, cardId, latestSourceGroupId, lastTargetGroupId, lastTabInsertIdx);
        onShowToast(`合并标签页: ${cardId}`);
      } else if (lastDropType === 'self-reorder' && lastTabInsertIdx !== undefined) {
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

        setTimeout(() => {
          let targetCardDOM: HTMLElement | null = null;
          const workspaceCards = Array.from(document.querySelectorAll('.workspace-card')) as HTMLElement[];
          for (const cardEl of workspaceCards) {
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
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
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
          <div className="card-header-left chat-breadcrumb-header" style={{ display: 'flex', alignItems: 'center' }}>
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
            {group.cards.map((c) => {
              const isToolTab = c.id !== 'chat';
              return (
              <div
                key={c.id}
                className={`card-tab ${isToolTab ? 'card-tab--tool' : ''} ${c.id === activeCardId ? 'active' : ''} ${
                  draggedTab && draggedTab.cardId === c.id && draggedTab.sourceGroupId === group.id ? 'dragging-tab-hidden' : ''
                }`}
                onClick={() => handleTabClick(c.id)}
                onPointerDown={(e) => handleTabPointerDown(e, c.id)}
                style={{ touchAction: 'none' }}
                title={c.title}
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
                <span className="tab-label">{c.title}</span>
              </div>
              );
            })}
          </div>
        )}
        
        {/* Card Drag Handle */}
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
          <ChatCard 
            wsId={wsId} 
            colIdx={colIdx} 
            groupIdx={groupIdx} 
            onShowToast={onShowToast} 
            handleGlobalTabClick={handleGlobalTabClick} 
          />
        )}
        {activeCardId === 'preview' && (
          <PreviewCard 
            wsId={wsId} 
            onShowToast={onShowToast} 
          />
        )}
        {activeCardId === 'files' && (
          <FilesCard onShowToast={onShowToast} />
        )}
        {activeCardId === 'diff' && (
          <DiffCard 
            onShowToast={onShowToast} 
          />
        )}
        {activeCardId === 'tasks' && (
          <TasksCard />
        )}
        {activeCardId === 'terminal' && (
          <TerminalCard />
        )}
        {activeCardId === 'settings' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)', gap: '8px', padding: '32px' }}>
            <Lucide.Settings size={24} style={{ opacity: 0.4 }} />
            <span style={{ fontSize: '12px', textAlign: 'center', lineHeight: 1.5 }}>系统设置已升级为全屏覆盖面板。<br/>可在侧边栏底部点击齿轮图标，或使用 <code>Ctrl + ,</code> 打开。</span>
          </div>
        )}
        {activeCardId === 'runtime' && (
          <RuntimePanel wsId={wsId} onShowToast={onShowToast} />
        )}
        {activeCardId === 'agent' && (
          <AgentCard
            onClose={() => {
              useLayoutStore.getState().setPanelAgentId(null);
              handleTabClick('chat');
            }}
          />
        )}
        {activeCardId === 'plan' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)', gap: '8px', padding: '32px' }}>
            <Lucide.Scroll size={24} style={{ opacity: 0.4 }} />
            <span style={{ fontSize: '12px', textAlign: 'center', lineHeight: 1.5 }}>计划面板已移除。<br/>计划进度现在显示在输入栏上方的状态 Ribbon 中。</span>
          </div>
        )}
      </div>
    </div>
  );
};
