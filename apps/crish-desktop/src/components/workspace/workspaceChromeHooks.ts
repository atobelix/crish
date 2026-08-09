import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  GENERAL_FOLDER,
  canonicalSessionFolder,
  getActiveProjectId,
  listProjects,
  openProject,
  setNoProject,
  type ProjectEntry,
} from '../../api/projectStore';
import {
  activeWorkspaceTabId,
  buildWorkspaceTabs,
  closeSessionTab,
  currentWorkspaceFolderKey,
  syncOpenTabsToLegacy,
  type SessionTab,
  type WorkspaceTab,
} from '../../api/workspaceChromeTabs';
import {
  EMPTY_SESSION_TITLE,
  sessionListDisplayTitle,
} from '../../api/sessionTitle';
import {
  focusOrOpenPanel,
  setActiveSessionId,
} from '../../api/storeAccess';
import { useLayoutStore } from '../../api/store-access/componentAccess';
import {
  isChatColumn,
} from '../../api/store-access/componentAccess';
import {
  getSessionById,
  selectActiveSessionId,
  useSessionField,
} from '../../api/store-access/componentAccess';
import {
  PENDING_DRAFT_SESSION_ID,
  isPendingDraft,
} from '../../api/store-access/componentAccess';
import { emitUiEvent } from '../../api/uiEvents';
import {
  useLayoutTreeStore,
  collectLeaves,
  isChatDomain,
} from '../../api/store-access/componentAccess';
import { focusOrOpenTreePanel } from '../../api/store-access/componentAccess';
import { isTreeWorkspaceFast } from '../../createSsrGlobals';
import {
  selectActiveTabSessionId,
  useWorkspaceShellStore,
} from '../../api/store-access/componentAccess';
import { getCompositionRoot } from '../../app/compositionRoot';

