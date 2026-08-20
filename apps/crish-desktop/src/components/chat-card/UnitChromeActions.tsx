import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ChatHeaderMore } from './ChatHeaderMore';
import { SessionInlineRename } from './SessionInlineRename';
import { SubagentHeaderPanel } from './SubagentHeaderPanel';
import { IconButton, Tooltip } from '../ui';
import {
  resolveUnitChromeLabel,
  resolveUnitChromeToolTip,
  UNIT_CHROME_TOOL_TIP_SIDE,
} from './unitChromeLabel';
import {
  IconSidebarLeft,
  IconSidebarRight,
} from '../sidebar/SidebarToggleIcons';
import { UNIT_TOOL_PANELS } from './unitChromeTools';
import { viewRegistry } from '../../services/view-registry';
import {
  applyDockToTree,
  collapseActiveTabRightDock,
  listProjects,
  openToolInSession,
  pinSession,
  projectFolderLabel,
  selectActiveSessionId,
  unpinSession,
  useLayoutTreeStore,
  useSessionField,
  useWorkspaceShellStore,
  GENERAL_FOLDER,
  clearSessionMessages,
  exportSessionToMarkdown,
  getCompositionRoot,
  tryDownloadSessionMarkdown,
  renameSession,
  enterDraftMode,
} from '../../store/storeAccess';
import { toast } from '../../services/toast';
import { sessionListDisplayTitle } from '../../api/sessionTitle';
import styles from './UnitChromeActions.module.css';

const SHARE_FLASH_MS = 2000;
const EMPTY_SESSION_TITLE = '新会话';

function isPendingDraft(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('__pending_draft__');
}

export interface UnitChromeActionsProps {
  activeSessionId?: string | null;
  className?: string;
  leading?: React.ReactNode;
  onClearHistory?: () => void;
  onExportMarkdown?: () => void;
}

