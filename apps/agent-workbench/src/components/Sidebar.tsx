import { useState, useEffect, useRef } from 'preact/hooks';
import { appState, type Session } from '../core/app-state';
import { tauriBridge } from '../core/tauri-bridge';
import { eventBus, Events } from '../core/event-bus';
import { showToast } from './ToastContainer';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { isBridgeDiagnostic } from '../core/bridge-utils';
import {
  WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION,
  type WorkbenchSessionAction,
  type WorkbenchSessionActionKind,
} from '../shared/workbench-contract';
import {
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconPlus,
  IconSearch,
  IconChevronDown,
  IconTerminal,
  IconSettings,
  IconTrash,
  IconEdit,
  IconExternalLink,
  IconMoreVertical,
  IconX,
  IconUser,
  IconSun,
  IconMoon,
  IconPin,
  IconArchive,
} from './icons';
import { formatTime } from './utils';

// ==================== Context Menu ====================

interface ContextMenuState {
  sessionId: string;
  x: number;
  y: number;
}

interface ProjectMenuState {
  folder: string;
  x: number;
  y: number;
}

// ==================== Sidebar Component ====================

export default function Sidebar() {
  const [sessions, setSessions] = useState<Session[]>(appState.getVisibleSessions());
  const [currentSession, setCurrentSession] = useState(appState.getState().currentSession);
  const [workMode, setWorkMode] = useState(appState.workMode);
  const [workingDirectory, setWorkingDirectory] = useState(appState.getState().workingDirectory);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [theme, setTheme] = useState(appState.getState().theme);
  const [openedFolders, setOpenedFolders] = useState<string[]>(appState.getState().openedFolders);
  const [expandMenuOpen, setExpandMenuOpen] = useState(false);
  const [pendingSessionActions, setPendingSessionActions] = useState<Record<string, string>>({});
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
  const expandMenuRef = useRef<HTMLDivElement>(null);
  const pendingSessionActionsRef = useRef<Record<string, string>>({});
  const sessionRefreshProjectRef = useRef<string>('');

  // Subscribe to state changes
  useEffect(() => {
    const refreshSessions = () => setSessions(appState.getVisibleSessions());
    const u1 = appState.subscribe('sessions', refreshSessions);
    const u2 = appState.subscribe('currentSession', setCurrentSession);
    const u3 = appState.subscribe('workMode', (mode) => {
      setWorkMode(mode);
      refreshSessions();
    });
    const u4 = appState.subscribe('workingDirectory', (dir) => {
      setWorkingDirectory(dir);
      refreshSessions();
    });
    const u5 = appState.subscribe('theme', setTheme);
    const u6 = appState.subscribe('openedFolders', (folders) => {
      setOpenedFolders(folders);
    });
    return () => { u1(); u2(); u3(); u4(); u5(); u6(); };
  }, []);

  // Close context menus on outside click
  useEffect(() => {
    if (!contextMenu && !projectMenu) return;
    const handler = () => {
      setContextMenu(null);
      setProjectMenu(null);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu, projectMenu]);

  // Close expand menu on outside click
  useEffect(() => {
    if (!expandMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (expandMenuRef.current && !expandMenuRef.current.contains(e.target as Node)) {
        setExpandMenuOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [expandMenuOpen]);

  // ---- Handlers ----

  const handleOpenFolder = async () => {
    const folder = await tauriBridge.selectFolder();
    if (folder) {
      appState.addOpenedFolder(folder);
      appState.setState('workingDirectory', folder);
      // workMode 由 currentSession.projectId 决定，创建项目会话切换到 agent 模式
      const projectSessions = appState.getProjectSessions(folder);
      if (projectSessions.length > 0) {
        appState.switchSession(projectSessions[0].id);
      } else {
        appState.createSession('新对话', folder);
      }
      void refreshDaemonSessionsForSidebar(folder);
    }
  };

  const handleThemeChange = (newTheme: string) => {
    appState.setState('theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  const createSessionWithProject = (projectId: string | null) => {
    if (projectId) {
      appState.addOpenedFolder(projectId);
      appState.setState('workingDirectory', projectId);
    }
    const session = appState.createSession('新对话', projectId);
    appState.setState('currentSession', session);
    eventBus.emit(Events.SESSION_CREATED);
  };

  const refreshDaemonSessionsForSidebar = async (projectHint?: string | null) => {
    const normalizedHint = projectHint ?? appState.getState().workingDirectory ?? '';
    if (normalizedHint && sessionRefreshProjectRef.current === normalizedHint && appState.getState().daemonBrowser.loadingSessions) {
      return;
    }
    sessionRefreshProjectRef.current = normalizedHint;
    try {
      await appState.refreshDaemonSessionsAfterAction();
    } catch (error) {
      showToast(errorMessage(error), 'error', 4500);
    } finally {
      if (sessionRefreshProjectRef.current === normalizedHint) {
        sessionRefreshProjectRef.current = '';
      }
    }
  };

  const handleOpenProjectInFileManager = async (folder: string) => {
    setProjectMenu(null);
    try {
      const openers = await tauriBridge.listHostOpeners();
      if (isBridgeDiagnostic(openers)) {
        showToast(openers.diagnostic.message, 'error', 4500);
        return;
      }
      const opener = openers.find(item => item.kind === 'file-manager' && item.available);
      if (!opener) {
        showToast('没有可用的文件管理器', 'error', 4500);
        return;
      }
      await tauriBridge.openHostTarget(opener.id, { type: 'path', path: folder });
    } catch (error) {
      showToast(errorMessage(error), 'error', 4500);
    }
  };

  const handleChangeProjectFolder = async (folder: string) => {
    setProjectMenu(null);
    try {
      const nextFolder = await tauriBridge.selectFolder();
      if (!nextFolder || nextFolder === folder) return;
      appState.replaceOpenedFolder(folder, nextFolder);
    } catch (error) {
      showToast(errorMessage(error), 'error', 4500);
    }
  };

  const handleRemoveProject = (folder: string) => {
    setProjectMenu(null);
    appState.removeOpenedFolder(folder);
  };

  const handleSwitchSession = async (sessionId: string) => {
    setSessionPendingAction(sessionId, 'open');
    try {
      await appState.switchSession(sessionId);
    } catch (error) {
      showToast(errorMessage(error), 'error', 4500);
    } finally {
      setSessionPendingAction(sessionId, null);
    }
  };

  const setSessionPendingAction = (sessionId: string, action: string | null) => {
    const next = { ...pendingSessionActionsRef.current };
    if (action) {
      next[sessionId] = action;
    } else {
      delete next[sessionId];
    }
    pendingSessionActionsRef.current = next;
    setPendingSessionActions(next);
  };

  const handleDeleteSession = async (sessionId: string) => {
    setContextMenu(null);
    await applyDaemonSessionAction(buildSessionAction(sessionId, 'delete'));
  };

  const handleRenameSession = (sessionId: string) => {
    const session = appState.getState().sessions.find(s => s.id === sessionId);
    if (session) {
      setRenamingSessionId(sessionId);
      setRenameValue(session.title);
    }
    setContextMenu(null);
  };

  const handleRenameSubmit = async () => {
    const sessionId = renamingSessionId;
    const title = renameValue.trim();
    if (sessionId && title) {
      await applyDaemonSessionAction(buildSessionAction(sessionId, 'rename', { title }));
    }
    setRenamingSessionId(null);
    setRenameValue('');
  };

  const handleRenameKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      void handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setRenamingSessionId(null);
      setRenameValue('');
    }
  };

  const handleSessionContextMenu = (e: MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setProjectMenu(null);
    setContextMenu({ sessionId, x: e.clientX, y: e.clientY });
  };

  const handleShowMoreMenu = (e: MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    // 再次点击同一按钮则关闭（toggle）；打开时关闭其它面板（单一展开）
    if (contextMenu && contextMenu.sessionId === sessionId) {
      setContextMenu(null);
      return;
    }
    setProjectMenu(null);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({
      sessionId,
      x: rect.right - 140,
      y: rect.bottom + 4
    });
  };

  const handleTogglePinSession = async (session: Session) => {
    const kind = sessionPinned(session) ? 'unpin' : 'pin';
    setContextMenu(null);
    await applyDaemonSessionAction(buildSessionAction(session.id, kind));
  };

  const handleToggleArchiveSession = async (session: Session) => {
    const kind = sessionArchived(session) ? 'unarchive' : 'archive';
    setContextMenu(null);
    await applyDaemonSessionAction(buildSessionAction(session.id, kind));
  };

  const applyDaemonSessionAction = async (action: WorkbenchSessionAction) => {
    if (pendingSessionActionsRef.current[action.sessionId]) return;
    setSessionPendingAction(action.sessionId, action.kind);
    try {
      const receipt = await tauriBridge.applySessionAction(action);
      if (isBridgeDiagnostic(receipt)) {
        showToast(receipt.diagnostic.message, 'error', 4500);
        return;
      }
      if (receipt.status !== 'committed') {
        showToast(receipt.errorMessage ?? `${receipt.kind} ${receipt.status}`, 'error', 4500);
        return;
      }
      await appState.refreshDaemonSessionsAfterAction(receipt.resultingSessionId ?? receipt.sessionId);
    } catch (error) {
      showToast(errorMessage(error), 'error', 4500);
    } finally {
      setSessionPendingAction(action.sessionId, null);
    }
  };

  // ---- Derived data ----

  const contextSession = contextMenu
    ? appState.getState().sessions.find(session => session.id === contextMenu.sessionId)
    : null;

  // 简化的单行会话行
  const renderSessionRow = (session: Session) => {
    const isActive = currentSession?.id === session.id;
    const isRenaming = renamingSessionId === session.id;
    const running = Boolean(session.activeRunId);

    return (
      <div
        key={session.id}
        class={`repl-sidebar-session-row ${isActive ? 'active' : ''}`}
        onClick={() => handleSwitchSession(session.id)}
        onContextMenu={(e: any) => handleSessionContextMenu(e, session.id)}
      >
        <div class="repl-sidebar-session-left">
          {running && <span class="repl-sidebar-session-running" title="运行中" />}
          {isRenaming ? (
            <input
              type="text"
              value={renameValue}
              onInput={(e: any) => setRenameValue(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={() => void handleRenameSubmit()}
              onClick={(e) => e.stopPropagation()}
              class="repl-sidebar-rename-input"
              autoFocus
            />
          ) : (
            <span class="repl-sidebar-session-title">{session.title}</span>
          )}
        </div>

        <div class="repl-sidebar-session-right">
          <span class="repl-sidebar-session-time">{formatTime(session.updatedAt)}</span>
          <button
            class="repl-sidebar-session-more"
            onClick={(e) => { e.stopPropagation(); handleShowMoreMenu(e, session.id); }}
            title="更多"
          >
            <IconMoreVertical />
          </button>
        </div>
      </div>
    );
  };

  return (
    <aside
      class="repl-sidebar-inner"
      role="navigation"
      aria-label="侧栏导航"
    >
      {/* === 功能入口区 === */}
      <div class="repl-sidebar-actions">
        <button class="repl-sidebar-action-btn" onClick={() => createSessionWithProject(null)}>
          <IconPlus />
          <span>新对话</span>
        </button>

        <div class="repl-sidebar-expand-wrap" ref={expandMenuRef}>
          <button
            class={`repl-sidebar-action-btn ${expandMenuOpen ? 'active' : ''}`}
            onClick={() => setExpandMenuOpen(!expandMenuOpen)}
          >
            <span class={`repl-sidebar-expand-chevron ${expandMenuOpen ? 'open' : ''}`}><IconChevronDown /></span>
            <span>拓展</span>
          </button>
          {expandMenuOpen && (
            <div class="repl-sidebar-expand-menu">
              <div class="repl-sidebar-expand-item" onClick={() => { setExpandMenuOpen(false); }}>
                <IconTerminal /><span>技能</span>
              </div>
              <div class="repl-sidebar-expand-item" onClick={() => { setExpandMenuOpen(false); }}>
                <IconExternalLink /><span>WebBridge</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* === 项目与会话列表 === */}
      <div class="repl-sidebar-scroll-area">
        {/* 项目行 */}
        {openedFolders.length > 0 && (
          <div class="repl-sidebar-project-bar">
            <span class="repl-sidebar-project-name">
              <IconFolder />
              {projectName(workingDirectory || openedFolders[0])}
            </span>
            <div class="repl-sidebar-project-actions">
              <button class="repl-sidebar-icon-btn" onClick={handleOpenFolder} title="打开文件夹">
                <IconFolderPlus />
              </button>
              <button class="repl-sidebar-icon-btn" onClick={() => setSearchOpen(!searchOpen)} title="筛选">
                <IconSearch />
              </button>
              <button class="repl-sidebar-icon-btn" onClick={(e) => { setProjectMenu({ folder: workingDirectory || openedFolders[0], x: e.clientX, y: e.clientY }); }} title="更多">
                <IconMoreVertical />
              </button>
            </div>
          </div>
        )}

        {/* 搜索框 */}
        {searchOpen && (
          <div class="repl-sidebar-search">
            <div class="repl-sidebar-search-input-wrap">
              <span class="repl-sidebar-search-icon"><IconSearch /></span>
              <input
                type="text"
                placeholder="搜索会话..."
                value={searchQuery}
                onInput={(e: any) => setSearchQuery(e.target.value)}
                class="repl-sidebar-search-input"
                autoFocus
              />
              {searchQuery && (
                <button class="repl-sidebar-icon-btn" onClick={() => setSearchQuery('')}><IconX /></button>
              )}
            </div>
          </div>
        )}

        {/* 会话列表（扁平，无时间分组） */}
        <div class="repl-sidebar-session-list">
          {(() => {
            const allSessions = appState.getState().sessions;
            const filteredSessions = searchQuery
              ? allSessions.filter(s => s.title.toLowerCase().includes(searchQuery.toLowerCase()))
              : allSessions;
            return (
              <>
                {filteredSessions.length === 0 && (
                  <div class="repl-sidebar-empty">
                    <div class="repl-sidebar-empty-text">{searchQuery ? '无匹配结果' : '暂无对话'}</div>
                    {!searchQuery && (
                      <button class="repl-sidebar-empty-btn" onClick={() => { appState.createSession(); eventBus.emit(Events.SESSION_CREATED); }}>
                        <IconPlus /> 新建对话
                      </button>
                    )}
                  </div>
                )}
                {filteredSessions.map(session => renderSessionRow(session))}
              </>
            );
          })()}
        </div>
      </div>

      {/* === 底部用户区 === */}
      <div class="repl-sidebar-bottom">
        <div class="repl-sidebar-profile-wrap">
          <div class="repl-sidebar-profile" onClick={() => setProfileMenuOpen(!profileMenuOpen)}>
            <div class="repl-sidebar-avatar"><IconUser /></div>
            <span class="repl-sidebar-username">用户</span>
            <span class={`repl-sidebar-profile-chevron ${profileMenuOpen ? 'open' : ''}`}>
              <IconChevronDown />
            </span>
          </div>
          {profileMenuOpen && (
            <div class="repl-sidebar-profile-menu">
              <div class="repl-sidebar-menu-item" onClick={() => { createSessionWithProject(null); setProfileMenuOpen(false); }}>
                <IconPlus /><span>新建对话</span>
              </div>
              <div class="repl-sidebar-menu-item" onClick={() => { handleOpenFolder(); setProfileMenuOpen(false); }}>
                <IconFolder /><span>打开文件夹</span>
              </div>
              <div class="repl-sidebar-menu-divider" />
              <div class="repl-sidebar-menu-item" onClick={() => { appState.openRightTab('settings'); setProfileMenuOpen(false); }}>
                <IconSettings /><span>设置</span>
              </div>
              <div class="repl-sidebar-menu-item" onClick={() => { handleThemeChange(theme === 'dark' ? 'light' : 'dark'); setProfileMenuOpen(false); }}>
                {theme === 'dark' ? <IconSun /> : <IconMoon />}
                <span>{theme === 'dark' ? '切换浅色' : '切换深色'}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ===== Project Context Menu ===== */}
      {projectMenu && (
        <ContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          onClose={() => setProjectMenu(null)}
          items={[
            { id: 'open-folder', label: '打开文件夹', icon: IconExternalLink, action: () => void handleOpenProjectInFileManager(projectMenu.folder) },
            { id: 'change-folder', label: '更换文件夹', icon: IconFolderOpen, action: () => void handleChangeProjectFolder(projectMenu.folder) },
            { id: 'remove', label: '移除项目', icon: IconTrash, danger: true, action: () => handleRemoveProject(projectMenu.folder) },
          ]}
        />
      )}

      {/* ===== Session Context Menu ===== */}
      {contextMenu && contextSession && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            { id: 'pin', label: sessionPinned(contextSession) ? '取消置顶' : '置顶', icon: IconPin, action: () => void handleTogglePinSession(contextSession) },
            { id: 'rename', label: '重命名', icon: IconEdit, action: () => handleRenameSession(contextMenu.sessionId) },
            { id: 'archive', label: sessionArchived(contextSession) ? '取消归档' : '归档', icon: IconArchive, action: () => void handleToggleArchiveSession(contextSession) },
            { id: 'split', label: '分屏打开', icon: IconExternalLink, action: () => { const s = appState.getState().sessions.find(x => x.id === contextMenu.sessionId); setContextMenu(null); appState.openSessionInSplit(contextMenu.sessionId, s?.title || '对话'); } },
            { id: 'delete', label: '删除', icon: IconTrash, danger: true, action: () => void handleDeleteSession(contextMenu.sessionId) },
            ...(pendingSessionActions[contextMenu.sessionId] ? [{ id: 'pending', label: '处理中...', disabled: true, action: () => {} }] as ContextMenuItem[] : []),
          ]}
        />
      )}
    </aside>
  );
}

function buildSessionAction(
  sessionId: string,
  kind: WorkbenchSessionActionKind,
  extra: Partial<WorkbenchSessionAction> = {}
): WorkbenchSessionAction {
  return {
    protocolVersion: WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION,
    actionId: `workbench-session-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    sessionId,
    requestedAt: new Date().toISOString(),
    requestedBy: 'workbench',
    idempotencyKey: `${sessionId}:${kind}:${Date.now()}`,
    ...extra,
  } as WorkbenchSessionAction;
}

function sessionPinned(session: Session): boolean {
  return session.daemonRecord?.metadata?.pinned === true;
}

function sessionArchived(session: Session): boolean {
  return session.daemonRecord?.status === 'archived' || session.daemonRecord?.metadata?.archived === true;
}

function projectName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() || folder;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
