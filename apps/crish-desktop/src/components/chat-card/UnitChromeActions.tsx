/**
 * Unit 级工具入口（右坞面板 + 坞折叠 + 更多）。
 * 单 unit：嵌在 ChatHeader；多 chat 分屏：嵌在 UnitSessionTabStrip 同行右侧，
 * 避免「标签行 + 工具行」叠成三行顶栏。
 */
import React, { useCallback, useMemo } from 'react';
import {
  FolderTree,
  GitBranch,
  Terminal,
  LayoutDashboard,
} from 'lucide-react';
import { ChatHeaderMore } from '../ChatHeaderMore';
import { Tooltip } from '../Tooltip';
import { IconSidebarRight } from '../SidebarToggleIcons';
import {
  openToolInSession,
  applyDockToTree,
  useWorkspaceShellStore,
} from '../../store/workspace-shell';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { pinSession, unpinSession } from '../../api/storeAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import styles from './ChatHeader.module.css';

export const UNIT_TOOL_PANELS = [
  {
    id: 'overview',
    label: '打开总览',
    testId: 'chat-open-overview',
    Icon: LayoutDashboard,
  },
  {
    id: 'files',
    label: '打开文件',
    testId: 'chat-open-files',
    Icon: FolderTree,
  },
  {
    id: 'diff',
    label: '打开差异',
    testId: 'chat-open-diff',
    Icon: GitBranch,
  },
  {
    id: 'terminal',
    label: '打开终端',
    testId: 'chat-open-terminal',
    Icon: Terminal,
  },
] as const;

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
    const session = activeSessionId
      ? getCompositionRoot().session.getState().sessionsById[activeSessionId]
      : undefined;
    const isPinned = Boolean(session?.isPinned);
    const canExport = Boolean(session && (session.messages?.length ?? 0) > 0);

    const dockSnapshot = useWorkspaceShellStore((s) => {
      const sid = (activeSessionId || '').trim();
      const tab = sid
        ? s.openTabs.find((t) => t.sessionId === sid)
        : s.openTabs.find((t) => t.tabId === s.activeTabId);
      return tab?.rightDock ?? null;
    });
    const rightDockCollapsed = useLayoutTreeStore((s) => s.toolColumnCollapsed);
    const openPanelIds = dockSnapshot?.openPanelIds;
    const activePanelId = dockSnapshot?.activePanelId;

    const openPanelSet = useMemo(
      () => new Set(openPanelIds ?? []),
      [openPanelIds]
    );

    const handleTogglePin = useCallback(() => {
      const id = (activeSessionId || '').trim();
      if (!id || id.startsWith('__pending')) return;
      if (isPinned) unpinSession(id);
      else pinSession(id);
    }, [activeSessionId, isPinned]);

    const handleOpenTool = useCallback(
      (panelId: string) => {
        openToolInSession((activeSessionId || '').trim(), panelId);
      },
      [activeSessionId]
    );

    const handleToggleRightDock = useCallback(() => {
      const shell = getCompositionRoot().shell.getState();
      const sid = (activeSessionId || '').trim();
      const tab = sid
        ? shell.openTabs.find((t) => t.sessionId === sid) ?? shell.getActiveTab()
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

    return (
      <div
        className={`${styles.toolbarActions}${className ? ` ${className}` : ''}`}
        data-unit-chrome-actions="true"
      >
        <div className={styles.toolGroup} role="group" aria-label="会话工具">
          {leading}
          {UNIT_TOOL_PANELS.map(({ id, label, testId, Icon }) => {
            const isOpen = openPanelSet.has(id);
            const isActive = !rightDockCollapsed && activePanelId === id;
            return (
              <Tooltip key={id} content={label}>
                <button
                  type="button"
                  className={styles.toolBtn}
                  data-testid={testId}
                  data-panel={id}
                  data-active={isActive ? 'true' : 'false'}
                  data-open={isOpen && !rightDockCollapsed ? 'true' : 'false'}
                  aria-label={label}
                  aria-pressed={isActive}
                  onClick={() => handleOpenTool(id)}
                >
                  <Icon size={15} strokeWidth={1.75} aria-hidden />
                </button>
              </Tooltip>
            );
          })}
          <ChatHeaderMore
            onTogglePin={
              activeSessionId && !activeSessionId.startsWith('__pending')
                ? handleTogglePin
                : undefined
            }
            isPinned={isPinned}
            onExportMarkdown={onExportMarkdown}
            canExport={canExport}
            onClearHistory={onClearHistory}
          />
        </div>

        {rightDockCollapsed && (
          <>
            <span className={styles.toolbarDivider} aria-hidden="true" />
            <div className={styles.dockGroup}>
              <Tooltip
                content="展开右侧工具栏"
              >
                <button
                  type="button"
                  className={styles.toolBtn}
                  data-testid="right-dock-toggle"
                  data-active="false"
                  aria-label="展开右侧工具栏"
                  aria-expanded={false}
                  aria-pressed={false}
                  onClick={handleToggleRightDock}
                >
                  <IconSidebarRight size={15} aria-hidden />
                </button>
              </Tooltip>
            </div>
          </>
        )}
      </div>
    );
  }
);

UnitChromeActions.displayName = 'UnitChromeActions';
