import React, { useState, useEffect, useRef } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import * as Lucide from 'lucide-react';
import { canUseDemoMode, getAppMode, isDemoMode, switchAppMode } from '../api/appMode';
import {
  getActiveProjectId,
  listProjects,
  type ProjectEntry,
} from '../api/projectStore';
import { sessionListDisplayTitle } from '../api/sessionTitle';
import { SettingsQuickMenu } from './SettingsQuickMenu';
import { isUpdateAvailable } from '../api/updateStore';
import { SidebarNav } from './sidebar/SidebarNav';
import { SidebarSessionList } from './sidebar/SidebarSessionList';
import {
  SidebarContextMenus,
  type AgentContextMenuState,
  type SessionContextMenuState,
} from './sidebar/SidebarContextMenus';

interface SidebarProps {
  onShowToast: (message: string, onUndo?: () => void) => void;
  hoverExpanded?: boolean;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  onOpenRuntime?: () => void;
  /** Filter session titles (from top search). */
  searchQuery?: string;
}

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

  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [agentMenu, setAgentMenu] = useState<AgentContextMenuState | null>(null);
  const [activeNav, setActiveNav] = useState('chat');
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const [sortDropdownCoords, setSortDropdownCoords] = useState<{ x: number; y: number } | null>(null);
  const [sortType, setSortType] = useState<'active' | 'name'>('active');
  const [groupType, setGroupType] = useState<'folder' | 'none'>('folder');
  const [filterType, setFilterType] = useState<'all' | 'pinned'>('all');
  const [projects, setProjects] = useState<ProjectEntry[]>(() => listProjects());
  const [, setActiveProjectId] = useState<string | null>(() => getActiveProjectId());
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [projectsSectionCollapsed, setProjectsSectionCollapsed] = useState(false);
  const [generalCollapsed, setGeneralCollapsed] = useState(false);
  const [updateAvailable, setUpdateAvailableState] = useState(() => isUpdateAvailable());

  const menuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => {
      setProjects(listProjects());
      setActiveProjectId(getActiveProjectId());
    };
    window.addEventListener('crish-project-changed', sync);
    return () => window.removeEventListener('crish-project-changed', sync);
  }, []);

  // 侧栏宽独立于主题/密度；启动恢复用户拖拽宽度
  useEffect(() => {
    try {
      const raw = localStorage.getItem('crish_sidebar_width');
      const n = raw ? parseInt(raw, 10) : NaN;
      if (!Number.isNaN(n) && n >= 200 && n <= 360) {
        document.documentElement.style.setProperty('--sidebar-width', `${n}px`);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const sync = () => setUpdateAvailableState(isUpdateAvailable());
    window.addEventListener('crish-update-changed', sync);
    return () => window.removeEventListener('crish-update-changed', sync);
  }, []);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
        setAgentMenu(null);
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
    setAgentMenu(null);
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  };

  const handleContextMenuAgent = (e: React.MouseEvent, sessionId: string, agentId: string) => {
    setContextMenu(null);
    setAgentMenu({ x: e.clientX, y: e.clientY, sessionId, agentId });
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
        onShowToast(`已归档: ${sessionListDisplayTitle(targetSession)}`, () => {
          unarchiveSession(sessionId);
        });
        break;
      case 'branch': {
        const newTitle = `${sessionListDisplayTitle(targetSession)} - 分支`;
        branchSession(sessionId, newTitle);
        break;
      }
      default:
        break;
    }
  };

  const handleNewSession = () => {
    createSession({ title: '新会话' });
    setActiveNav('chat');
    window.dispatchEvent(new CustomEvent('crish-open-chat'));
  };

  const handleOpenScheduled = () => {
    setActiveNav('scheduled');
    // 主对话区展示定时任务，不进设置页
    window.dispatchEvent(new CustomEvent('crish-open-scheduled'));
  };

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    setActiveAgentId(null);
    setActiveNav('chat');
    window.dispatchEvent(new CustomEvent('crish-open-chat'));
  };

  const handleSelectAgent = (sessionId: string, agentId: string) => {
    setActiveSessionId(sessionId);
    setActiveAgentId(agentId);
  };

  const handleOpenAgentPanel = (sessionId: string, agentId: string) => {
    setActiveSessionId(sessionId);
    setPanelAgentId(agentId);
    window.dispatchEvent(
      new CustomEvent('crish-open-agent-panel', { detail: { agentId } }),
    );
  };

  const handleOpenAgentWindow = (sessionId: string, agentId: string) => {
    const ag = sessions.find((s) => s.id === sessionId)?.agents?.find((a) => a.id === agentId);
    if (ag) {
      void import('./AgentCard').then(({ openAgentInNewWindow }) => {
        openAgentInNewWindow(ag);
      });
    }
  };

  const handleCopyAgentSummary = (sessionId: string, agentId: string) => {
    const ag = sessions.find((s) => s.id === sessionId)?.agents?.find((a) => a.id === agentId);
    if (ag) {
      void navigator.clipboard.writeText(
        `${ag.description}\n${ag.summary || ''}\nrun:${ag.subagentRunId}`,
      );
      onShowToast('已复制 agent 摘要');
    }
  };

  const handleOpenProject = (id: string) => {
    setActiveProjectId(id);
    setCollapsedProjects((prev) => ({ ...prev, [id]: false }));
  };

  const handleToggleProjectCollapsed = (id: string) => {
    setCollapsedProjects((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSidebarResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth =
      parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) ||
      240;
    let isCurrentlyCollapsed = useLayoutStore.getState().sidebarCollapsed;
    const persistWidth = (px: number) => {
      try {
        localStorage.setItem('crish_sidebar_width', String(px));
      } catch {
        /* ignore */
      }
    };
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
        persistWidth(capped);
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

  return (
    <aside
      ref={sidebarRef}
      className={`sidebar crish-sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${hoverExpanded ? 'temp-expanded' : ''}`}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
    >
      <div className="sidebar-scroll">
        <SidebarNav
          activeNav={activeNav}
          onNewSession={handleNewSession}
          onOpenScheduled={handleOpenScheduled}
        />
        <SidebarSessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          activeAgentId={activeAgentId}
          searchQuery={searchQuery}
          sortType={sortType}
          groupType={groupType}
          filterType={filterType}
          projects={projects}
          collapsedProjects={collapsedProjects}
          generalCollapsed={generalCollapsed}
          pinnedCollapsed={pinnedCollapsed}
          projectsSectionCollapsed={projectsSectionCollapsed}
          onSelectSession={handleSelectSession}
          onSelectAgent={handleSelectAgent}
          onOpenAgentPanel={handleOpenAgentPanel}
          onContextMenuSession={handleContextMenu}
          onContextMenuAgent={handleContextMenuAgent}
          onToggleProjectCollapsed={handleToggleProjectCollapsed}
          onToggleGeneral={() => setGeneralCollapsed((v) => !v)}
          onTogglePinned={() => setPinnedCollapsed((v) => !v)}
          onToggleProjectsSection={() => setProjectsSectionCollapsed((v) => !v)}
          onOpenProject={handleOpenProject}
          onSortBtnClick={handleSortBtnClick}
          onNewSession={handleNewSession}
          onMoveSessionRealtime={moveSessionRealtime}
        />
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
        <div className="sidebar-footer-actions">
          <SettingsQuickMenu onShowToast={onShowToast} />
          {updateAvailable ? (
            <button
              type="button"
              className="sidebar-footer-update is-visible"
              title="有新版本可用"
              onClick={() => onShowToast('正在检查更新…')}
            >
              <Lucide.Download size={16} />
            </button>
          ) : null}
        </div>
      </div>

      <div
        className="sidebar-resizer"
        id="sidebar-resizer"
        onPointerDown={handleSidebarResizeStart}
        style={{ touchAction: 'none' }}
      />

      <SidebarContextMenus
        menuRef={menuRef}
        sortMenuRef={sortMenuRef}
        contextMenu={contextMenu}
        agentMenu={agentMenu}
        sessions={sessions}
        onSessionAction={handleAction}
        onOpenAgentMain={handleSelectAgent}
        onOpenAgentPanel={handleOpenAgentPanel}
        onOpenAgentWindow={handleOpenAgentWindow}
        onCopyAgentSummary={handleCopyAgentSummary}
        onCloseAgentMenu={() => setAgentMenu(null)}
        sortDropdownOpen={sortDropdownOpen}
        sortDropdownCoords={sortDropdownCoords}
        sortType={sortType}
        groupType={groupType}
        filterType={filterType}
        onSetSortType={setSortType}
        onSetGroupType={setGroupType}
        onSetFilterType={setFilterType}
        onCloseSortDropdown={() => setSortDropdownOpen(false)}
      />
    </aside>
  );
};
