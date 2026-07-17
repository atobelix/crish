/**
 * 工作台双行标签（功能实体，对照参考图）：
 * - 工作区行：文件夹式顶圆角 tab（项目 / 默认工作区）
 * - 会话行：Obsidian soft pill + 右侧轻动作区
 *
 * 与侧栏列表同步：点会话会挂标签；关标签不删会话。
 * inset 模式下两行都在内容卡顶，app-header 只放壳层控件。
 */
import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Lucide from 'lucide-react';
import {
  GENERAL_FOLDER,
  canonicalSessionFolder,
  getActiveProjectId,
  listProjects,
  openProject,
  setNoProject,
  type ProjectEntry,
} from '../api/projectStore';
import {
  activeWorkspaceTabId,
  buildSessionTabsForWorkspace,
  buildWorkspaceTabs,
  closeSessionTab,
  currentWorkspaceFolderKey,
  getOpenSessionTabIds,
  openSessionTab,
  pruneOpenSessionTabs,
  sessionBelongsToWorkspace,
  type WorkspaceTab,
} from '../api/workspaceChromeTabs';
import { EMPTY_SESSION_TITLE, sessionListDisplayTitle } from '../api/sessionTitle';
import { createSession, focusOrOpenPanel, setActiveSessionId } from '../api/storeAccess';
import { useLayoutStore } from '../store/layoutStore';
import { isChatColumn } from '../store/layoutHelpers';
import { selectActiveSessionId, useSessionField } from '../store/sessionStore';
import { emitUiEvent } from '../api/uiEvents';
import { IconSidebarRight } from './SidebarToggleIcons';

type Props = {
  onAddProject?: () => void;
  /** 顶栏（项目行）右侧：运行态 — 不在会话行 */
  onOpenRuntime?: () => void;
  /** 顶栏（项目行）右侧：更多/帮助 — 不在会话行 */
  onOpenHelp?: () => void;
  /** 工作区行右侧：窗口控件（inset 无独立顶栏时） */
  onWinMinimize?: () => void;
  onWinMaximize?: () => void;
  onWinClose?: () => void;
  /** 只渲染工作区行 / 只渲染会话行 / 两行都渲染 */
  variant?: 'workspace' | 'sessions' | 'both';
  className?: string;
};

