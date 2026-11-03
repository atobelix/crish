import React from 'react';

import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from '../ui/ContextMenu';
import type {
  SessionContextMenuState,
  SessionMenuAction,
} from './SidebarContextMenus';
import { AppIcon } from '@/components/ui/icons';
import { t } from '../../i18n';

/** 与 LayerStack exclusive 同槽；登记时驱逐 dropdown / 其它 context-menu */
export const SESSION_CONTEXT_MENU_LAYER_ID = 'sidebar-session-context-menu';

export interface SessionContextMenuProps {
  contextMenu: SessionContextMenuState;
  menuRef: React.RefObject<HTMLDivElement | null>;
  isPinned: boolean;
  onSessionAction: (action: SessionMenuAction) => void;
  onCloseContextMenu?: () => void;
  contextMenuTriggerRef?: React.RefObject<HTMLElement | null>;
}

/**
 * 会话右键菜单（全应用统一上下文菜单基座 ui/ContextMenu 之上）。
 * LayerStack 登记由基座独占：id 固定为 SESSION_CONTEXT_MENU_LAYER_ID，
 * type 'context-menu'，elementRef = menuRef（Popup），anchorRef = 触发元素，
 * 关闭后焦点还原触发元素——与收敛前的登记契约逐项一致。
 */
export const SessionContextMenu: React.FC<SessionContextMenuProps> = ({
  contextMenu,
  menuRef,
  isPinned,
  onSessionAction,
  onCloseContextMenu,
  contextMenuTriggerRef,
}) => {
  const isMoreButton = Boolean(
    contextMenu.isMoreButton ||
    (contextMenuTriggerRef?.current &&
      (contextMenuTriggerRef.current.tagName === 'BUTTON' ||
        contextMenuTriggerRef.current.getAttribute('role') === 'button' ||
        contextMenuTriggerRef.current.dataset.testid === 'session-more-button'))
  );

  return (
    <ContextMenu
      key={contextMenu.sessionId}
      open={Boolean(contextMenu)}
      onOpenChange={(next) => {
        if (!next) onCloseContextMenu?.();
      }}
      anchor={
        // 「更多」按钮变体：以触发按钮元素本身为锚（side=right 贴按钮右缘
        // 展开），不依赖状态中的点击点坐标（其来源经行组件重包装，不可靠）；
        // 右键变体仍以原始点击点为锚。
        isMoreButton && contextMenuTriggerRef?.current
          ? contextMenuTriggerRef
          : { x: contextMenu.x, y: contextMenu.y }
      }
      anchorElement={contextMenuTriggerRef?.current ?? null}
      layerId={SESSION_CONTEXT_MENU_LAYER_ID}
      popupRef={menuRef}
      side={isMoreButton ? 'right' : 'bottom'}
      align="start"
      sideOffset={6}
      zIndex="var(--z-context-menu, var(--z-popover))"
      data-testid="session-context-menu"
      aria-label={t('sidebar.sessionActions', '会话操作')}
    >
      <ContextMenuItem
        icon={<AppIcon name="message-circle" size={16} aria-hidden />}
        onSelect={() => onSessionAction('open-current')}
      >
        {t('sidebar.sessionMenuOpenHere', '在此处打开')}
      </ContextMenuItem>
      <ContextMenuItem
        icon={<AppIcon name="columns" size={16} aria-hidden />}
        onSelect={() => onSessionAction('open-split')}
      >
        {t('sidebar.sessionMenuOpenSplit', '拆分视图')}
      </ContextMenuItem>
      <ContextMenuItem
        icon={<AppIcon name="external-link" size={16} aria-hidden />}
        onSelect={() => onSessionAction('open-new')}
      >
        {t('sidebar.sessionMenuOpenNew', '在新窗口打开')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={<AppIcon name="pencil" size={16} aria-hidden />}
        shortcut="F2"
        onSelect={() => onSessionAction('rename')}
      >
        {t('sidebar.rename', '重命名')}
      </ContextMenuItem>
      <ContextMenuItem
        icon={
          isPinned ? (
            <AppIcon name="pin-off" size={16} aria-hidden />
          ) : (
            <AppIcon name="pin" size={16} aria-hidden />
          )
        }
        onSelect={() => onSessionAction(isPinned ? 'unpin' : 'pin')}
      >
        {isPinned ? t('sidebar.unpin', '取消置顶') : t('sidebar.pin', '置顶')}
      </ContextMenuItem>
      <ContextMenuItem
        icon={<AppIcon name="archive" size={16} aria-hidden />}
        onSelect={() => onSessionAction('archive')}
      >
        {t('sidebar.archive', '归档')}
      </ContextMenuItem>
      <ContextMenuItem
        icon={<AppIcon name="git-fork" size={16} aria-hidden />}
        shortcut="Ctrl+Shift+F"
        onSelect={() => onSessionAction('branch')}
      >
        {t('sidebar.sessionMenuBranch', '分叉')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={<AppIcon name="copy" size={16} aria-hidden />}
        onSelect={() => onSessionAction('copy-id')}
      >
        {t('sidebar.copySessionId', '复制会话 ID')}
      </ContextMenuItem>
      <ContextMenuItem
        icon={<AppIcon name="trash" size={16} aria-hidden />}
        shortcut="Del"
        danger
        onSelect={() => onSessionAction('delete')}
      >
        {t('sidebar.sessionMenuDelete', '删除当前对话')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={<AppIcon name="file-download" size={16} aria-hidden />}
        title={t('sidebar.exportMarkdown', '导出为 Markdown')}
        onSelect={() => onSessionAction('export')}
      >
        {t('sidebar.sessionMenuExport', '导出 Markdown')}
      </ContextMenuItem>
    </ContextMenu>
  );
};
