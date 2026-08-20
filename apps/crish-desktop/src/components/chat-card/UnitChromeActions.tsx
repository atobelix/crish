import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Globe, FileCode, PanelRight } from 'lucide-react';
import { ChatHeaderMore } from './ChatHeaderMore';
import { SessionInlineRename } from './SessionInlineRename';
import { SubagentHeaderPanel } from './SubagentHeaderPanel';
import { IconButton, Tooltip } from '../ui';
import {
  resolveUnitChromeLabel,
  resolveUnitChromeToolTip,
  UNIT_CHROME_TOOL_TIP_SIDE,
} from './unitChromeLabel';
import { IconSidebarRight } from '../sidebar/SidebarToggleIcons';
import {
  applyDockToTree,
  listProjects,
  openToolInSession,
  pinSession,
  projectFolderLabel,
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
    const activePanelId = dockSnapshot?.activePanelId;

    const isPreviewActive =
      !rightDockCollapsed &&
      (activePanelId === 'preview' || activePanelId === 'overview');
    const isArtifactsActive =
      !rightDockCollapsed && activePanelId === 'files';

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

    const handleOpenPreview = useCallback(() => {
      openToolInSession((activeSessionId || '').trim(), 'preview');
    }, [activeSessionId]);

    const handleOpenArtifacts = useCallback(() => {
      openToolInSession((activeSessionId || '').trim(), 'files');
    }, [activeSessionId]);

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
        {/* ── 左侧：三级面包屑导航 (3-Level Breadcrumbs) ── */}
        <div className={`${styles.topLeft} chat-top-left`}>
          {leading}
          <nav className={`${styles.breadcrumbs} top-breadcrumbs`} aria-label="Breadcrumb">
            {/* Level 1: Project */}
            <div className={`${styles.breadcrumbItem} breadcrumb-item`}>
              <Tooltip content="点击新建此项目对话" side={UNIT_CHROME_TOOL_TIP_SIDE}>
                <button
                  type="button"
                  id="bcProject"
                  className={`${styles.bcProjectBtn} breadcrumb-project`}
                  onClick={handleJumpToNewDraft}
                >
                  <span className={`${styles.bcText} bc-text`}>{projectLabel}</span>
                </button>
              </Tooltip>
            </div>

            {/* 分割符 1 */}
            <span className={`${styles.bcSep} bc-sep`} aria-hidden="true">
              /
            </span>

            {/* Level 2: Session */}
            <div
              className={`${styles.breadcrumbItem} ${styles.breadcrumbSession} breadcrumb-item breadcrumb-session`}
              id="bcSession"
            >
              <SessionInlineRename
                title={displayTitle}
                onRename={handleRename}
                disabled={!realSession}
              />
            </div>

            {/* Level 3: Subagent Status Item */}
            {sessionAgents && sessionAgents.length > 0 ? (
              <>
                <span
                  className={`${styles.bcSep} ${styles.bcAgentSep} bc-sep bc-agent-sep`}
                  aria-hidden="true"
                >
                  /
                </span>
                <div className={`${styles.breadcrumbItem} breadcrumb-item`}>
                  <SubagentHeaderPanel
                    agents={sessionAgents}
                    parentSessionId={sid}
                  />
                </div>
              </>
            ) : null}
          </nav>
        </div>

        {/* ── 右侧：极简动作组 (预览 / 产物 / 更多 / 右坞固定切换) ── */}
        <div className={`${styles.topActions} chat-top-actions`}>
          {/* 按钮 1: 应用预览 (🌐 Globe) */}
          <Tooltip content="打开应用预览" side={UNIT_CHROME_TOOL_TIP_SIDE}>
            <button
              type="button"
              id="topQuickPreviewBtn"
              className={`${styles.topActionBtn} top-action-btn`}
              data-testid="top-quick-preview-btn"
              data-active={isPreviewActive ? 'true' : 'false'}
              aria-label="打开应用预览"
              onClick={handleOpenPreview}
            >
              <Globe size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </Tooltip>

          {/* 按钮 2: 代码产物与文件 (📄 FileCode) */}
          <Tooltip content="打开代码产物与文件" side={UNIT_CHROME_TOOL_TIP_SIDE}>
            <button
              type="button"
              id="topQuickArtifactsBtn"
              className={`${styles.topActionBtn} top-action-btn`}
              data-testid="top-quick-artifacts-btn"
              data-active={isArtifactsActive ? 'true' : 'false'}
              aria-label="打开代码产物与文件"
              onClick={handleOpenArtifacts}
            >
              <FileCode size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </Tooltip>

          {/* 按钮 3: 更多操作 (⋯ More) */}
          <div className={`${styles.chatHeaderMoreTrigger} chat-header-more-trigger`}>
            <ChatHeaderMore
              className={`${styles.topActionBtn} top-action-btn`}
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
          </div>

          {/* 按钮 4: 右侧工作区固定切换按钮 (◫ PanelRight) */}
          <Tooltip content={dockLabel} side={UNIT_CHROME_TOOL_TIP_SIDE}>
            <button
              type="button"
              id="topQuickDockBtn"
              className={`${styles.topActionBtn} top-action-btn top-side-panel-btn ${!rightDockCollapsed ? styles.isActive : ''}`}
              data-testid="top-quick-dock-btn"
              data-active={!rightDockCollapsed ? 'true' : 'false'}
              aria-label={dockLabel}
              onClick={handleToggleRightDock}
            >
              <PanelRight size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </header>
    );
  }
);

UnitChromeActions.displayName = 'UnitChromeActions';