function useWorkspaceChromeState(onAddProject?: () => void) {
  const sessions = useLayoutStore((s) => s.sessions);
  const activeSessionId = useSessionField(selectActiveSessionId);
  const [projectTick, setProjectTick] = useState(0);
  const [tabsTick, setTabsTick] = useState(0);

  useEffect(() => {
    const onProj = () => setProjectTick((n) => n + 1);
    window.addEventListener('crish-project-changed', onProj);
    return () => window.removeEventListener('crish-project-changed', onProj);
  }, []);

  // 活动会话 → 确保标签存在（不重排；点选不会把 tab 挪到队首）
  useEffect(() => {
    if (!activeSessionId) return;
    const sess = sessions.find((s) => s.id === activeSessionId);
    if (!sess || sess.isArchived) return;
    const folder = canonicalSessionFolder(sess.folder);
    const before = getOpenSessionTabIds(folder);
    const after = openSessionTab(folder, activeSessionId);
    // 仅在真正新增标签时刷新，避免无意义重渲
    if (before.length !== after.length || !before.includes(activeSessionId)) {
      setTabsTick((n) => n + 1);
    }
  }, [activeSessionId, sessions]);

  const projects: ProjectEntry[] = useMemo(() => {
    void projectTick;
    return listProjects();
  }, [projectTick]);

  const workspaceTabs = useMemo(() => buildWorkspaceTabs(projects), [projects]);

  const activeWsId = useMemo(() => {
    void projectTick;
    return activeWorkspaceTabId(getActiveProjectId());
  }, [projectTick]);

  const folderKey = useMemo(() => {
    void projectTick;
    return currentWorkspaceFolderKey(getActiveProjectId());
  }, [projectTick]);

  const knownMap = useMemo(() => {
    const m = new Map<
      string,
      { title?: string; folder?: string; isPinned?: boolean }
    >();
    for (const s of sessions) {
      if (s.isArchived) continue;
      m.set(s.id, {
        title: sessionListDisplayTitle(s) || s.title || EMPTY_SESSION_TITLE,
        folder: s.folder || GENERAL_FOLDER,
        isPinned: Boolean(s.isPinned),
      });
    }
    return m;
  }, [sessions]);

  /** 当前工作区下的会话（用于空标签时播种） */
  const sessionsInWorkspace = useMemo(() => {
    return sessions
      .filter(
        (s) =>
          !s.isArchived &&
          sessionBelongsToWorkspace(s.folder, folderKey),
      )
      .sort((a, b) => {
        // 置顶优先，再按时间戳（timestamp 可能是 ISO 字符串）
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        const ta = Date.parse(String(a.timestamp || '')) || 0;
        const tb = Date.parse(String(b.timestamp || '')) || 0;
        return tb - ta;
      });
  }, [folderKey, sessions]);

  const sessionTabs = useMemo(() => {
    void tabsTick;
    const existing = new Set(sessions.map((s) => s.id));
    let openIds = pruneOpenSessionTabs(folderKey, existing);
    // 空标签：用本工作区最近会话播种（最多 6 个），避免「只有壳没有 tab」
    if (openIds.length === 0 && sessionsInWorkspace.length > 0) {
      for (const s of sessionsInWorkspace.slice(0, 6)) {
        openSessionTab(folderKey, s.id);
      }
      openIds = getOpenSessionTabIds(folderKey);
    }
    return buildSessionTabsForWorkspace(folderKey, openIds, knownMap);
  }, [folderKey, knownMap, sessions, sessionsInWorkspace, tabsTick]);

  const selectWorkspace = useCallback((tab: WorkspaceTab) => {
    if (tab.kind === 'general') setNoProject();
    else openProject(tab.id);

    const key = tab.id;
    const existing = useLayoutStore.getState().sessions.filter((s) => !s.isArchived);
    let ids = getOpenSessionTabIds(key).filter((id) =>
      existing.some((s) => s.id === id),
    );
    if (ids.length === 0) {
      const inFolder = existing
        .filter((s) => sessionBelongsToWorkspace(s.folder, key))
        .sort((a, b) => {
          const ta = Date.parse(String(a.timestamp || '')) || 0;
          const tb = Date.parse(String(b.timestamp || '')) || 0;
          return tb - ta;
        });
      // 播种时按时间新→旧追加，末尾为最近
      for (const s of [...inFolder.slice(0, 6)].reverse()) {
        openSessionTab(key, s.id);
      }
      ids = getOpenSessionTabIds(key);
      if (ids.length === 0 && inFolder[0]) {
        openSessionTab(key, inFolder[0].id);
        ids = [inFolder[0].id];
      }
    }
    // 不因顺序激活「最旧」；优先保留当前会话（若在本区），否则取末尾（最近打开）
    const cur = useLayoutStore.getState().activeSessionId;
    const pick =
      (cur && ids.includes(cur) ? cur : null) ||
      ids[ids.length - 1] ||
      null;
    if (pick) setActiveSessionId(pick);
    setProjectTick((n) => n + 1);
    setTabsTick((n) => n + 1);
  }, []);

  const selectSession = useCallback(
    (sessionId: string) => {
      // 只激活；openSessionTab 若已存在不改顺序，避免「点谁谁跳到最前」
      setActiveSessionId(sessionId);
      openSessionTab(folderKey, sessionId);
      setTabsTick((n) => n + 1);
    },
    [folderKey],
  );

  const onCloseSession = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const { nextActiveId } = closeSessionTab(
        folderKey,
        sessionId,
        activeSessionId,
      );
      if (nextActiveId) setActiveSessionId(nextActiveId);
      setTabsTick((n) => n + 1);
    },
    [activeSessionId, folderKey],
  );

  const onNewSession = useCallback(() => {
    const folder = getActiveProjectId() || GENERAL_FOLDER;
    const id = createSession({
      title: EMPTY_SESSION_TITLE,
      folder,
      activate: true,
    });
    if (id) {
      openSessionTab(folder, id);
      setTabsTick((n) => n + 1);
    }
  }, []);

  const onAdd = useCallback(() => {
    if (onAddProject) onAddProject();
    else emitUiEvent('pick-workspace');
  }, [onAddProject]);

  return {
    workspaceTabs,
    activeWsId,
    sessionTabs,
    activeSessionId,
    selectWorkspace,
    selectSession,
    onCloseSession,
    onNewSession,
    onAdd,
  };
}

/** 加号展开菜单：点击外关闭 */
function useChromeAddMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return { open, setOpen, wrapRef, menuId };
}

