import React from 'react';
import { getCompositionRoot } from '../../app/compositionRoot';
import { ContextMenuFlyout } from './ContextMenuFlyout';
import { SessionContextMenu } from './SessionContextMenu';
import { t } from '../../i18n';

export type SessionContextMenuState = {
  x: number;
  y: number;
  sessionId: string;
  triggerRect?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
  isMoreButton?: boolean;
};

/** 侧栏会话右键菜单动作（与 Sidebar.handleAction 对齐） */
export type SessionMenuAction =
  | 'open-current'
  | 'open-split'
  | 'open-new'
  | 'rename'
  | 'pin'
  | 'unpin'
  | 'archive'
  | 'branch'
  | 'export'
  | 'copy-id'
  | 'delete';

/** 归档/分叉可撤销 toast 文案（与 useToastQueue 策略 /^已归档:/ /^已分叉:/ 一致） */
export function archiveUndoToastMessage(
  title: string,
  prefix = t('sidebar.archivedPrefix', '已归档: ')
): string {
  return `${prefix}${title}`;
}

export function branchUndoToastMessage(
  title: string,
  prefix = t('sidebar.forkedPrefix', '已分叉: ')
): string {
  return `${prefix}${title}`;
}

/** 分叉新建会话标题后缀（侧栏/顶栏/快捷键路径宜一致用「分支」作为标题片段） */
export const BRANCH_TITLE_SUFFIX = ' - 分支';

export interface SidebarContextMenusProps {
  menuRef: React.RefObject<HTMLDivElement | null>;
  sortMenuRef: React.RefObject<HTMLDivElement | null>;
  contextMenu: SessionContextMenuState | null;
  onSessionAction: (action: SessionMenuAction) => void;
  sortDropdownOpen: boolean;
  sortDropdownCoords: { x: number; y: number } | null;
  sortType: 'active' | 'name';
  groupType: 'folder' | 'none';
  filterType: 'all' | 'pinned';
  onSetSortType: (v: 'active' | 'name') => void;
  onSetGroupType: (v: 'folder' | 'none') => void;
  onSetFilterType: (v: 'all' | 'pinned') => void;
  onCloseSortDropdown: () => void;
  onCloseContextMenu?: () => void;
  contextMenuTriggerRef?: React.RefObject<HTMLElement | null>;
  sortTriggerRef?: React.RefObject<HTMLElement | null>;
}

// 坐标钳位单源：ui/Menu/position.ts 的 clampPosition / measureMenu
// （T05.3.1 收敛后本文件不再保留独立坐标实现）

/**
 * 会话右键菜单 + 排序下拉。
 * 紧凑：少分割线、无 agent 树菜单、置顶/重命名/归档同组。
 * 中文标签与侧栏分区「置顶」一致；无目标会话（幽灵/已归档）不渲染菜单。
 */
export const SidebarContextMenus: React.FC<SidebarContextMenusProps> = ({
  menuRef,
  sortMenuRef,
  contextMenu,
  onSessionAction,
  sortDropdownOpen,
  sortDropdownCoords,
  sortType,
  groupType,
  filterType,
  onSetSortType,
  onSetGroupType,
  onSetFilterType,
  onCloseSortDropdown,
  onCloseContextMenu,
  contextMenuTriggerRef,
  sortTriggerRef,
}) => {
  const target = contextMenu
    ? (() => {
        const root = getCompositionRoot();
        const store = root.session.getState();
        const s =
          store.sessionsById[contextMenu.sessionId] ??
          store.sessions.find((sess) => sess.id === contextMenu.sessionId);
        return s && !s.isArchived ? s : undefined;
      })()
    : undefined;
  const isPinned = !!target?.isPinned;
  const showSessionMenu = !!(contextMenu && target);

  return (
    <>
      {showSessionMenu && contextMenu && (
        <SessionContextMenu
          contextMenu={contextMenu}
          menuRef={menuRef}
          isPinned={isPinned}
          onSessionAction={onSessionAction}
          onCloseContextMenu={onCloseContextMenu}
          contextMenuTriggerRef={contextMenuTriggerRef}
        />
      )}

      <ContextMenuFlyout
        sortMenuRef={sortMenuRef}
        sortDropdownOpen={sortDropdownOpen}
        sortDropdownCoords={sortDropdownCoords}
        sortType={sortType}
        groupType={groupType}
        filterType={filterType}
        onSetSortType={onSetSortType}
        onSetGroupType={onSetGroupType}
        onSetFilterType={onSetFilterType}
        onCloseSortDropdown={onCloseSortDropdown}
        sortTriggerRef={sortTriggerRef}
      />
    </>
  );
};
