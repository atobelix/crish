import React, { useMemo } from 'react';

import { SmartPanel, type MenuItem } from '../ui/SmartPanel';
import { useLayerRegistration } from '../ui/internal/layer-registration/useLayerRegistration';
import type {
  SessionContextMenuState,
  SessionMenuAction,
} from './SidebarContextMenus';
import { AppIcon } from '../ui/icons';

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
 * 会话右键菜单统一适配器（基于 SmartPanel）。
 * 纯数据驱动 MenuItem 架构，具备 1px 发丝边框、同心几何与 4 层漫反射光影。
 */
export const SessionContextMenu: React.FC<SessionContextMenuProps> = ({
  contextMenu,
  menuRef,
  isPinned,
  onSessionAction,
  onCloseContextMenu,
  contextMenuTriggerRef,
}) => {
  const isOpen = Boolean(contextMenu);

  useLayerRegistration(
    {
      id: SESSION_CONTEXT_MENU_LAYER_ID,
      type: 'context-menu',
      dismissible: true,
      onDismiss: () => onCloseContextMenu?.(),
      elementRef: menuRef,
      anchorRef: contextMenuTriggerRef,
      restoreFocusTarget: contextMenuTriggerRef?.current ?? undefined,
    },
    isOpen
  );

  const items = useMemo<MenuItem[]>(
    () => [
      {
        id: 'open-current',
        label: '在此处打开',
        icon: <AppIcon name="message-circle" size={14} aria-hidden />,
        onSelect: () => onSessionAction('open-current'),
      },
      {
        id: 'open-split',
        label: '拆分视图',
        icon: <AppIcon name="columns" size={14} aria-hidden />,
        onSelect: () => onSessionAction('open-split'),
      },
      {
        id: 'open-new',
        label: '在新窗口打开',
        icon: <AppIcon name="external-link" size={14} aria-hidden />,
        onSelect: () => onSessionAction('open-new'),
      },
      { type: 'divider', id: 'div-1' },
      {
        id: 'rename',
        label: '重命名',
        shortcut: 'F2',
        icon: <AppIcon name="pencil" size={14} aria-hidden />,
        onSelect: () => onSessionAction('rename'),
      },
      {
        id: isPinned ? 'unpin' : 'pin',
        label: isPinned ? '取消置顶' : '置顶',
        icon: isPinned ? (
          <AppIcon name="pin-off" size={14} aria-hidden />
        ) : (
          <AppIcon name="pin" size={14} aria-hidden />
        ),
        onSelect: () => onSessionAction(isPinned ? 'unpin' : 'pin'),
      },
      {
        id: 'archive',
        label: '归档',
        icon: <AppIcon name="archive" size={14} aria-hidden />,
        onSelect: () => onSessionAction('archive'),
      },
      {
        id: 'branch',
        label: '分叉',
        shortcut: 'Ctrl+Shift+D',
        icon: <AppIcon name="git-fork" size={14} aria-hidden />,
        onSelect: () => onSessionAction('branch'),
      },
      { type: 'divider', id: 'div-2' },
      {
        id: 'copy-id',
        label: '复制会话 ID',
        icon: <AppIcon name="copy" size={14} aria-hidden />,
        onSelect: () => onSessionAction('copy-id'),
      },
      {
        id: 'delete',
        label: '删除当前对话',
        shortcut: 'Del',
        danger: true,
        icon: <AppIcon name="trash" size={14} aria-hidden />,
        onSelect: () => onSessionAction('delete'),
      },
      { type: 'divider', id: 'div-3' },
      {
        id: 'export',
        label: '导出 Markdown',
        tooltip: '导出为 Markdown',
        icon: <AppIcon name="file-download" size={14} aria-hidden />,
        onSelect: () => onSessionAction('export'),
      },
    ],
    [isPinned, onSessionAction]
  );

  return (
    <SmartPanel
      open={Boolean(contextMenu)}
      point={{ x: contextMenu.x, y: contextMenu.y }}
      triggerRef={contextMenuTriggerRef}
      panelRef={menuRef}
      items={items}
      onClose={onCloseContextMenu}
      role="menu"
      ariaLabel="会话操作"
      dataTestId="session-context-menu"
      style={{
        zIndex: 'var(--z-context-menu, var(--z-popover))',
        pointerEvents: 'auto',
      }}
    />
  );
};