/** 仅工作区行（项目 tab + 运行/帮助 + 可选窗控） */
export const WorkspaceStrip: React.FC<Props> = ({
  onAddProject,
  className,
  onOpenRuntime,
  onOpenHelp,
  onWinMinimize,
  onWinMaximize,
  onWinClose,
}) => {
  const s = useWorkspaceChromeState(onAddProject);
  const showTrail = Boolean(
    onOpenRuntime || onOpenHelp || onWinMinimize || onWinMaximize || onWinClose,
  );
  const add = useChromeAddMenu();

  return (
    <div
      className={`ws-chrome-row ws-chrome-row--workspace ${className || ''}`}
      role="tablist"
      aria-label="工作区"
      data-tauri-drag-region
    >
      <div className="ws-chrome-scroll" data-tauri-drag-region="false">
        {s.workspaceTabs.map((tab) => {
          const active = tab.id === s.activeWsId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`ws-chrome-tab ${active ? 'is-active' : ''}`}
              title={tab.path || tab.label}
              onClick={() => s.selectWorkspace(tab)}
            >
              {tab.kind === 'project' ? (
                <Lucide.Folder size={13} strokeWidth={1.75} aria-hidden />
              ) : (
                <Lucide.MessagesSquare size={13} strokeWidth={1.75} aria-hidden />
              )}
              <span className="ws-chrome-tab-label">{tab.label}</span>
            </button>
          );
        })}
        <div className="ws-chrome-add-wrap" ref={add.wrapRef}>
          <button
            type="button"
            className="ws-chrome-tab ws-chrome-tab--add"
            title="添加"
            aria-label="添加工作区"
            aria-haspopup="menu"
            aria-expanded={add.open}
            aria-controls={add.menuId}
            onClick={() => add.setOpen((v) => !v)}
          >
            <Lucide.Plus size={14} strokeWidth={2} aria-hidden />
          </button>
          {add.open ? (
            <div
              id={add.menuId}
              className="ws-chrome-add-menu"
              role="menu"
              aria-label="添加工作区"
            >
              <button
                type="button"
                role="menuitem"
                className="ws-chrome-add-item"
                onClick={() => {
                  add.setOpen(false);
                  s.onAdd();
                }}
              >
                <Lucide.FolderPlus size={16} strokeWidth={1.75} aria-hidden />
                <span className="ws-chrome-add-item-text">
                  <span>添加本地项目</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="ws-chrome-add-item"
                onClick={() => {
                  add.setOpen(false);
                  s.selectWorkspace({
                    kind: 'general',
                    id: GENERAL_FOLDER,
                    label: GENERAL_FOLDER,
                  });
                }}
              >
                <Lucide.MessagesSquare size={16} strokeWidth={1.75} aria-hidden />
                <span className="ws-chrome-add-item-text">
                  <span>切换到「对话」</span>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {showTrail ? (
        <div
          className="ws-chrome-trail ws-chrome-trail--win"
          role="toolbar"
          aria-label="顶栏操作"
          data-tauri-drag-region="false"
        >
          {onOpenRuntime ? (
            <button
              type="button"
              className="ws-chrome-trail-btn no-drag"
              title="运行状态"
              aria-label="运行状态"
              onClick={onOpenRuntime}
            >
              <Lucide.Activity size={15} strokeWidth={1.75} aria-hidden />
            </button>
          ) : null}
          {onOpenHelp ? (
            <button
              type="button"
              className="ws-chrome-trail-btn no-drag"
              title="快捷键与帮助"
              aria-label="快捷键与帮助"
              onClick={onOpenHelp}
            >
              <Lucide.MoreHorizontal size={15} strokeWidth={1.75} aria-hidden />
            </button>
          ) : null}
          {onWinMinimize ? (
            <button
              type="button"
              className="ws-chrome-trail-btn no-drag"
              title="最小化"
              aria-label="最小化窗口"
              onClick={onWinMinimize}
            >
              <Lucide.Minus size={14} strokeWidth={1.75} aria-hidden />
            </button>
          ) : null}
          {onWinMaximize ? (
            <button
              type="button"
              className="ws-chrome-trail-btn no-drag"
              title="最大化"
              aria-label="最大化或还原窗口"
              onClick={onWinMaximize}
            >
              <Lucide.Square size={12} strokeWidth={1.75} aria-hidden />
            </button>
          ) : null}
          {onWinClose ? (
            <button
              type="button"
              className="ws-chrome-trail-btn ws-chrome-trail-btn--close no-drag"
              title="关闭"
              aria-label="关闭窗口"
              onClick={onWinClose}
            >
              <Lucide.X size={14} strokeWidth={1.75} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/** 仅会话行（聊天列顶；右侧工具标签由工具列 card-header 同排承担） */
export const SessionStrip: React.FC<Props> = ({ className }) => {
  const s = useWorkspaceChromeState();
  const add = useChromeAddMenu();
  const activeWs = useLayoutStore((st) => {
    const i = st.activeWorkspaceIndex;
    return st.workspaces[i] || st.workspaces[0] || null;
  });
  /** 右侧工具列已收起/不存在时，会话行补上打开总览按钮 */
  const hasRightToolPanel = useMemo(() => {
    if (!activeWs) return false;
    return activeWs.columns.some(
      (col) =>
        !isChatColumn(col) &&
        col.groups.some((g) => g.cards.some((c) => c.id && c.id !== 'chat')),
    );
  }, [activeWs]);

  const openRightPanel = useCallback(() => {
    const wsId = activeWs?.id;
    if (!wsId) return;
    focusOrOpenPanel(wsId, 'overview');
  }, [activeWs?.id]);

  return (
    <div
      className={`ws-chrome-row ws-chrome-row--sessions ${className || ''}`}
      role="tablist"
      aria-label="会话"
    >
      <div className="ws-chrome-scroll">
        {s.sessionTabs.map((tab) => {
          const active = tab.sessionId === s.activeSessionId;
          return (
            <div
              key={tab.sessionId}
              className={`ws-chrome-tab ws-chrome-tab--session ${active ? 'is-active' : ''}${tab.pinned ? ' is-pinned' : ''}`}
              role="tab"
              aria-selected={active}
            >
              <button
                type="button"
                className="ws-chrome-tab-main"
                title={tab.title}
                onClick={() => s.selectSession(tab.sessionId)}
              >
                {tab.pinned ? (
                  <Lucide.Pin size={12} strokeWidth={2} aria-hidden className="ws-chrome-pin" />
                ) : null}
                <span className="ws-chrome-tab-label">{tab.title}</span>
              </button>
              <button
                type="button"
                className="ws-chrome-tab-close"
                title="关闭标签"
                aria-label={`关闭会话标签 ${tab.title}`}
                onClick={(e) => s.onCloseSession(tab.sessionId, e)}
              >
                <Lucide.X size={12} strokeWidth={2} aria-hidden />
              </button>
            </div>
          );
        })}
        <div className="ws-chrome-add-wrap" ref={add.wrapRef}>
          <button
            type="button"
            className="ws-chrome-tab ws-chrome-tab--add"
            title="新建"
            aria-label="新建对话"
            aria-haspopup="menu"
            aria-expanded={add.open}
            aria-controls={add.menuId}
            onClick={() => add.setOpen((v) => !v)}
          >
            <Lucide.Plus size={15} strokeWidth={2} aria-hidden />
          </button>
          {add.open ? (
            <div
              id={add.menuId}
              className="ws-chrome-add-menu"
              role="menu"
              aria-label="新建对话"
            >
              <button
                type="button"
                role="menuitem"
                className="ws-chrome-add-item"
                onClick={() => {
                  add.setOpen(false);
                  s.onNewSession();
                }}
              >
                <Lucide.MessageSquarePlus size={16} strokeWidth={1.75} aria-hidden />
                <span className="ws-chrome-add-item-text">
                  <span>新建对话</span>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {!hasRightToolPanel ? (
        <div className="ws-chrome-trail" role="toolbar" aria-label="打开右侧面板">
          <button
            type="button"
            className="ws-chrome-trail-btn"
            title="打开总览侧栏"
            aria-label="打开总览侧栏"
            onClick={openRightPanel}
          >
            <IconSidebarRight size={15} aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
};

/** 两行一体：inset 内容卡顶（工作区 folder + 会话 pill） */
export const WorkspaceChromeBars: React.FC<Props> = (props) => {
  if (props.variant === 'workspace') return <WorkspaceStrip {...props} />;
  if (props.variant === 'sessions') return <SessionStrip {...props} />;
  return (
    <div className={`ws-chrome ${props.className || ''}`} role="navigation" aria-label="工作台标签">
      <WorkspaceStrip {...props} />
      <SessionStrip {...props} />
    </div>
  );
};
