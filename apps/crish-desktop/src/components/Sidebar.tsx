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
import { downloadSessionMarkdown } from '../api/sessionExport';
import { SettingsQuickMenu } from './SettingsQuickMenu';
import { isUpdateAvailable } from '../api/updateStore';
import { emitUiEvent, onUiEvent } from '../api/uiEvents';
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
  /** 顶栏搜索：过滤会话标题与消息正文等（见 sessionSearch）。 */
  searchQuery?: string;
}

const SIDEBAR_LIST_PREFS_KEY = 'crish_sidebar_list_prefs';

type SortType = 'active' | 'name';
type GroupType = 'folder' | 'none';
type FilterType = 'all' | 'pinned';

interface SidebarListPrefs {
  sortType: SortType;
  groupType: GroupType;
  filterType: FilterType;
}

const DEFAULT_LIST_PREFS: SidebarListPrefs = {
  sortType: 'active',
  groupType: 'folder',
  filterType: 'all',
};

/** 从 localStorage 安全读取侧栏排序/分组/筛选偏好 */
function loadSidebarListPrefs(): SidebarListPrefs {
  try {
    const raw = localStorage.getItem(SIDEBAR_LIST_PREFS_KEY);
    if (!raw) return { ...DEFAULT_LIST_PREFS };
    const parsed = JSON.parse(raw) as Partial<SidebarListPrefs>;
    return {
      sortType:
        parsed.sortType === 'name' || parsed.sortType === 'active'
          ? parsed.sortType
          : DEFAULT_LIST_PREFS.sortType,
      groupType:
        parsed.groupType === 'none' || parsed.groupType === 'folder'
          ? parsed.groupType
          : DEFAULT_LIST_PREFS.groupType,
      filterType:
        parsed.filterType === 'pinned' || parsed.filterType === 'all'
          ? parsed.filterType
          : DEFAULT_LIST_PREFS.filterType,
    };
  } catch {
    return { ...DEFAULT_LIST_PREFS };
  }
}

/**
 * 在新窗口打开会话只读快照（与 AgentCard.openAgentInNewWindow 一致）。
 * 完整交互式多窗口依赖独立 Webview；此处先提供可读副本。
 */
