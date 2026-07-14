import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionState } from '../store/layoutStore';
import * as Lucide from 'lucide-react';

interface SidebarProps {
  onShowToast: (message: string, onUndo?: () => void) => void;
  hoverExpanded?: boolean;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
}


// ─── Types for sidebar drag ───────────────────────────────────────────────────
type DragItem =
  | { type: 'session'; sessionId: string; folderName?: string }
  | { type: 'folder'; folderName: string };



export const Sidebar: React.FC<SidebarProps> = ({
  onShowToast,
  hoverExpanded,
  onHoverEnter,
  onHoverLeave,
}) => {
  const {
    sessions,
    folderOrder,
    activeSessionId,
    sidebarCollapsed,
    setActiveSessionId,
    createSession,
    pinSession,
    unpinSession,
    archiveSession,
    unarchiveSession,
    branchSession,
    splitScreenWorkspace,
    moveSessionRealtime,
    moveFolderRealtime,
    pinFolderSessions,
    unpinFolderSessions,
    workspaces,
    activeWorkspaceIndex,
    togglePanel,
  } = useLayoutStore();


  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);

  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [activeNav, setActiveNav] = useState('code');

  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);

  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const [sortDropdownCoords, setSortDropdownCoords] = useState<{ x: number; y: number } | null>(null);

  const [sortType, setSortType] = useState<'active' | 'name'>('active');
  const [groupType, setGroupType] = useState<'folder' | 'none'>('folder');
  const [filterType, setFilterType] = useState<'all' | 'pinned'>('all');

  // ── Drag state ──────────────────────────────────────────────────────────────
  const [activeDragItem, setActiveDragItem] = useState<DragItem | null>(null);
  const [dragOverPinned, setDragOverPinned] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const pinnedZoneRef = useRef<HTMLDivElement>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        const sortBtn = (e.target as HTMLElement).closest('.sort-btn');
        if (!sortBtn) setSortDropdownOpen(false);
      }
    };
    document.addEventListener('click', handleOutsideClick);
    return () => document.removeEventListener('click', handleOutsideClick);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  };

  const handleAction = (action: string) => {
    if (!contextMenu) return;
    const { sessionId } = contextMenu;
    const targetSession = sessions.find((s) => s.id === sessionId);
    setContextMenu(null);
    if (!targetSession) return;

    switch (action) {
      case 'open-current':
        setActiveSessionId(sessionId);
        break;
      case 'open-split':
        splitScreenWorkspace(sessionId);
        onShowToast(`已在拆分工作区打开会话: ${targetSession.title}`);
        break;
      case 'open-new':
        onShowToast(`已在新原生窗口打开会话: ${targetSession.title} (Tauri Mock)`);
        break;
      case 'pin':
        pinSession(sessionId);
        onShowToast(`已置顶会话: ${targetSession.title}`);
        break;
      case 'unpin':
        unpinSession(sessionId);
        onShowToast(`已取消置顶: ${targetSession.title}`);
        break;
      case 'archive':
        archiveSession(sessionId);
        onShowToast(`已归档会话: ${targetSession.title}`, () => {
          unarchiveSession(sessionId);
        });
        break;
      case 'branch':
        const newTitle = `${targetSession.title} - 分支`;
        branchSession(sessionId, newTitle);
        onShowToast(`已创建会话分支: ${newTitle}`);
        break;
      default:
        break;
    }
  };

  const toggleFolder = (folderName: string) => {
    setCollapsedFolders((prev) => ({
      ...prev,
      [folderName]: !prev[folderName],
    }));
  };

  const handleOpenSettings = (tab?: string) => {
    useLayoutStore.getState().openSettings(tab);
    const labels: Record<string, string> = {
      appearance: '外观',
      models: '模型',
      profile: '账户',
      security: '安全',
    };
    onShowToast(tab ? `已打开设置 · ${labels[tab] || tab}` : '已打开设置');
  };

  const handleNewSession = () => {
    const id = createSession({ title: '新会话' });
    setActiveNav('new');
    onShowToast('已创建新会话');
    // Ensure focus lands on chat; id available for future deep-link
    void id;
  };

  const handleOpenScheduled = () => {
    setActiveNav('scheduled');
    const ws = workspaces[activeWorkspaceIndex];
    if (ws) {
      togglePanel(ws.id, 'pi-runtime', true);
      useLayoutStore.setState((state) => {
        const targetWs = state.workspaces.find((w) => w.id === ws.id);
        if (!targetWs) return;
        for (const col of targetWs.columns) {
          for (const g of col.groups) {
            if (g.cards.some((c) => c.id === 'pi-runtime')) {
              g.activeCardId = 'pi-runtime';
              return;
            }
          }
        }
      });
      onShowToast('已打开运行状态 · 计划任务');
    }
  };

  // ── Derived data ────────────────────────────────────────────────────────────
  let visibleSessions = sessions.filter((s) => !s.isArchived);
  if (filterType === 'pinned') visibleSessions = visibleSessions.filter((s) => s.isPinned);

  const sortedSessions = sortType === 'name'
    ? [...visibleSessions].sort((a, b) => a.title.localeCompare(b.title))
    : visibleSessions;

  const pinnedSessions = sortedSessions.filter((s) => s.isPinned);
  const normalSessions = sortedSessions.filter((s) => !s.isPinned);

  const folderMap: Record<string, SessionState[]> = {};
  normalSessions.forEach((s) => {
    if (!folderMap[s.folder]) folderMap[s.folder] = [];
    folderMap[s.folder].push(s);
  });

  const orderedFolderNames = folderOrder.filter((f) => folderMap[f]);

  // ── Sidebar session drag (pointer-based, DOM-cloned, real-time preview) ──────
  const startSessionDrag = useCallback((
    e: React.PointerEvent,
    sessionId: string,
    folderName?: string
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let dragOverlay: HTMLDivElement | null = null;

    const el = (e.currentTarget as HTMLElement).closest('li') as HTMLElement;
    const elRect = el?.getBoundingClientRect();

    const offsetX = startX - (elRect?.left ?? startX);
    const offsetY = startY - (elRect?.top ?? startY);

    const move = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;

      if (!dragging && Math.sqrt(dx * dx + dy * dy) > 6) {
        dragging = true;
        setActiveDragItem({ type: 'session', sessionId, folderName });

        if (el) {
          dragOverlay = el.cloneNode(true) as HTMLDivElement;
          dragOverlay.className = 'sidebar-drag-ghost';
          dragOverlay.style.cssText = `
            position: fixed;
            width: ${elRect.width}px;
            pointer-events: none;
            z-index: 10000;
            opacity: 0.85;
            box-shadow: 0 8px 20px rgba(0,0,0,0.15);
            background: var(--bg-secondary, #f9f9f9);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: ${getComputedStyle(el).padding};
            display: flex;
            align-items: center;
            font-size: ${getComputedStyle(el).fontSize};
            color: var(--text-primary);
          `;
          dragOverlay.querySelectorAll('input, textarea, button').forEach((item) => {
            (item as HTMLInputElement).disabled = true;
          });
          document.body.appendChild(dragOverlay);
          document.body.classList.add('dragging-card');
        }
      }

      if (!dragging || !dragOverlay) return;

      dragOverlay.style.left = `${me.clientX - offsetX}px`;
      dragOverlay.style.top = `${me.clientY - offsetY}px`;

      dragOverlay.style.display = 'none';
      const hoveredEl = document.elementFromPoint(me.clientX, me.clientY);
      dragOverlay.style.display = 'flex';

      if (!hoveredEl) return;

      const pinnedZone = pinnedZoneRef.current;
      const overPinned = pinnedZone ? (hoveredEl.closest('.pinned-drop-zone') || hoveredEl.closest('.pinned-list') || hoveredEl === pinnedZone) : false;
      setDragOverPinned(!!overPinned);

      if (overPinned) {
        const targetSessionItem = hoveredEl.closest('li.session-item');
        const targetSessionId = targetSessionItem?.getAttribute('data-session-id') || null;
        moveSessionRealtime(sessionId, targetSessionId, folderName || '常规会话', true);
      } else {
        const folderGroup = hoveredEl.closest('.folder-group');
        const targetFolder = folderGroup?.getAttribute('data-folder-name') || '常规会话';
        
        const targetSessionItem = hoveredEl.closest('li.session-item');
        const targetSessionId = targetSessionItem?.getAttribute('data-session-id') || null;

        moveSessionRealtime(sessionId, targetSessionId, targetFolder, false);
      }
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);

      setActiveDragItem(null);
      setDragOverPinned(false);
      if (dragOverlay) dragOverlay.remove();
      document.body.classList.remove('dragging-card');
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [sessions, pinSession, unpinSession, onShowToast, moveSessionRealtime]);

  // ── Sidebar folder drag (pointer-based, DOM-cloned, real-time preview) ──────
  const startFolderDrag = useCallback((e: React.PointerEvent, folderName: string) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let dragOverlay: HTMLDivElement | null = null;

    const el = (e.currentTarget as HTMLElement).closest('.folder-group') as HTMLElement;
    const elRect = el?.getBoundingClientRect();
    const offsetX = startX - (elRect?.left ?? startX);
    const offsetY = startY - (elRect?.top ?? startY);

    const move = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;

      if (!dragging && Math.sqrt(dx * dx + dy * dy) > 6) {
        dragging = true;
        setActiveDragItem({ type: 'folder', folderName });

        if (el) {
          dragOverlay = el.cloneNode(true) as HTMLDivElement;
          dragOverlay.className = 'sidebar-drag-ghost folder-ghost';
          dragOverlay.style.cssText = `
            position: fixed;
            width: ${elRect.width}px;
            pointer-events: none;
            z-index: 10000;
            opacity: 0.85;
            box-shadow: 0 8px 20px rgba(0,0,0,0.15);
            background: var(--bg-secondary, #f9f9f9);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            overflow: hidden;
          `;
          dragOverlay.querySelectorAll('input, textarea, button').forEach((item) => {
            (item as HTMLInputElement).disabled = true;
          });
          document.body.appendChild(dragOverlay);
          document.body.classList.add('dragging-card');
        }
      }

      if (!dragging || !dragOverlay) return;

      dragOverlay.style.left = `${me.clientX - offsetX}px`;
      dragOverlay.style.top = `${me.clientY - offsetY}px`;

      dragOverlay.style.display = 'none';
      const hoveredEl = document.elementFromPoint(me.clientX, me.clientY);
      dragOverlay.style.display = 'block';

      if (!hoveredEl) return;

      const pinnedZone = pinnedZoneRef.current;
      const overPinned = pinnedZone ? (hoveredEl.closest('.pinned-drop-zone') || hoveredEl.closest('.pinned-list') || hoveredEl === pinnedZone) : false;
      setDragOverPinned(!!overPinned);

      if (overPinned) {
        pinFolderSessions(folderName);
      } else {
        unpinFolderSessions(folderName);
        const folderGroup = hoveredEl.closest('.folder-group');
        const targetFolderName = folderGroup?.getAttribute('data-folder-name') || null;

        if (targetFolderName && targetFolderName !== folderName) {
          moveFolderRealtime(folderName, targetFolderName);
        }
      }
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setActiveDragItem(null);
      setDragOverPinned(false);
      if (dragOverlay) dragOverlay.remove();
      document.body.classList.remove('dragging-card');
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [moveFolderRealtime, pinFolderSessions, unpinFolderSessions]);

  // ── Sidebar resize ──────────────────────────────────────────────────────────
  const handleSidebarResizeStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarRef.current?.getBoundingClientRect().width || 200;

    const wrapper = sidebarRef.current?.parentElement;
    if (wrapper) wrapper.style.transition = 'none';
    if (sidebarRef.current) sidebarRef.current.style.transition = 'none';

    let isCurrentlyCollapsed = useLayoutStore.getState().sidebarCollapsed;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      let newWidth = startWidth + dx;

      if (newWidth < 80) {
        if (!isCurrentlyCollapsed) {
          isCurrentlyCollapsed = true;
          useLayoutStore.setState({ sidebarCollapsed: true });
        }
        document.documentElement.style.setProperty('--sidebar-width', '0px');
      } else {
        if (newWidth > 400) newWidth = 400;
        if (isCurrentlyCollapsed) {
          isCurrentlyCollapsed = false;
          useLayoutStore.setState({ sidebarCollapsed: false });
        }
        document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
      }
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      cleanup();
      const dx = upEvent.clientX - startX;
      const finalWidth = startWidth + dx;
      if (finalWidth < 80) {
        useLayoutStore.setState({ sidebarCollapsed: true });
        document.documentElement.style.setProperty('--sidebar-width', '0px');
      } else {
        const cappedWidth = Math.min(Math.max(finalWidth, 80), 400);
        useLayoutStore.setState({ sidebarCollapsed: false });
        document.documentElement.style.setProperty('--sidebar-width', `${cappedWidth}px`);
      }
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      if (wrapper) wrapper.style.transition = '';
      if (sidebarRef.current) sidebarRef.current.style.transition = '';
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleSortBtnClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    setSortDropdownCoords({
      x: rect.left + rect.width - 140,
      y: rect.top + rect.height + 4,
    });
    setSortDropdownOpen(!sortDropdownOpen);
  };

  const handleSectionHeaderClick = (e: React.MouseEvent, section: 'pinned' | 'sessions') => {
    if ((e.target as HTMLElement).closest('.sort-btn') || (e.target as HTMLElement).closest('.sort-dropdown')) return;
    if (section === 'pinned') setPinnedCollapsed(!pinnedCollapsed);
    else setSessionsCollapsed(!sessionsCollapsed);
  };

  // ── Session item renderer ───────────────────────────────────────────────────
  const renderSessionItem = (s: SessionState, isDraggable: boolean = true) => {
    const isBranched = !!s.branchParentId;
    const displayText = isBranched ? `分支: ${s.title.replace(/ - 分支$/, '')}` : s.title;
    const isDraggingThis = activeDragItem?.type === 'session' && activeDragItem.sessionId === s.id;
    // Check if this session has any message actively being processed
    const isRunning = s.messages?.some((m: any) => m.status === 'processing') ?? false;
    return (
      <li
        key={s.id}
        data-session-id={s.id}
        className={`session-item ${s.id === activeSessionId ? 'active' : ''} ${isBranched ? 'branch-session' : ''} ${isDraggingThis ? 'drag-ghost-hidden' : ''}`}
        onClick={() => setActiveSessionId(s.id)}
        onContextMenu={(e) => handleContextMenu(e, s.id)}
        onPointerDown={isDraggable ? (e) => startSessionDrag(e, s.id, s.folder) : undefined}
        style={{ touchAction: 'none', userSelect: 'none' }}
      >
        <span className="session-text" title={displayText}>{displayText}</span>
        <span className="session-time">
          {isRunning
            ? <span className="session-running-spinner" title="AI正在处理中" />
            : s.timestamp
          }
        </span>
        <button
          className="session-actions-btn"
          onClick={(e) => {
            e.stopPropagation();
            handleContextMenu(e as any, s.id);
          }}
        >
          <Lucide.MoreHorizontal size={12} />
        </button>
      </li>
    );
  };


  return (
    <aside
      ref={sidebarRef}
      className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${hoverExpanded ? 'temp-expanded' : ''}`}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
    >
      <div className="sidebar-scroll">
        {/* Navigation Section */}
        <nav className="sidebar-nav">
          <a
            href="#"
            className={`nav-item ${activeNav === 'code' ? 'active' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('code');
            }}
          >
            <Lucide.Code2 size={15} className="nav-icon" />
            <span>工作区</span>
          </a>
          <a
            href="#"
            className={`nav-item ${activeNav === 'new' ? 'active' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              handleNewSession();
            }}
          >
            <Lucide.Plus size={15} className="nav-icon" />
            <span>新建会话</span>
          </a>
          <a
            href="#"
            className={`nav-item ${activeNav === 'scheduled' ? 'active' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              handleOpenScheduled();
            }}
          >
            <Lucide.Clock size={15} className="nav-icon" />
            <span>计划任务</span>
          </a>
          <a
            href="#"
            className={`nav-item ${activeNav === 'customize' ? 'active' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('customize');
              handleOpenSettings('appearance');
            }}
          >
            <Lucide.Sliders size={15} className="nav-icon" />
            <span>个性化</span>
          </a>
        </nav>

        {/* Pinned Sessions (drop zone) */}
        <div className="sidebar-section">
          <div
            className={`section-header collapsible-header ${pinnedCollapsed ? 'collapsed' : ''}`}
            onClick={(e) => handleSectionHeaderClick(e, 'pinned')}
          >
            <h3 className="section-title">已固定</h3>
            <button className="collapse-btn"><Lucide.ChevronDown size={12} /></button>
          </div>
          {!pinnedCollapsed && (
            <div
              ref={pinnedZoneRef}
              className={`pinned-drop-zone ${dragOverPinned ? 'drag-over' : ''}`}
            >
              <ul className="session-list pinned-list" style={{ minHeight: activeDragItem ? '24px' : '8px' }}>
                {pinnedSessions.map((s) => renderSessionItem(s))}
              </ul>
            </div>
          )}
        </div>

        {/* Folder Groups */}
        <div className="sidebar-section">
          <div
            className={`section-header collapsible-header ${sessionsCollapsed ? 'collapsed' : ''}`}
            onClick={(e) => handleSectionHeaderClick(e, 'sessions')}
          >
            <h3 className="section-title">我的会话</h3>
            <div className="header-actions-right" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <button className="collapse-btn"><Lucide.ChevronDown size={12} /></button>
              <div className="sort-btn-wrapper" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <button className="sort-btn" title="筛选与排序" onClick={handleSortBtnClick}>
                  <Lucide.ArrowUpDown size={11} />
                </button>
              </div>
            </div>
          </div>

          {!sessionsCollapsed && (
            <div ref={sessionListRef} className="section-content-wrapper">
              {groupType === 'none' ? (
                <ul className="session-list folder-sessions">
                  {normalSessions.map((s) => renderSessionItem(s))}
                </ul>
              ) : (
                orderedFolderNames.map((folderName) => {
                  const isCollapsed = !!collapsedFolders[folderName];
                  const folderSessions = folderMap[folderName] || [];
                  const isDraggingThisFolder = activeDragItem?.type === 'folder' && activeDragItem.folderName === folderName;
                  return (
                    <div
                      key={folderName}
                      className={`folder-group ${isDraggingThisFolder ? 'drag-ghost-hidden' : ''}`}
                      data-folder-name={folderName}
                    >
                      <div
                        className={`folder-header ${isCollapsed ? 'collapsed' : ''}`}
                        onClick={() => toggleFolder(folderName)}
                        onPointerDown={(e) => {
                          // Only drag if not clicking the collapse button
                          if ((e.target as HTMLElement).closest('.folder-collapse-btn')) return;
                          startFolderDrag(e, folderName);
                        }}
                        style={{ touchAction: 'none', userSelect: 'none', cursor: 'grab' }}
                      >
                        {folderName !== '常规会话' && (
                          <span className="folder-icon-wrap">
                            {isCollapsed ? <Lucide.Folder size={13} /> : <Lucide.FolderOpen size={13} />}
                          </span>
                        )}
                        <span className="folder-name">{folderName}</span>
                        <button className="folder-collapse-btn"><Lucide.ChevronDown size={12} /></button>
                      </div>

                      {!isCollapsed && (
                        <ul className="session-list folder-sessions">
                          {folderSessions.map((s) => renderSessionItem(s, true))}
                        </ul>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      {/* Sidebar Footer */}
      <div className="sidebar-footer">
        <div className="gateway-status">
          <div className="flower-icon-wrapper">
            <svg viewBox="0 0 24 24" className="flower-svg" fill="currentColor">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2a4 4 0 0 1 4 4v1a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4zm0 20a4 4 0 0 1-4-4v-1a4 4 0 0 1 8 0v1a4 4 0 0 1-4 4zm10-10a4 4 0 0 1-4 4h-1a4 4 0 0 1 0-8h1a4 4 0 0 1 4 4zM2 12a4 4 0 0 1 4-4h1a4 4 0 0 1 0 8H6a4 4 0 0 1-4-4z" />
            </svg>
          </div>
          <span className="gateway-text">Cowork 3P | Gateway</span>
        </div>
        <button
          type="button"
          className="settings-btn"
          title="设置"
          onClick={() => handleOpenSettings()}
        >
          <Lucide.Settings size={15} />
        </button>
      </div>

      {/* Sidebar Resizer Handle */}
      <div
        className="sidebar-resizer"
        id="sidebar-resizer"
        onPointerDown={handleSidebarResizeStart}
        style={{ touchAction: 'none' }}
      />

      {/* Context Menu Overlay */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu open"
          style={{
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            position: 'fixed',
          }}
        >
          <button className="context-menu-item" onClick={() => handleAction('open-current')}>
            <Lucide.FolderOpen size={13} />
            <span>在当前工作区打开</span>
          </button>
          <button className="context-menu-item" onClick={() => handleAction('open-split')}>
            <Lucide.Columns size={13} />
            <span>在拆分窗口打开</span>
          </button>
          <button className="context-menu-item" onClick={() => handleAction('open-new')}>
            <Lucide.ExternalLink size={13} />
            <span>在新窗口打开</span>
          </button>
          <div className="context-menu-divider" />
          {sessions.find((s) => s.id === contextMenu.sessionId)?.isPinned ? (
            <button className="context-menu-item" onClick={() => handleAction('unpin')}>
              <Lucide.PinOff size={13} />
              <span>取消固定</span>
            </button>
          ) : (
            <button className="context-menu-item" onClick={() => handleAction('pin')}>
              <Lucide.Pin size={13} />
              <span>固定会话</span>
            </button>
          )}
          <button className="context-menu-item" onClick={() => handleAction('archive')}>
            <Lucide.Archive size={13} />
            <span>存档会话</span>
          </button>
          <button className="context-menu-item" onClick={() => handleAction('branch')}>
            <Lucide.GitBranch size={13} />
            <span>建立对话分支</span>
          </button>
        </div>
      )}

      {/* Sort/Filter Cascading Dropdown Overlay */}
      {sortDropdownOpen && sortDropdownCoords && (
        <div
          ref={sortMenuRef}
          className="sort-dropdown open"
          style={{
            left: `${sortDropdownCoords.x}px`,
            top: `${sortDropdownCoords.y}px`,
          }}
        >
          {/* 排序方式 submenu */}
          <div className="sort-dropdown-item">
            <span>排序方式</span>
            <Lucide.ChevronRight size={10} className="arrow-right" />
            <div className="sort-submenu">
              <div
                className={`sort-dropdown-item ${sortType === 'active' ? 'active' : ''}`}
                onClick={() => { setSortType('active'); setSortDropdownOpen(false); }}
              >
                按最近活跃时间
              </div>
              <div
                className={`sort-dropdown-item ${sortType === 'name' ? 'active' : ''}`}
                onClick={() => { setSortType('name'); setSortDropdownOpen(false); }}
              >
                按名称 A-Z
              </div>
            </div>
          </div>

          {/* 分组方式 submenu */}
          <div className="sort-dropdown-item">
            <span>分组方式</span>
            <Lucide.ChevronRight size={10} className="arrow-right" />
            <div className="sort-submenu">
              <div
                className={`sort-dropdown-item ${groupType === 'folder' ? 'active' : ''}`}
                onClick={() => { setGroupType('folder'); setSortDropdownOpen(false); }}
              >
                按文件夹分组
              </div>
              <div
                className={`sort-dropdown-item ${groupType === 'none' ? 'active' : ''}`}
                onClick={() => { setGroupType('none'); setSortDropdownOpen(false); }}
              >
                不分组
              </div>
            </div>
          </div>

          {/* 过滤规则 submenu */}
          <div className="sort-dropdown-item">
            <span>过滤规则</span>
            <Lucide.ChevronRight size={10} className="arrow-right" />
            <div className="sort-submenu">
              <div
                className={`sort-dropdown-item ${filterType === 'all' ? 'active' : ''}`}
                onClick={() => { setFilterType('all'); setSortDropdownOpen(false); }}
              >
                显示所有会话
              </div>
              <div
                className={`sort-dropdown-item ${filterType === 'pinned' ? 'active' : ''}`}
                onClick={() => { setFilterType('pinned'); setSortDropdownOpen(false); }}
              >
                仅显示已固定
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
