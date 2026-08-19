/**
 * 对话叶顶快捷行（参考 chat-top-header）。
 * 覆盖在对话流上：面包屑 + 右侧固定 28px 钮（更多 / 分享 / 坞开关）。
 * 坞开合都不卸载右钮。打开文件等工具在坞头，不在本行。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'lucide-react';
import { ChatHeaderMore } from './ChatHeaderMore';
import { IconButton, Tooltip } from '../ui';
import {
  countRunningSubagents,
  resolveUnitChromeLabel,
  resolveUnitChromeToolTip,
  UNIT_CHROME_TOOL_TIP_SIDE,
} from './unitChromeLabel';
import { IconSidebarRight } from '../sidebar/SidebarToggleIcons';
import {
  applyDockToTree,
  useWorkspaceShellStore,
  useSessionField,
  useLayoutTreeStore,
} from '../../store/storeAccess';
import {
  pinSession,
  unpinSession,
  clearSessionMessages,
} from '../../api/storeAccess';
import {
  EMPTY_SESSION_TITLE,
  sessionListDisplayTitle,
} from '../../api/sessionTitle';
import {
  GENERAL_FOLDER,
  listProjects,
  projectFolderLabel,
} from '../../api/projectStore';
import {
  exportSessionToMarkdown,
  tryDownloadSessionMarkdown,
} from '../../api/sessionExport';
import { toast } from '../../services/toast/ToastContext';
import { getCompositionRoot } from '../../app/compositionRoot';
import { isPendingDraft } from '../../store/draftSession';
import styles from './UnitChromeActions.module.css';

const SHARE_FLASH_MS = 1200;

export interface UnitChromeActionsProps {
  /** 本 unit 会话 id（多 pane 时必须是 leaf.sessionId） */
  activeSessionId?: string | null;
  onExportMarkdown?: () => void;
  onClearHistory?: () => void;
  /** 额外前置控件（如消息搜索按钮） */
  leading?: React.ReactNode;
  className?: string;
}

export const UnitChromeActions: React.FC<UnitChromeActionsProps> = React.memo(
  ({
    activeSessionId,
    onExportMarkdown,
    onClearHistory,
    leading,
    className,
  }) => {
    const sid = (activeSessionId || '').trim();
    const realSession = Boolean(sid) && !isPendingDraft(sid);
    const messageCount = useSessionField((s) =>
      sid ? (s.sessionsById[sid]?.messages?.length ?? 0) : 0
    );
    const isPinned = useSessionField((s) =>
      Boolean(sid && s.sessionsById[sid]?.isPinned)
    );
    const folder = useSessionField((s) =>
      sid ? s.sessionsById[sid]?.folder : undefined
    );
    const displayTitle = useSessionField((s) => {
      if (!sid || isPendingDraft(sid)) return EMPTY_SESSION_TITLE;
      const sess = s.sessionsById[sid];
      if (!sess) return EMPTY_SESSION_TITLE;
      return sessionListDisplayTitle(sess);
    });
    const runningAgents = useSessionField((s) => {
      if (!sid) return 0;
      return countRunningSubagents(s.sessionsById[sid]?.agents);
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
    }, [folder]);

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
        <div className={styles.topLeft}>
          {leading}
          <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
            <span className={`${styles.bcItem} ${styles.bcProject}`}>
              {projectLabel}
            </span>
            <span className={styles.bcSep} aria-hidden="true">
              /
            </span>
            <span className={`${styles.bcItem} ${styles.bcSession}`}>
              {displayTitle}
            </span>
            {runningAgents > 0 ? (
              <>
                <span className={styles.bcSep} aria-hidden="true">
                  /
                </span>
                <span className={`${styles.bcItem} ${styles.bcAgent}`}>
                  <span className={styles.liveDot} aria-hidden="true" />
                  {runningAgents} 个运行中
                </span>
              </>
            ) : null}
          </nav>
        </div>

        <div className={styles.topActions}>
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
            folderOptions={folderOptions}
            currentFolder={folder || GENERAL_FOLDER}
          />
          <Tooltip content="分享" side={UNIT_CHROME_TOOL_TIP_SIDE}>
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              className={styles.actionBtn}
              data-testid="chat-share"
              data-share-flash={shareFlash ? 'true' : 'false'}
              aria-label="分享"
              onClick={handleShare}
              icon={<Link size={16} strokeWidth={2} aria-hidden />}
            />
          </Tooltip>
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
