import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLayoutStore } from '../../../store/layoutStore';
import { useSidebarSessions } from '../../../store/sessionStore';
import { getActiveProjectId, listProjects, type ProjectEntry } from '../../../api/projectStore';
import { enterDraftMode, getSessionStoreState, setDraftFolder } from '../../../api/storeAccess';
import { sessionListDisplayTitle } from '../../../api/sessionTitle';
import { isPendingDraft } from '../../../store/draftSession';
import { clearAgentPanelFocus } from '../../../api/openAgentPanel';
import { emitUiEvent, onUiEvent } from '../../../api/uiEvents';
import { useResponsiveLayout } from '../../../hooks/useResponsiveLayout';
import { configService } from '../../../services/ConfigService';
import {
  clampContextMenuPosition,
  archiveUndoToastMessage,
  branchUndoToastMessage,
  BRANCH_TITLE_SUFFIX,
  type SessionContextMenuState,
  type SessionMenuAction,
} from '../SidebarContextMenus';
import type { ShowToastFn } from '../../../hooks/useToastQueue';

const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 360;
const SIDEBAR_WIDTH_DEFAULT = 260;
const SIDEBAR_RESIZE_STEP = 12;
const SIDEBAR_RESIZE_STEP_LARGE = 24;
const SIDEBAR_LIST_PREFS_KEY = 'crish_sidebar_list_prefs';

type SortType = 'active' | 'name';
type GroupType = 'folder' | 'none';
type FilterType = 'all' | 'pinned';

interface SidebarListPrefs { sortType: SortType; groupType: GroupType; filterType: FilterType; }

const DEFAULT_LIST_PREFS: SidebarListPrefs = { sortType: 'active', groupType: 'folder', filterType: 'all' };

function loadSidebarListPrefs(): SidebarListPrefs {
  try {
    const raw = localStorage.getItem(SIDEBAR_LIST_PREFS_KEY);
    if (!raw) return { ...DEFAULT_LIST_PREFS };
    const parsed = JSON.parse(raw) as Partial<SidebarListPrefs>;
    return {
      sortType: parsed.sortType === 'name' || parsed.sortType === 'active' ? parsed.sortType : DEFAULT_LIST_PREFS.sortType,
      groupType: parsed.groupType === 'none' || parsed.groupType === 'folder' ? parsed.groupType : DEFAULT_LIST_PREFS.groupType,
      filterType: parsed.filterType === 'pinned' || parsed.filterType === 'all' ? parsed.filterType : DEFAULT_LIST_PREFS.filterType,
    };
  } catch { return { ...DEFAULT_LIST_PREFS }; }
}