export type WorkspaceChromeProps = {
  onAddProject?: () => void;
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

export function useWorkspaceChromeState(onAddProject?: () => void) {
  const sessions = useLayoutStore((s) => s.sessions);
  const globalActiveSessionId = useSessionField(selectActiveSessionId);
  /** Shell TabSurface 一级状态：顶栏唯一真相源 */
  const shellOpenTabs = useWorkspaceShellStore((s) => s.openTabs);
  const shellActiveSessionId = useWorkspaceShellStore(selectActiveTabSessionId);
  const [projectTick, setProjectTick] = useState(0);

  useEffect(() => {
    const onProj = () => setProjectTick((n) => n + 1);
    window.addEventListener('crish-project-changed', onProj);
    // 兼容旧刷新事件（拖拽等仍会派发）；shell store 订阅本身已驱动顶栏
    const onTabsRefresh = () => setProjectTick((n) => n + 1);
    window.addEventListener('crish-tabs-refresh', onTabsRefresh);
    return () => {
      window.removeEventListener('crish-project-changed', onProj);
      window.removeEventListener('crish-tabs-refresh', onTabsRefresh);
    };
  }, []);

  // 活动会话 → best-effort 同步 legacy open-tabs map（UI 只读 shell，不反向强制 mint）
  useEffect(() => {
    if (!globalActiveSessionId || isPendingDraft(globalActiveSessionId)) return;
    const sess = getSessionById(globalActiveSessionId);
    if (!sess || sess.isArchived) return;
    const folder = canonicalSessionFolder(sess.folder);
    // D10：legacy map 同步统一入口（双写路径保留，登记待清理）
    syncOpenTabsToLegacy(folder, globalActiveSessionId);
  }, [globalActiveSessionId]);

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

  /** 顶栏会话标签：只读 shell.openTabs（当前工作区） */
  const sessionTabs: SessionTab[] = useMemo(() => {
    const wsKey = canonicalSessionFolder(folderKey);
    return shellOpenTabs
      .filter((t) => canonicalSessionFolder(t.workspaceKey) === wsKey)
      .map((t) => {
        if (isPendingDraft(t.sessionId)) {
          return {
            sessionId: t.sessionId || PENDING_DRAFT_SESSION_ID,
            title: (t.title || '').trim() || '新对话',
          };
        }
        const known = knownMap.get(t.sessionId);
        const title =
          (t.title || '').trim() ||
          known?.title ||
          EMPTY_SESSION_TITLE ||
          '未命名会话';
        return {
          sessionId: t.sessionId,
          title,
          pinned: Boolean(known?.isPinned),
        };
      });
  }, [folderKey, knownMap, shellOpenTabs]);

  /** 顶栏高亮：优先 shell 活动 tab，回落全局 activeSessionId */
  const activeSessionId =
    shellActiveSessionId ?? globalActiveSessionId ?? null;

  const selectWorkspace = useCallback((tab: WorkspaceTab) => {
    if (tab.kind === 'general') setNoProject();
    else openProject(tab.id);

    const key = canonicalSessionFolder(tab.id);
    const shell = getCompositionRoot().shell.getState();
    const inWs = shell.openTabs.filter(
      (t) => canonicalSessionFolder(t.workspaceKey) === key
    );

    if (inWs.length > 0) {
      // 优先保留当前活动 tab（若已在本区），否则取本区第一个
      const activeInWs = inWs.find((t) => t.tabId === shell.activeTabId);
      const pick = activeInWs || inWs[0]!;
      shell.activateTab(pick.tabId);
      // best-effort legacy map（D10：syncOpenTabsToLegacy 统一入口）
      if (!isPendingDraft(pick.sessionId)) {
        syncOpenTabsToLegacy(key, pick.sessionId);
      }
    } else {
      // 本区无 shell 标签：追加/聚焦草稿，不清空其它工作区已打开的 tab
      shell.openNewDraftTab(key);
    }

    setProjectTick((n) => n + 1);
  }, []);

  const selectSession = useCallback(
    (sessionId: string) => {
      const shell = getCompositionRoot().shell.getState();
      // 重复点击当前激活标签：不刷新、不重绑
      const existing = shell.openTabs.find((t) => t.sessionId === sessionId);
      if (existing && shell.activeTabId === existing.tabId) return;

      const sess = isPendingDraft(sessionId)
        ? null
        : getSessionById(sessionId);
      shell.openOrFocusSession(sessionId, {
        title: sess?.title,
        workspaceKey: folderKey,
      });
      if (!isPendingDraft(sessionId)) {
        // D10：legacy map 同步统一入口（双写路径保留，登记待清理）
        syncOpenTabsToLegacy(folderKey, sessionId);
      }
    },
    [folderKey]
  );

  const onCloseSession = useCallback(
    (sessionId: string, e: React.SyntheticEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Shell redesign：关标签 = 关 TabSurface（含 dock 态 + adapter 归一）
      const shell = getCompositionRoot().shell.getState();
      if (shell.openTabs.some((t) => t.sessionId === sessionId)) {
        shell.closeTabBySessionId(sessionId, folderKey);
      } else {
        // fallback：仅 legacy map
        const { nextActiveId } = closeSessionTab(
          folderKey,
          sessionId,
          activeSessionId
        );
        if (nextActiveId) {
          setActiveSessionId(nextActiveId);
        } else if (activeSessionId === sessionId) {
          const activeSess =
            activeSessionId && !isPendingDraft(activeSessionId)
              ? getSessionById(activeSessionId)
              : null;
          const folder =
            activeSess?.folder || getActiveProjectId() || GENERAL_FOLDER;
          // 不 wipe 其它顶栏 tab：仅补/聚焦草稿（closeTab 路径已保证末 tab 留 draft）
          getCompositionRoot().shell.openNewDraftTab(folder);
        }
      }
    },
    [activeSessionId, folderKey]
  );

  const onNewSession = useCallback(() => {
    const activeSess =
      activeSessionId && !isPendingDraft(activeSessionId)
        ? getSessionById(activeSessionId)
        : null;
    const folder = activeSess?.folder || getActiveProjectId() || GENERAL_FOLDER;
    getCompositionRoot().shell.openNewDraftTab(folder);
  }, [activeSessionId]);

  const onAdd = useCallback(() => {
    if (onAddProject) onAddProject();
    else emitUiEvent('pick-workspace');
  }, [onAddProject]);

  return {
    workspaceTabs,
    activeWsId,
    folderKey,
    sessionTabs,
    activeSessionId,
    selectWorkspace,
    selectSession,
    onCloseSession,
    onNewSession,
    onAdd,
  };
}

export function useRightSidebarState() {
  // 二叉树工作区：直接用 layoutTreeStore 的折叠状态
  const toolColumnCollapsed = useLayoutTreeStore((s) => s.toolColumnCollapsed);
  const toggleToolColumnCollapsed = useLayoutTreeStore(
    (s) => s.toggleToolColumnCollapsed
  );

  const activeWs = useLayoutStore((st) => {
    const i = st.activeWorkspaceIndex;
    return st.workspaces[i] || st.workspaces[0] || null;
  });

  const isRightSidebarCollapsed = useMemo(() => {
    if (isTreeWorkspaceFast()) return toolColumnCollapsed;
    if (!activeWs) return true;
    const toolCol = activeWs.columns.find((c) => !isChatColumn(c));
    if (!toolCol) return true;
    return toolCol.widthRatio < 0.08;
  }, [toolColumnCollapsed, activeWs]);

  const toggleRightSidebar = useCallback(() => {
    if (isTreeWorkspaceFast()) {
      // 展开且当前无功能区 leaf 时，自动打开 overview，避免展开后右侧空无一物
      if (toolColumnCollapsed) {
        const hasToolLeaf = collectLeaves(
          getCompositionRoot().tree.getState().tree.root
        ).some((l) => !isChatDomain(l.panelId));
        if (!hasToolLeaf) {
          focusOrOpenTreePanel('overview');
        }
      }
      toggleToolColumnCollapsed();
      return;
    }
    if (!activeWs) return;
    const wsId = activeWs.id;
    const toolCol = activeWs.columns.find((c) => !isChatColumn(c));
    const isCollapsed = !toolCol || toolCol.widthRatio < 0.08;

    if (isCollapsed) {
      const activeCardId = toolCol?.groups[0]?.activeCardId || 'overview';
      focusOrOpenPanel(wsId, activeCardId);
    } else {
      // T-E 步骤 4（C4）：raw setState 直写 workspaces → collapseToolColumnPreserve action
      useLayoutStore.getState().collapseToolColumnPreserve(wsId);
    }
  }, [activeWs, toggleToolColumnCollapsed, toolColumnCollapsed]);

  return { isRightSidebarCollapsed, toggleRightSidebar };
}

/** 加号展开菜单：点击外关闭 */
export function useChromeAddMenu() {
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