export const UnitChromeActions: React.FC<UnitChromeActionsProps> = React.memo(
  ({
    activeSessionId,
    className,
    leading,
    onClearHistory,
    onExportMarkdown,
  }) => {
    const sid = (activeSessionId || '').trim();
    const isDraft = !sid || isPendingDraft(sid);
    const realSession = !isDraft;

    const folder = useSessionField((s) => {
      if (!sid) return undefined;
      return s.sessionsById[sid]?.folder;
    });

    const isPinned = useSessionField((s) => {
      if (!sid) return false;
      return Boolean(s.sessionsById[sid]?.isPinned);
    });

    const messageCount = useSessionField((s) => {
      if (!sid) return 0;
      return s.sessionsById[sid]?.messages?.length ?? 0;
    });

    const displayTitle = useSessionField((s) => {
      if (!sid || isPendingDraft(sid)) return EMPTY_SESSION_TITLE;
      const sess = s.sessionsById[sid];
      if (!sess) return EMPTY_SESSION_TITLE;
      return sessionListDisplayTitle(sess);
    });

    const sessionAgents = useSessionField((s) => {
      if (!sid) return undefined;
      return s.sessionsById[sid]?.agents;
    });

    const canExport = messageCount > 0;
    const projectLabel = resolveUnitChromeLabel(
      sid ? { folder } : null,
      listProjects()
    );

    const dockSnapshot = useWorkspaceShellStore((s) => {
      const id = (activeSessionId || '').trim();
      const tab = id
        ? s.openTabs.find((t) => t.sessionId === id)
        : s.openTabs.find((t) => t.tabId === s.activeTabId);
      return tab?.rightDock ?? null;
    });
    const globalTreeCollapsed = useLayoutTreeStore(
      (s) => s.toolColumnCollapsed
    );
    const rightDockCollapsed = dockSnapshot
      ? dockSnapshot.collapsed
      : globalTreeCollapsed;
    const openPanelIds = dockSnapshot?.openPanelIds;
    const activePanelId = dockSnapshot?.activePanelId;
    const openPanelSet = useMemo(
      () => new Set(openPanelIds ?? []),
      [openPanelIds]
    );

    const registryVersion = useSyncExternalStore(
      (cb) => viewRegistry.subscribe(cb),
      () => viewRegistry.getVersion()
    );
    void registryVersion;

    const [shareFlash, setShareFlash] = useState(false);
    const flashTimerRef = useRef<number | null>(null);
    useEffect(
      () => () => {
        if (flashTimerRef.current != null) {
          window.clearTimeout(flashTimerRef.current);
        }
      },
      []
    );

    const folderOptions = useMemo(() => {
      const opts = [{ id: GENERAL_FOLDER, label: GENERAL_FOLDER }];
      for (const p of listProjects()) {
        const label = (p.name || projectFolderLabel(p.path) || p.id).trim();
        opts.push({ id: p.id, label: label || p.id });
      }
      return opts;
    }, []);

    const handleTogglePin = useCallback(() => {
      const id = (activeSessionId || '').trim();
      if (!id || id.startsWith('__pending')) return;
      if (isPinned) unpinSession(id);
      else pinSession(id);
    }, [activeSessionId, isPinned]);

    const handleExport = useCallback(() => {
      if (onExportMarkdown) {
        onExportMarkdown();
        return;
      }
      const byId = getCompositionRoot().session.getState().sessionsById;
      const session = byId[sid];
      if (!session) return;
      const result = tryDownloadSessionMarkdown(session, new Date(), {
        sessionsById: byId,
      });
      if (result.ok === false) {
        toast.show(result.error || '导出失败');
      }
    }, [onExportMarkdown, sid]);

    const handleClear = useCallback(() => {
      if (onClearHistory) {
        onClearHistory();
        return;
      }
      if (!realSession) return;
      clearSessionMessages(sid);
    }, [onClearHistory, realSession, sid]);

    const handleMoveToFolder = useCallback(
      (folderId: string) => {
        if (!realSession) return;
        getCompositionRoot()
          .session.getState()
          .moveSessionRealtime(sid, null, folderId, isPinned);
      },
      [realSession, sid, isPinned]
    );

    const handleShare = useCallback(() => {
      const byId = getCompositionRoot().session.getState().sessionsById;
      const session = sid ? byId[sid] : undefined;
      if (!session) {
        toast.show('没有可分享的会话');
        return;
      }
      void (async () => {
        try {
          const md = exportSessionToMarkdown(session, { sessionsById: byId });
          const clip = navigator.clipboard?.writeText;
          if (typeof clip === 'function') {
            await clip.call(navigator.clipboard, md);
            toast.show('已复制 Markdown');
          } else {
            const result = tryDownloadSessionMarkdown(session, new Date(), {
              sessionsById: byId,
            });
            if (result.ok === false) {
              toast.show(result.error || '分享失败');
              return;
            }
          }
          setShareFlash(true);
          if (flashTimerRef.current != null) {
            window.clearTimeout(flashTimerRef.current);
          }
          flashTimerRef.current = window.setTimeout(() => {
            setShareFlash(false);
            flashTimerRef.current = null;
          }, SHARE_FLASH_MS);
        } catch {
          toast.show('分享失败');
        }
      })();
    }, [sid]);

    const handleOpenTool = useCallback(
      (panelId: string) => {
        openToolInSession((activeSessionId || '').trim(), panelId);
      },
      [activeSessionId]
    );

    const handleToggleRightDock = useCallback(() => {
      const shell = getCompositionRoot().shell.getState();
      const id = (activeSessionId || '').trim();
      const tab = id
        ? (shell.openTabs.find((t) => t.sessionId === id) ??
          shell.getActiveTab())
        : shell.getActiveTab();
      if (!tab) return;

      const collapsed = !tab.rightDock.collapsed;
      const dock = {
        ...tab.rightDock,
        collapsed,
        activePanelId:
          !collapsed && !tab.rightDock.activePanelId
            ? 'overview'
            : tab.rightDock.activePanelId,
        openPanelIds:
          !collapsed && !tab.rightDock.openPanelIds.length
            ? ['overview']
            : tab.rightDock.openPanelIds,
      };
      shell.updateRightDock(tab.tabId, dock);
      applyDockToTree(dock, tab.sessionId);
    }, [activeSessionId]);

    const handleToggleLeftSidebar = useCallback(() => {
      getCompositionRoot().shell.toggleSidebar?.();
    }, []);

    const handleJumpToNewDraft = useCallback(() => {
      enterDraftMode(folder);
    }, [folder]);

    const handleRename = useCallback(
      (newTitle: string) => {
        if (!realSession) return;
        renameSession(sid, newTitle);
      },
      [realSession, sid]
    );

    const dockLabel = rightDockCollapsed
      ? '展开右侧工具栏'
      : '收起右侧工具栏';

    return (
      <header
        className={`${styles.chatTopHeader}${className ? ` ${className}` : ''}`}
        data-unit-chrome-actions="true"
        data-chat-top-header="true"
        aria-label="对话快捷操作"
      >
        {/* ── 左侧：项目 / 标题 / 子代理 / 更多操作 ── */}
        <div className={styles.topLeft}>
          {leading}
          <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
            <Tooltip content="点击新建此项目对话" side={UNIT_CHROME_TOOL_TIP_SIDE}>
              <button
                type="button"
                className={`${styles.bcItem} ${styles.bcProjectBtn}`}
                onClick={handleJumpToNewDraft}
              >
                {projectLabel}
              </button>
            </Tooltip>
            <span className={styles.bcSep} aria-hidden="true">
              /
            </span>
            <SessionInlineRename
              title={displayTitle}
              onRename={handleRename}
              disabled={!realSession}
            />
            {sessionAgents && sessionAgents.length > 0 ? (
              <>
                <span className={styles.bcSep} aria-hidden="true">
                  /
                </span>
                <SubagentHeaderPanel
                  agents={sessionAgents}
                  parentSessionId={sid}
                />
              </>
            ) : null}
            <ChatHeaderMore
              className={styles.actionBtn}
              onTogglePin={realSession ? handleTogglePin : undefined}
              isPinned={isPinned}
              onExportMarkdown={handleExport}
              canExport={canExport}
              onClearHistory={
                realSession && messageCount > 0 ? handleClear : undefined
              }
              onMoveToFolder={realSession ? handleMoveToFolder : undefined}
              onShare={realSession ? handleShare : undefined}
              shareFlash={shareFlash}
              folderOptions={folderOptions}
              currentFolder={folder || GENERAL_FOLDER}
            />
          </nav>
        </div>

        {/* ── 右侧：左侧边栏开关 + 5大核心产品工具 + 右坞收起 ── */}
        <div className={styles.topActions}>
          <Tooltip content="切换左侧边栏" side={UNIT_CHROME_TOOL_TIP_SIDE}>
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              className={styles.actionBtn}
              data-testid="sidebar-toggle-btn"
              aria-label="切换左侧边栏"
              onClick={handleToggleLeftSidebar}
              icon={<IconSidebarLeft size={15} aria-hidden />}
            />
          </Tooltip>
          <span className={styles.toolbarDivider} aria-hidden="true" />
          {UNIT_TOOL_PANELS.map(({ id, label, testId, Icon }) => {
            if (!viewRegistry.getView(id)) return null;
            const isOpen = openPanelSet.has(id);
            const isActive = !rightDockCollapsed && activePanelId === id;
            return (
              <Tooltip
                key={id}
                content={resolveUnitChromeToolTip(label)}
                side={UNIT_CHROME_TOOL_TIP_SIDE}
              >
                <IconButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.actionBtn}
                  data-testid={testId}
                  data-panel={id}
                  data-active={isActive ? 'true' : 'false'}
                  data-open={isOpen && !rightDockCollapsed ? 'true' : 'false'}
                  aria-label={label}
                  aria-pressed={isActive}
                  onClick={() => handleOpenTool(id)}
                  icon={<Icon size={15} strokeWidth={1.75} aria-hidden />}
                />
              </Tooltip>
            );
          })}
          <Tooltip
            content={resolveUnitChromeToolTip(dockLabel)}
            side={UNIT_CHROME_TOOL_TIP_SIDE}
          >
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              className={styles.actionBtn}
              data-testid="right-dock-toggle"
              data-active={rightDockCollapsed ? 'false' : 'true'}
              aria-label={dockLabel}
              aria-expanded={!rightDockCollapsed}
              aria-pressed={!rightDockCollapsed}
              onClick={handleToggleRightDock}
              icon={<IconSidebarRight size={15} aria-hidden />}
            />
          </Tooltip>
        </div>
      </header>
    );
  }
);

UnitChromeActions.displayName = 'UnitChromeActions';