function openSessionInNewWindow(session: { title?: string; messages?: Array<{ sender?: string; text?: string; status?: string; toolCalls?: Array<{ name?: string; status?: string; output?: string }> }> }): void {
  const w = window.open('', '_blank', 'noopener,noreferrer,width=960,height=800');
  if (!w) return;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const title = sessionListDisplayTitle(session);
  const lines: string[] = [];
  lines.push(`<h1>${esc(title)}</h1>`);
  lines.push(`<p class="meta">会话只读快照 · ${esc(String(session.messages?.length || 0))} 条消息</p>`);
  for (const m of session.messages || []) {
    if (m.sender === 'user') lines.push(`<div class="u">${esc(m.text || '')}</div>`);
    else {
      lines.push(`<div class="a">${esc(m.text || (m.status === 'processing' ? '生成中…' : ''))}</div>`);
      for (const tc of m.toolCalls || []) lines.push(`<div class="t"><b>${esc(tc.name || 'tool')}</b> ${esc(tc.status || '')}<pre>${esc((tc.output || '').slice(0, 2000))}</pre></div>`);
    }
  }
  if (!(session.messages && session.messages.length)) lines.push('<p class="meta">（暂无消息）</p>');
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;padding:20px;max-width:800px;margin:0 auto;color:#222;background:#fafafa}
h1{font-size:18px;margin:0 0 8px}.meta{color:#888;font-size:12px;margin:0 0 20px}
.u{background:#e8eef8;padding:10px 12px;border-radius:12px;margin:10px 0 10px auto;max-width:85%;width:fit-content;white-space:pre-wrap}
.a{background:#fff;border:1px solid #eee;padding:10px 12px;border-radius:12px;margin:10px 0;white-space:pre-wrap}
.t{font-size:12px;color:#666;margin:6px 0 6px 8px}pre{white-space:pre-wrap;font-size:11px;background:#f4f4f5;padding:8px;border-radius:6px}
</style></head><body>${lines.join('\n')}</body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try { w.addEventListener('load', () => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, { once: true }); } catch { /* ignore */ }
  w.location.href = url;
  window.setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 60_000);
}

export function useSidebarState(
  onShowToast: ShowToastFn,
  searchQuery = '',
  searchInput = '',
  onSearchChange?: (val: string) => void,
  hoverExpanded?: boolean,
  onHoverEnter?: () => void,
  onHoverLeave?: () => void,
) {
  const searchTrimmed = searchQuery.trim();
  const isSearching = searchTrimmed.length > 0;
  const sessions = useSidebarSessions(isSearching);
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useLayoutStore((s) => s.setSidebarCollapsed);
  const setActiveSessionId = useLayoutStore((s) => s.setActiveSessionId);
  const pinSession = useLayoutStore((s) => s.pinSession);
  const unpinSession = useLayoutStore((s) => s.unpinSession);
  const archiveSession = useLayoutStore((s) => s.archiveSession);
  const unarchiveSession = useLayoutStore((s) => s.unarchiveSession);
  const branchSession = useLayoutStore((s) => s.branchSession);
  const renameSession = useLayoutStore((s) => s.renameSession);
  const splitScreenWorkspace = useLayoutStore((s) => s.splitScreenWorkspace);
  const moveSessionRealtime = useLayoutStore((s) => s.moveSessionRealtime);

  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
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
  const [sidebarWidthPx, setSidebarWidthPx] = useState(SIDEBAR_WIDTH_DEFAULT);
  const [overlayOpen, setOverlayOpen] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const newSessionLockRef = useRef(false);

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_LIST_PREFS_KEY, JSON.stringify({ sortType, groupType, filterType })); } catch { /* ignore */ }
  }, [sortType, groupType, filterType]);

  useEffect(() => { if (filterType === 'pinned') setPinnedCollapsed(false); }, [filterType]);

  useEffect(() => onUiEvent('project-changed', () => { setProjects(listProjects()); setActiveProjectId(getActiveProjectId()); }), []);

  const { sidebarBehavior } = useResponsiveLayout();

  useEffect(() => {
    try {
      const layout = configService.get('workspace.layout') as { sidebarWidth?: number } | undefined;
      const restoredWidth = layout?.sidebarWidth;
      if (typeof restoredWidth === 'number' && restoredWidth >= SIDEBAR_WIDTH_MIN && restoredWidth <= SIDEBAR_WIDTH_MAX) {
        document.documentElement.style.setProperty('--sidebar-width', `${restoredWidth}px`);
        setSidebarWidthPx(restoredWidth);
        return;
      }
      const raw = localStorage.getItem('crish_sidebar_width');
      const n = raw ? parseInt(raw, 10) : NaN;
      if (!Number.isNaN(n) && n >= SIDEBAR_WIDTH_MIN && n <= SIDEBAR_WIDTH_MAX) {
        document.documentElement.style.setProperty('--sidebar-width', `${n}px`);
        setSidebarWidthPx(n);
      } else {
        const cssW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10);
        if (!Number.isNaN(cssW) && cssW >= SIDEBAR_WIDTH_MIN) setSidebarWidthPx(Math.min(cssW, SIDEBAR_WIDTH_MAX));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (document.body.classList.contains('is-resizing')) return;
    if (sidebarCollapsed) document.documentElement.style.setProperty('--sidebar-width', '0px');
    else {
      document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidthPx}px`);
      window.dispatchEvent(new Event('crish-sidebar-resize'));
    }
  }, [sidebarCollapsed, sidebarWidthPx]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null);
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        const sortBtn = (e.target as HTMLElement).closest('.sort-btn');
        if (!sortBtn) setSortDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setContextMenu(null); setSortDropdownOpen(false); }
    };
    document.addEventListener('click', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('click', handleOutsideClick); document.removeEventListener('keydown', handleKeyDown); };
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    setRenamingSessionId(null);
    const { x, y } = clampContextMenuPosition(e.clientX, e.clientY);
    setContextMenu({ x, y, sessionId });
  }, []);

  const handleAction = useCallback((action: SessionMenuAction) => {
    if (!contextMenu) return;
    const { sessionId } = contextMenu;
    const targetSession = getSessionStoreState().sessionsById[sessionId];
    setContextMenu(null);
    if (!targetSession) return;
    switch (action) {
      case 'open-current': setActiveSessionId(sessionId); break;
      case 'open-split': setActiveSessionId(sessionId); clearAgentPanelFocus(); splitScreenWorkspace(sessionId); break;
      case 'open-new': openSessionInNewWindow(targetSession); break;
      case 'rename': setRenamingSessionId(sessionId); break;
      case 'pin': pinSession(sessionId); break;
      case 'unpin': unpinSession(sessionId); break;
      case 'archive': {
        const title = sessionListDisplayTitle(targetSession);
        archiveSession(sessionId);
        onShowToast(archiveUndoToastMessage(title), () => { unarchiveSession(sessionId); });
        break;
      }
      case 'branch': {
        const title = sessionListDisplayTitle(targetSession);
        const newTitle = `${title}${BRANCH_TITLE_SUFFIX}`;
        const oldId = sessionId;
        branchSession(sessionId, newTitle);
        const newBranchId = getSessionStoreState().activeSessionId;
        onShowToast(branchUndoToastMessage(title), () => {
          if (newBranchId && newBranchId !== oldId) archiveSession(newBranchId);
          setActiveSessionId(oldId);
        });
        break;
      }
      case 'export': {
        void (async () => {
          try {
            const { tryDownloadSessionMarkdown } = await import('../../../api/sessionExport');
            const result = tryDownloadSessionMarkdown(targetSession, new Date(), { sessionsById: useLayoutStore.getState().sessionsById });
            if (result.ok === false) onShowToast(result.error || '导出失败');
          } catch { onShowToast('导出失败'); }
        })();
        break;
      }
    }
  }, [contextMenu, onShowToast, setActiveSessionId, pinSession, unpinSession, archiveSession, unarchiveSession, branchSession, splitScreenWorkspace]);

  const persistSidebarWidth = useCallback((px: number) => {
    try {
      localStorage.setItem('crish_sidebar_width', String(px));
      const layout = configService.get('workspace.layout') as { sidebarWidth?: number };
      configService.set('workspace.layout', { ...layout, sidebarWidth: px });
    } catch { /* ignore */ }
  }, []);

  const applySidebarWidth = useCallback((px: number, opts?: { persist?: boolean; collapse?: boolean }) => {
    if (opts?.collapse) { useLayoutStore.setState({ sidebarCollapsed: true }); document.documentElement.style.setProperty('--sidebar-width', '0px'); return; }
    const capped = Math.min(Math.max(px, SIDEBAR_WIDTH_MIN), SIDEBAR_WIDTH_MAX);
    useLayoutStore.setState({ sidebarCollapsed: false });
    document.documentElement.style.setProperty('--sidebar-width', `${capped}px`);
    setSidebarWidthPx(capped);
    window.dispatchEvent(new Event('crish-sidebar-resize'));
    if (opts?.persist !== false) persistSidebarWidth(capped);
  }, [persistSidebarWidth]);

  const handleNewSession = useCallback(() => {
    if (newSessionLockRef.current) return;
    newSessionLockRef.current = true;
    try {
      if (filterType === 'pinned') setFilterType('all');
      setGeneralCollapsed(false);
      enterDraftMode(getActiveProjectId() || undefined);
      setActiveNav('chat');
      setRenamingSessionId(null);
      emitUiEvent('open-chat');
    } finally { queueMicrotask(() => { newSessionLockRef.current = false; }); }
  }, [filterType]);

  const handleCommitRename = useCallback((sessionId: string, title: string) => {
    setRenamingSessionId(null);
    if (!title) return;
    renameSession(sessionId, title);
  }, [renameSession]);

  const handleOpenScheduled = useCallback(() => { setActiveNav('scheduled'); emitUiEvent('open-scheduled'); }, []);
  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id);
    clearAgentPanelFocus();
    setActiveNav('chat');
    setRenamingSessionId(null);
    const target = getSessionStoreState().sessionsById[id];
    if (target && !target.isPinned) {
      setGeneralCollapsed(false);
      if (target.folder) setCollapsedProjects((prev) => prev[target.folder!] ? { ...prev, [target.folder!]: false } : prev);
    }
    emitUiEvent('open-chat');
  }, [setActiveSessionId]);

  const handleOpenProject = useCallback((id: string) => {
    setActiveProjectId(id);
    setCollapsedProjects((prev) => ({ ...prev, [id]: false }));
    if (isPendingDraft(getSessionStoreState().activeSessionId)) setDraftFolder(id);
  }, []);

  const handleToggleProjectCollapsed = useCallback((id: string) => setCollapsedProjects((prev) => ({ ...prev, [id]: !prev[id] })), []);
  const handleToggleGeneral = useCallback(() => setGeneralCollapsed((v) => !v), []);
  const handleTogglePinned = useCallback(() => setPinnedCollapsed((v) => !v), []);
  const handleToggleProjectsSection = useCallback(() => setProjectsSectionCollapsed((v) => !v), []);
  const handleAddProject = useCallback(() => emitUiEvent('pick-workspace'), []);
  const handleStartRename = useCallback((id: string) => setRenamingSessionId(id), []);
  const handleCancelRename = useCallback(() => setRenamingSessionId(null), []);

  const handleSidebarResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    document.body.classList.add('is-resizing');
    const startX = e.clientX;
    const startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || SIDEBAR_WIDTH_DEFAULT;
    let isCurrentlyCollapsed = useLayoutStore.getState().sidebarCollapsed;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      let newWidth = startWidth + dx;
      if (newWidth < 80) {
        if (!isCurrentlyCollapsed) { isCurrentlyCollapsed = true; useLayoutStore.setState({ sidebarCollapsed: true }); }
        document.documentElement.style.setProperty('--sidebar-width', '0px');
      } else {
        if (newWidth > SIDEBAR_WIDTH_MAX) newWidth = SIDEBAR_WIDTH_MAX;
        if (isCurrentlyCollapsed) { isCurrentlyCollapsed = false; useLayoutStore.setState({ sidebarCollapsed: false }); }
        document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
        window.dispatchEvent(new Event('crish-sidebar-resize'));
      }
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      document.body.classList.remove('is-resizing');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      const finalWidth = startWidth + (upEvent.clientX - startX);
      if (finalWidth < 80) applySidebarWidth(0, { collapse: true, persist: false });
      else applySidebarWidth(finalWidth, { persist: true });
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [applySidebarWidth]);

  const handleSidebarResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? SIDEBAR_RESIZE_STEP_LARGE : SIDEBAR_RESIZE_STEP;
    if (e.key === 'ArrowLeft') { e.preventDefault(); applySidebarWidth(sidebarWidthPx - step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); applySidebarWidth(sidebarWidthPx + step); }
    else if (e.key === 'Home') { e.preventDefault(); applySidebarWidth(SIDEBAR_WIDTH_MIN); }
    else if (e.key === 'End') { e.preventDefault(); applySidebarWidth(SIDEBAR_WIDTH_MAX); }
  }, [applySidebarWidth, sidebarWidthPx]);

  const handleSortBtnClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    setSortDropdownCoords({ x: rect.left, y: rect.top + rect.height + 4 });
    setSortDropdownOpen((open) => !open);
  }, []);

  const handleOverlayClose = useCallback(() => { setOverlayOpen(false); setSidebarCollapsed(true); }, [setSidebarCollapsed]);
  const handleHamburgerClick = useCallback(() => {
    if (sidebarBehavior === 'overlay') { setOverlayOpen(true); setSidebarCollapsed(false); }
    else setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarBehavior, sidebarCollapsed, setSidebarCollapsed]);

  const chromeHidden = Boolean(sidebarCollapsed && !hoverExpanded);
  const isOverlayActive = sidebarBehavior === 'overlay' && overlayOpen;
  const filterLabel = filterType === 'pinned' ? '仅置顶' : '全部会话';
  const densityHint = isSearching ? 'search' : filterType === 'pinned' ? 'pinned' : 'default';

  const searchStatusText = useMemo(() => {
    if (!isSearching) return '';
    const q = searchTrimmed.length > 24 ? `${searchTrimmed.slice(0, 24)}…` : searchTrimmed;
    return `正在筛选会话：${q}`;
  }, [isSearching, searchTrimmed]);

  return {
    sessions, activeSessionId, sidebarCollapsed, isSearching, searchQuery, searchInput, onSearchChange,
    contextMenu, sortDropdownOpen, sortDropdownCoords, sortType, groupType, filterType,
    projects, collapsedProjects, projectsSectionCollapsed, generalCollapsed, pinnedCollapsed,
    sidebarWidthPx, activeNav, renamingSessionId, hoverExpanded, onHoverEnter, onHoverLeave,
    chromeHidden, isOverlayActive, filterLabel, densityHint, searchStatusText, sidebarBehavior,
    menuRef, sortMenuRef, sidebarRef, moveSessionRealtime,
    handleAction, handleContextMenu, handleNewSession, handleCommitRename, handleOpenScheduled,
    handleSelectSession, handleOpenProject, handleToggleProjectCollapsed, handleToggleGeneral,
    handleTogglePinned, handleToggleProjectsSection, handleAddProject, handleStartRename,
    handleCancelRename, handleSidebarResizeStart, handleSidebarResizeKeyDown, handleSortBtnClick,
    handleOverlayClose, handleHamburgerClick, applySidebarWidth,
    setSortType, setGroupType, setFilterType, setSortDropdownOpen, setContextMenu,
  };
}
