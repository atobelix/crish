import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionState } from '../store/layoutStore';
import * as Lucide from 'lucide-react';
import { canUseDemoMode, getAppMode, isDemoMode, switchAppMode } from '../api/appMode';
import {
  GENERAL_FOLDER,
  getActiveProjectId,
  listProjects,
  openProject,
  type ProjectEntry,
} from '../api/projectStore';

interface SidebarProps {
  onShowToast: (message: string, onUndo?: () => void) => void;
  hoverExpanded?: boolean;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  onOpenRuntime?: () => void;
  /** Filter session titles (from top search). */
  searchQuery?: string;
}

type DragItem =
  | { type: 'session'; sessionId: string; folderName?: string }
  | { type: 'folder'; folderName: string };

/**
 * Sidebar design notes (distinct from Claude):
 * - Soft pill primary CTA (outline/elevated white), not solid black brand bar
 * - Quiet text nav, section labels as microcaps
 * - Projects = folders; Conversations = flat recents when ungrouped
 * - Footer: settings + optional dev mode chip — no gateway marketing text
 */
export const Sidebar: React.FC<SidebarProps> = ({
  onShowToast,
  hoverExpanded,
  onHoverEnter,
  onHoverLeave,
  onOpenRuntime: _onOpenRuntime,
  searchQuery = '',
}) => {
  const {
    sessions,
    folderOrder: _folderOrder,
    activeSessionId,
    activeAgentId,
    sidebarCollapsed,
    setActiveSessionId,
    setActiveAgentId,
    setPanelAgentId,
    createSession,
    pinSession,
    unpinSession,
    archiveSession,
    unarchiveSession,
    branchSession,
    splitScreenWorkspace,
    moveSessionRealtime,
  } = useLayoutStore();

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);

  const [_collapsedFolders, _setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [activeNav, setActiveNav] = useState('chat');
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [_sessionsCollapsed, _setSessionsCollapsed] = useState(false);
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const [sortDropdownCoords, setSortDropdownCoords] = useState<{ x: number; y: number } | null>(null);
  const [sortType, setSortType] = useState<'active' | 'name'>('active');
  const [groupType, setGroupType] = useState<'folder' | 'none'>('folder');
  const [filterType, setFilterType] = useState<'all' | 'pinned'>('all');
  const [activeDragItem, setActiveDragItem] = useState<DragItem | null>(null);
  const [dragOverPinned, setDragOverPinned] = useState(false);
  const [projects, setProjects] = useState<ProjectEntry[]>(() => listProjects());
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => getActiveProjectId());
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [projectsSectionCollapsed, setProjectsSectionCollapsed] = useState(false);
  const [generalCollapsed, setGeneralCollapsed] = useState(false);

  useEffect(() => {
    const sync = () => {
      setProjects(listProjects());
      setActiveProjectId(getActiveProjectId());
    };
    window.addEventListener('crish-project-changed', sync);
    return () => window.removeEventListener('crish-project-changed', sync);
  }, []);

  const menuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const pinnedZoneRef = useRef<HTMLDivElement>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);

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
        break;
      case 'open-new':
        break;
      case 'pin':
        pinSession(sessionId);
        break;
      case 'unpin':
        unpinSession(sessionId);
        break;
      case 'archive':
        archiveSession(sessionId);
        onShowToast(`已归档: ${targetSession.title}`, () => {
          unarchiveSession(sessionId);
        });
        break;
      case 'branch': {
        const newTitle = `${targetSession.title} - 分支`;
        branchSession(sessionId, newTitle);
        break;
      }
      default:
        break;
    }
  };

  const handleOpenSettings = (tab?: string) => {
    useLayoutStore.getState().openSettings(tab);
  };

  const handleNewSession = () => {
    createSession({ title: '新会话' });
    setActiveNav('chat');
  };

  const handleOpenScheduled = () => {
    setActiveNav('scheduled');
    // Timed tasks live under settings (not the runtime float)
    handleOpenSettings('schedule');
  };

  let visibleSessions = sessions.filter((s) => !s.isArchived);
  if (filterType === 'pinned') visibleSessions = visibleSessions.filter((s) => s.isPinned);
  const q = searchQuery.trim().toLowerCase();
  if (q) {
    visibleSessions = visibleSessions.filter(
      (s) => s.title.toLowerCase().includes(q) || s.folder.toLowerCase().includes(q),
    );
  }

  const sortedSessions =
    sortType === 'name'
      ? [...visibleSessions].sort((a, b) => a.title.localeCompare(b.title))
      : visibleSessions;

  const pinnedSessions = sortedSessions.filter((s) => s.isPinned);
  const unpinned = sortedSessions.filter((s) => !s.isPinned);

  const projectIdSet = new Set(projects.map((p) => p.id));
  const sessionsByProject = (projectId: string) =>
    unpinned.filter((s) => s.folder === projectId || s.folder === projects.find((p) => p.id === projectId)?.name);
  const generalSessions = unpinned.filter(
    (s) =>
      s.folder === GENERAL_FOLDER ||
      s.folder === '会话' ||
      s.folder === '常规会话' ||
      (!projectIdSet.has(s.folder) && !projects.some((p) => p.name === s.folder)),
  );

  const startSessionDrag = useCallback(
    (e: React.PointerEvent, sessionId: string, folderName?: string) => {
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
            dragOverlay.style.cssText = `position:fixed;width:${elRect.width}px;pointer-events:none;z-index:10000;opacity:0.9;box-shadow:0 8px 24px rgba(0,0,0,0.12);background:#fff;border:1px solid var(--border-color);border-radius:10px;padding:8px 12px;font-size:13px;`;
            document.body.appendChild(dragOverlay);
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
        const overPinned = pinnedZone
          ? hoveredEl.closest('.pinned-drop-zone') ||
            hoveredEl.closest('.pinned-list') ||
            hoveredEl === pinnedZone
          : false;
        setDragOverPinned(!!overPinned);
        if (overPinned) {
          const targetSessionItem = hoveredEl.closest('li.session-item');
          const targetSessionId = targetSessionItem?.getAttribute('data-session-id') || null;
          moveSessionRealtime(sessionId, targetSessionId, folderName || '会话', true);
        } else {
          const targetSessionItem = hoveredEl.closest('li.session-item');
          const targetFolderEl = hoveredEl.closest('[data-folder-name]');
          const targetSessionId = targetSessionItem?.getAttribute('data-session-id') || null;
          const targetFolder =
            targetFolderEl?.getAttribute('data-folder-name') || folderName || '会话';
          moveSessionRealtime(sessionId, targetSessionId, targetFolder, false);
        }
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (dragOverlay) dragOverlay.remove();
        setActiveDragItem(null);
        setDragOverPinned(false);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [moveSessionRealtime],
  );

  const handleSidebarResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth =
      parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) ||
      240;
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
        if (newWidth > 360) newWidth = 360;
        if (isCurrentlyCollapsed) {
          isCurrentlyCollapsed = false;
          useLayoutStore.setState({ sidebarCollapsed: false });
        }
        document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
      }
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      const finalWidth = startWidth + (upEvent.clientX - startX);
      if (finalWidth < 80) {
        useLayoutStore.setState({ sidebarCollapsed: true });
        document.documentElement.style.setProperty('--sidebar-width', '0px');
      } else {
        const capped = Math.min(Math.max(finalWidth, 200), 360);
        useLayoutStore.setState({ sidebarCollapsed: false });
        document.documentElement.style.setProperty('--sidebar-width', `${capped}px`);
      }
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleSortBtnClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    setSortDropdownCoords({ x: rect.left, y: rect.top + rect.height + 4 });
    setSortDropdownOpen(!sortDropdownOpen);
  };

  const renderSessionItem = (s: SessionState, isDraggable: boolean = true) => {
    const isBranched = !!s.branchParentId;
    const displayText = isBranched ? `分支: ${s.title.replace(/ - 分支$/, '')}` : s.title;
    const isDraggingThis = activeDragItem?.type === 'session' && activeDragItem.sessionId === s.id;
    const isRunning = s.messages?.some((m) => m.status === 'processing') ?? false;
    const agents = s.agents || [];
    const agentRunning = agents.some((a) => a.status === 'running');
    return (
      <li
        key={s.id}
        data-session-id={s.id}
        className={`session-item-wrap ${isDraggingThis ? 'drag-ghost-hidden' : ''}`}
      >
        <div
          className={`session-item ${s.id === activeSessionId && !activeAgentId ? 'active' : ''} ${isBranched ? 'branch-session' : ''}`}
          onClick={() => {
            setActiveSessionId(s.id);
            setActiveAgentId(null);
          }}
          onContextMenu={(e) => handleContextMenu(e, s.id)}
          onPointerDown={isDraggable ? (e) => startSessionDrag(e, s.id, s.folder) : undefined}
        >
          <span className="session-text" title={displayText}>
            {displayText}
          </span>
          <span className="session-time">
            {isRunning || agentRunning ? (
              <span className="session-running-spinner" title="处理中" />
            ) : (
              s.timestamp
            )}
          </span>
          <button
            type="button"
            className="session-actions-btn"
            onClick={(e) => {
              e.stopPropagation();
              handleContextMenu(e as unknown as React.MouseEvent, s.id);
            }}
          >
            <Lucide.MoreHorizontal size={12} />
          </button>
        </div>
        {agents.length > 0 ? (
          <ul className="session-agent-list" aria-label="协作 agent">
            {agents.slice(0, 12).map((ag) => (
              <li key={ag.id}>
                <button
                  type="button"
                  className={`session-agent-item ${
                    activeSessionId === s.id && activeAgentId === ag.id ? 'active' : ''
                  } session-agent-item--${ag.status}`}
                  title={ag.description}
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveSessionId(s.id);
                    setActiveAgentId(ag.id);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setActiveSessionId(s.id);
                    setPanelAgentId(ag.id);
                    // 右侧打开依赖工作区已有 agent 卡；由 CardPanel 全局 tab 逻辑补
                    window.dispatchEvent(
                      new CustomEvent('crish-open-agent-panel', { detail: { agentId: ag.id } }),
                    );
                  }}
                >
                  <Lucide.Bot size={11} className="session-agent-icon" />
                  <span className="session-agent-text">
                    {ag.description || ag.mode || 'agent'}
                  </span>
                  {ag.status === 'running' ? (
                    <span className="session-running-spinner" title="运行中" />
                  ) : (
                    <span className="session-agent-status">
                      {ag.status === 'failed' ? '失败' : '完成'}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <aside
      ref={sidebarRef}
      className={`sidebar crish-sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${hoverExpanded ? 'temp-expanded' : ''}`}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
    >
      <div className="sidebar-scroll">
        {/* Primary actions — soft CTA, not Claude-black brand stack */}
        <div className="sidebar-top-actions">
          <button type="button" className="sb-new-btn" onClick={handleNewSession}>
            <Lucide.Plus size={15} strokeWidth={2.25} />
            <span>新对话</span>
          </button>
          <button
            type="button"
            className={`sb-nav-link ${activeNav === 'scheduled' ? 'active' : ''}`}
            onClick={handleOpenScheduled}
          >
            <Lucide.Clock size={15} />
            <span>定时任务</span>
          </button>
        </div>

        {/* 1) 置顶 */}
        <section className="sb-section">
          <button
            type="button"
            className="sb-section-label"
            onClick={() => setPinnedCollapsed(!pinnedCollapsed)}
          >
            <span>置顶</span>
            <Lucide.ChevronDown size={12} className={pinnedCollapsed ? 'chev-collapsed' : ''} />
          </button>
          {!pinnedCollapsed && (
            <div
              ref={pinnedZoneRef}
              className={`pinned-drop-zone ${dragOverPinned ? 'drag-over' : ''}`}
            >
              <ul className="session-list pinned-list">
                {pinnedSessions.map((s) => renderSessionItem(s))}
              </ul>
              {pinnedSessions.length === 0 && (
                <div className="sb-empty-hint subtle">固定的对话会出现在这里</div>
              )}
            </div>
          )}
        </section>

        {/* 2) 项目 — user-added projects */}
        <section className="sb-section">
          <button
            type="button"
            className="sb-section-label"
            onClick={() => setProjectsSectionCollapsed(!projectsSectionCollapsed)}
          >
            <span>项目</span>
            <Lucide.ChevronDown
              size={12}
              className={projectsSectionCollapsed ? 'chev-collapsed' : ''}
            />
          </button>
          {!projectsSectionCollapsed && (
            <div className="sb-session-scroll">
              {projects.map((p) => {
                const open = !collapsedProjects[p.id];
                const sess = sessionsByProject(p.id);
                const isActive = activeProjectId === p.id;
                return (
                  <div key={p.id} className="folder-group" data-folder-name={p.id}>
                    <button
                      type="button"
                      className={`folder-header ${isActive ? 'is-active-project' : ''}`}
                      onClick={() => {
                        openProject(p.id);
                        setActiveProjectId(p.id);
                        setCollapsedProjects((prev) => ({ ...prev, [p.id]: false }));
                      }}
                      onDoubleClick={() =>
                        setCollapsedProjects((prev) => ({ ...prev, [p.id]: !prev[p.id] }))
                      }
                    >
                      <Lucide.Folder size={13} />
                      <span className="folder-name">{p.name}</span>
                      <span className="folder-count">{sess.length}</span>
                      <span
                        className="folder-collapse-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCollapsedProjects((prev) => ({ ...prev, [p.id]: !prev[p.id] }));
                        }}
                      >
                        <Lucide.ChevronDown size={12} className={open ? '' : 'chev-collapsed'} />
                      </span>
                    </button>
                    {open && (
                      <ul className="session-list folder-sessions">
                        {sess.map((s) => renderSessionItem(s, true))}
                      </ul>
                    )}
                  </div>
                );
              })}
              {projects.length === 0 && (
                <div className="sb-empty-hint subtle">在对话区选择或添加项目</div>
              )}
            </div>
          )}
        </section>

        {/* 3) 对话 — no-project chats */}
        <section className="sb-section sb-section-grow">
          <div className="sb-section-label-row">
            <button
              type="button"
              className="sb-section-label"
              onClick={() => setGeneralCollapsed(!generalCollapsed)}
            >
              <span>对话</span>
              <Lucide.ChevronDown size={12} className={generalCollapsed ? 'chev-collapsed' : ''} />
            </button>
            <button type="button" className="sort-btn" title="排序" onClick={handleSortBtnClick}>
              <Lucide.ArrowUpDown size={12} />
            </button>
          </div>
          {!generalCollapsed && (
            <div ref={sessionListRef} className="sb-session-scroll">
              <ul className="session-list folder-sessions">
                {generalSessions.map((s) => renderSessionItem(s))}
              </ul>
              {generalSessions.length === 0 && (
                <div className="sb-empty-hint subtle">不在项目中时的对话</div>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="sidebar-footer">
        {canUseDemoMode() && (
          <button
            type="button"
            className={`sb-mode-chip ${isDemoMode() ? 'is-demo' : ''}`}
            title="开发切换：正式 / 演示（正式包不会出现）"
            onClick={() => {
              const next = getAppMode() === 'demo' ? 'normal' : 'demo';
              onShowToast(next === 'demo' ? '切换到演示模式…' : '切换到正式模式…');
              switchAppMode(next);
            }}
          >
            {isDemoMode() ? '演示' : '正式'}
          </button>
        )}
        <button
          type="button"
          className="sidebar-footer-settings"
          title="设置"
          onClick={() => handleOpenSettings()}
        >
          <Lucide.Settings size={15} />
          <span>设置</span>
        </button>
      </div>

      <div
        className="sidebar-resizer"
        id="sidebar-resizer"
        onPointerDown={handleSidebarResizeStart}
        style={{ touchAction: 'none' }}
      />

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu open"
          style={{ left: contextMenu.x, top: contextMenu.y, position: 'fixed' }}
        >
          <button type="button" className="context-menu-item" onClick={() => handleAction('open-current')}>
            <Lucide.MessageSquare size={13} />
            <span>打开</span>
          </button>
          <button type="button" className="context-menu-item" onClick={() => handleAction('open-split')}>
            <Lucide.Columns size={13} />
            <span>拆分打开</span>
          </button>
          <div className="context-menu-divider" />
          {sessions.find((s) => s.id === contextMenu.sessionId)?.isPinned ? (
            <button type="button" className="context-menu-item" onClick={() => handleAction('unpin')}>
              <Lucide.PinOff size={13} />
              <span>取消固定</span>
            </button>
          ) : (
            <button type="button" className="context-menu-item" onClick={() => handleAction('pin')}>
              <Lucide.Pin size={13} />
              <span>固定</span>
            </button>
          )}
          <button type="button" className="context-menu-item" onClick={() => handleAction('archive')}>
            <Lucide.Archive size={13} />
            <span>归档</span>
          </button>
          <button type="button" className="context-menu-item" onClick={() => handleAction('branch')}>
            <Lucide.GitBranch size={13} />
            <span>分支</span>
          </button>
        </div>
      )}

      {sortDropdownOpen && sortDropdownCoords && (
        <div
          ref={sortMenuRef}
          className="sort-dropdown open"
          style={{ position: 'fixed', left: sortDropdownCoords.x, top: sortDropdownCoords.y, zIndex: 9999 }}
        >
          <button
            type="button"
            className={`sort-dropdown-item ${sortType === 'active' ? 'active' : ''}`}
            onClick={() => {
              setSortType('active');
              setSortDropdownOpen(false);
            }}
          >
            按活跃
          </button>
          <button
            type="button"
            className={`sort-dropdown-item ${sortType === 'name' ? 'active' : ''}`}
            onClick={() => {
              setSortType('name');
              setSortDropdownOpen(false);
            }}
          >
            按名称
          </button>
          <div className="context-menu-divider" />
          <button
            type="button"
            className={`sort-dropdown-item ${groupType === 'folder' ? 'active' : ''}`}
            onClick={() => {
              setGroupType('folder');
              setSortDropdownOpen(false);
            }}
          >
            按项目分组
          </button>
          <button
            type="button"
            className={`sort-dropdown-item ${groupType === 'none' ? 'active' : ''}`}
            onClick={() => {
              setGroupType('none');
              setSortDropdownOpen(false);
            }}
          >
            平铺列表
          </button>
          <div className="context-menu-divider" />
          <button
            type="button"
            className={`sort-dropdown-item ${filterType === 'all' ? 'active' : ''}`}
            onClick={() => {
              setFilterType('all');
              setSortDropdownOpen(false);
            }}
          >
            全部
          </button>
          <button
            type="button"
            className={`sort-dropdown-item ${filterType === 'pinned' ? 'active' : ''}`}
            onClick={() => {
              setFilterType('pinned');
              setSortDropdownOpen(false);
            }}
          >
            仅固定
          </button>
        </div>
      )}
    </aside>
  );
};