function openSessionInNewWindow(session: {
  title?: string;
  messages?: Array<{
    sender?: string;
    text?: string;
    status?: string;
    toolCalls?: Array<{ name?: string; status?: string; output?: string }>;
  }>;
}): void {
  const w = window.open('', '_blank', 'noopener,noreferrer,width=960,height=800');
  if (!w) return;
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const title = sessionListDisplayTitle(session);
  const lines: string[] = [];
  lines.push(`<h1>${esc(title)}</h1>`);
  lines.push(`<p class="meta">会话只读快照 · ${esc(String(session.messages?.length || 0))} 条消息</p>`);
  for (const m of session.messages || []) {
    if (m.sender === 'user') {
      lines.push(`<div class="u">${esc(m.text || '')}</div>`);
    } else {
      lines.push(`<div class="a">${esc(m.text || (m.status === 'processing' ? '生成中…' : ''))}</div>`);
      for (const tc of m.toolCalls || []) {
        lines.push(
          `<div class="t"><b>${esc(tc.name || 'tool')}</b> ${esc(tc.status || '')}<pre>${esc(
            (tc.output || '').slice(0, 2000),
          )}</pre></div>`,
        );
      }
    }
  }
  if (!(session.messages && session.messages.length)) {
    lines.push('<p class="meta">（暂无消息）</p>');
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>${esc(title)}</title>
<style>
body{font-family:system-ui,sans-serif;padding:20px;max-width:800px;margin:0 auto;color:#222;background:#fafafa}
h1{font-size:18px;margin:0 0 8px}.meta{color:#888;font-size:12px;margin:0 0 20px}
.u{background:#e8eef8;padding:10px 12px;border-radius:12px;margin:10px 0 10px auto;max-width:85%;width:fit-content;white-space:pre-wrap}
.a{background:#fff;border:1px solid #eee;padding:10px 12px;border-radius:12px;margin:10px 0;white-space:pre-wrap}
.t{font-size:12px;color:#666;margin:6px 0 6px 8px}pre{white-space:pre-wrap;font-size:11px;background:#f4f4f5;padding:8px;border-radius:6px}
</style></head><body>${lines.join('\n')}</body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const revoke = () => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  };
  try {
    w.addEventListener('load', revoke, { once: true });
  } catch {
    /* ignore */
  }
  w.location.href = url;
  window.setTimeout(revoke, 60_000);
}

/**
 * Sidebar design notes (distinct from Claude):
 * - Soft pill primary CTA (outline/elevated white), not solid black brand bar
 * - Quiet text nav, section labels as microcaps
 * - Projects = folders; Conversations = flat recents when ungrouped
 * - Footer: settings + optional dev mode chip — no gateway marketing text
 */
export const Sidebar: React.FC<SidebarProps> = React.memo(({
  onShowToast,
  hoverExpanded,
  onHoverEnter,
  onHoverLeave,
  onOpenRuntime: _onOpenRuntime,
  searchQuery = '',
}) => {
  const sessions = useLayoutStore((s) => s.sessions);
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const activeAgentId = useLayoutStore((s) => s.activeAgentId);
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const setActiveSessionId = useLayoutStore((s) => s.setActiveSessionId);
  const setActiveAgentId = useLayoutStore((s) => s.setActiveAgentId);
  const setPanelAgentId = useLayoutStore((s) => s.setPanelAgentId);
  const createSession = useLayoutStore((s) => s.createSession);
  const pinSession = useLayoutStore((s) => s.pinSession);
  const unpinSession = useLayoutStore((s) => s.unpinSession);
  const archiveSession = useLayoutStore((s) => s.archiveSession);
  const unarchiveSession = useLayoutStore((s) => s.unarchiveSession);
  const branchSession = useLayoutStore((s) => s.branchSession);
  const splitScreenWorkspace = useLayoutStore((s) => s.splitScreenWorkspace);
  const moveSessionRealtime = useLayoutStore((s) => s.moveSessionRealtime);

  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [agentMenu, setAgentMenu] = useState<AgentContextMenuState | null>(null);
  const [activeNav, setActiveNav] = useState('chat');
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const [sortDropdownCoords, setSortDropdownCoords] = useState<{ x: number; y: number } | null>(null);
  const [sortType, setSortType] = useState<SortType>(() => loadSidebarListPrefs().sortType);
  const [groupType, setGroupType] = useState<GroupType>(() => loadSidebarListPrefs().groupType);
  const [filterType, setFilterType] = useState<FilterType>(() => loadSidebarListPrefs().filterType);
  const [projects, setProjects] = useState<ProjectEntry[]>(() => listProjects());
  const [, setActiveProjectId] = useState<string | null>(() => getActiveProjectId());
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [projectsSectionCollapsed, setProjectsSectionCollapsed] = useState(false);
  const [generalCollapsed, setGeneralCollapsed] = useState(false);
  const [updateAvailable, setUpdateAvailableState] = useState(() => isUpdateAvailable());

  const menuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // 持久化排序/分组/筛选，刷新后恢复
  useEffect(() => {
    try {
      const prefs: SidebarListPrefs = { sortType, groupType, filterType };
      localStorage.setItem(SIDEBAR_LIST_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  }, [sortType, groupType, filterType]);

  useEffect(() => {
    return onUiEvent('project-changed', () => {
      setProjects(listProjects());
      setActiveProjectId(getActiveProjectId());
    });
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
    return onUiEvent('update-changed', () => {
      setUpdateAvailableState(isUpdateAvailable());
    });
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
        setActiveSessionId(sessionId);
        setActiveAgentId(null);
        splitScreenWorkspace(sessionId);
        break;
      case 'open-new': {
        // 在新窗口打开：只读会话快照（与 agent「新窗口打开」一致）
        openSessionInNewWindow(targetSession);
        break;
      }
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
      case 'export': {
        try {
          downloadSessionMarkdown(targetSession);
          onShowToast('已导出 Markdown');
        } catch {
          onShowToast('导出失败');
        }
        break;
      }
      default:
        break;
    }
  };

  const handleNewSession = () => {
    createSession({ title: '新会话' });
    setActiveNav('chat');
    emitUiEvent('open-chat');
  };

  const handleOpenScheduled = () => {
    setActiveNav('scheduled');
    // 主对话区展示定时任务，不进设置页
    emitUiEvent('open-scheduled');
  };

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    setActiveAgentId(null);
    setActiveNav('chat');
    emitUiEvent('open-chat');
  };

  const handleSelectAgent = (sessionId: string, agentId: string) => {
    setActiveSessionId(sessionId);
    setActiveAgentId(agentId);
  };

  const handleOpenAgentPanel = (sessionId: string, agentId: string) => {
    setActiveSessionId(sessionId);
    setPanelAgentId(agentId);
    emitUiEvent('open-agent-panel', { agentId });
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
          onAddProject={() => {
            emitUiEvent('pick-workspace');
          }}
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
});
