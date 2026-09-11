import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { ChatHeaderMore } from './ChatHeaderMore';
import { SessionInlineRename } from './SessionInlineRename';
import { SubagentHeaderPanel } from './SubagentHeaderPanel';
import { Tooltip } from '../ui';
import {
  resolveUnitChromeLabel,
  UNIT_CHROME_TOOL_TIP_SIDE,
} from './unitChromeLabel';
import {
  listProjects,
  openToolInSession,
  pinSession,
  projectFolderLabel,
  unpinSession,
  useSessionField,
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
import { useDraftFolder } from '../../store/draft-routing';
import styles from './UnitChromeActions.module.css';
import { AppIcon } from '../ui/icons/index';

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
  dockOpen?: boolean;
  dockPanelId?: string | null;
  onOpenPreview?: () => void;
  onOpenFiles?: () => void;
}

export const UnitChromeActions: React.FC<UnitChromeActionsProps> = React.memo(
  ({
    activeSessionId,
    className,
    leading,
    onClearHistory,
    onExportMarkdown,
    dockOpen = false,
    dockPanelId = null,
    onOpenPreview,
    onOpenFiles,
  }) => {
    const sid = (activeSessionId || '').trim();
    const isDraft = !sid || isPendingDraft(sid);
    const realSession = !isDraft;

    const registeredDraftFolder = useDraftFolder(sid);
    const storeDraftFolder = useSessionField((s) => s.draftFolder);
    const sessionFolder = useSessionField((s) => {
      if (!sid) return undefined;
      return s.sessionsById[sid]?.folder;
    });

    const folder = isDraft
      ? (registeredDraftFolder || storeDraftFolder)
      : (sessionFolder ?? registeredDraftFolder ?? storeDraftFolder);

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
      { folder },
      listProjects()
    );

    const rightDockCollapsed = !dockOpen;
    const isPreviewActive = dockOpen && dockPanelId === 'preview';
    const isArtifactsActive = dockOpen && dockPanelId === 'files';

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
      if (onOpenPreview) {
        onOpenPreview();
        return;
      }
      openToolInSession((activeSessionId || '').trim(), 'preview');
    }, [activeSessionId, onOpenPreview]);

    const handleOpenFiles = useCallback(() => {
      if (onOpenFiles) {
        onOpenFiles();
        return;
      }
      openToolInSession((activeSessionId || '').trim(), 'files');
    }, [activeSessionId, onOpenFiles]);

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

    // 新建草稿或未发送消息的空状态下无需展示顶部操作栏，保持界面干净
    if (isDraft) {
      return null;
    }

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

        {/* ── 右侧：极简动作组 (Exactly 3 核心操作: 预览 / 产物 / 更多，右坞收起时留 36px margin 供绝对定位按钮锚定) ── */}
        <div
          className={`${styles.topActions} ${
            rightDockCollapsed ? styles.withDockMargin : ''
          } chat-top-actions`}
        >
          {/* 按钮 1: 浏览器 (🌐 Globe) */}
          <Tooltip content="浏览器" side={UNIT_CHROME_TOOL_TIP_SIDE}>
            <button
              type="button"
              id="topQuickPreviewBtn"
              className={`${styles.topActionBtn} top-action-btn`}
              data-testid="top-quick-preview-btn"
              data-active={isPreviewActive ? 'true' : 'false'}
              aria-label="浏览器"
              onClick={handleOpenPreview}
            >
              <AppIcon name="globe" size={14} aria-hidden="true" />
            </button>
          </Tooltip>

          {/* 按钮 2: 文件管理器 (📁 FolderTree) */}
          <Tooltip content="打开文件" side={UNIT_CHROME_TOOL_TIP_SIDE}>
            <button
              type="button"
              id="topQuickFilesBtn"
              className={`${styles.topActionBtn} top-action-btn`}
              data-testid="top-quick-files-btn"
              data-active={isArtifactsActive ? 'true' : 'false'}
              aria-label="打开文件"
              onClick={handleOpenFiles}
            >
              <AppIcon name="folder-tree" size={14} aria-hidden="true" />
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
        </div>
      </header>
    );
  }
);

UnitChromeActions.displayName = 'UnitChromeActions';
