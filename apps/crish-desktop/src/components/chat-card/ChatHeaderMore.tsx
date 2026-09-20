import React, { useMemo } from 'react';

import { Button, Tooltip } from '../ui';
import {
  SmartExpandablePanel,
  type MenuItem,
} from '../ui/SmartExpandablePanel';
import { UNIT_CHROME_TOOL_TIP_SIDE } from './unitChromeLabel';
import { AppIcon } from '../ui/icons/index';

export interface FolderOption {
  id: string;
  label: string;
}

export interface ChatHeaderMoreProps {
  onClearHistory?: () => void;
  onExportMarkdown?: () => void;
  onTogglePin?: () => void;
  isPinned?: boolean;
  canExport?: boolean;
  onMoveToFolder?: (folderId: string) => void;
  folderOptions?: FolderOption[];
  currentFolder?: string;
  className?: string;
  onShare?: () => void;
  shareFlash?: boolean;
}

/**
 * 会话更多选项按钮 (⋯)
 * 对话顶行右侧固定钮；基于 SmartExpandablePanel 纯数据驱动。
 */
export const ChatHeaderMore: React.FC<ChatHeaderMoreProps> = ({
  onClearHistory,
  onExportMarkdown,
  onTogglePin,
  isPinned = false,
  canExport = true,
  onMoveToFolder,
  folderOptions,
  currentFolder,
  className,
  onShare,
  shareFlash = false,
}) => {
  const menuItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [];

    // 1. 固定/取消固定会话
    if (onTogglePin) {
      items.push({
        id: 'action:pin',
        label: isPinned ? '取消固定' : '固定会话',
        icon: isPinned ? <AppIcon name="pin-off" size={14} /> : <AppIcon name="pin" size={14} />,
        onSelect: onTogglePin,
      });
    }

    // 2. 移动至文件夹/项目（如有多个可选）
    if (onMoveToFolder && folderOptions && folderOptions.length > 0) {
      const validFolders = folderOptions.filter((f) => f.id !== currentFolder);
      if (validFolders.length > 0) {
        items.push({
          id: 'submenu:move',
          type: 'submenu',
          label: '移动到项目...',
          icon: <AppIcon name="folder" size={14} />,
          children: validFolders.map((f) => ({
            id: `move:${f.id}`,
            label: f.label,
            icon: <AppIcon name="folder" size={14} />,
            onSelect: () => onMoveToFolder(f.id),
          })),
        });
      }
    }

    // 3. 导出与分享功能组
    const exportShareItems: MenuItem[] = [];
    if (onExportMarkdown && canExport) {
      exportShareItems.push({
        id: 'action:export',
        label: '导出 Markdown',
        icon: <AppIcon name="download" size={14} />,
        shortcut: 'Ctrl+E',
        onSelect: onExportMarkdown,
      });
    }

    if (onShare) {
      exportShareItems.push({
        id: 'action:share',
        label: shareFlash ? '已复制 Markdown' : '分享会话',
        icon: <AppIcon name="link" size={14} />,
        badge: shareFlash ? '已复制' : undefined,
        onSelect: onShare,
      });
    }

    if (exportShareItems.length > 0) {
      if (items.length > 0) {
        items.push({ id: 'divider:export-share', type: 'divider' });
      }
      items.push(...exportShareItems);
    }

    // 4. 危险操作组（清空记录）
    if (onClearHistory) {
      if (items.length > 0) {
        items.push({ id: 'divider:danger', type: 'divider' });
      }
      items.push({
        id: 'action:clear',
        label: '清空记录',
        icon: <AppIcon name="trash" size={14} />,
        danger: true,
        onSelect: onClearHistory,
      });
    }

    return items;
  }, [
    onTogglePin,
    isPinned,
    onMoveToFolder,
    folderOptions,
    currentFolder,
    onExportMarkdown,
    canExport,
    onShare,
    shareFlash,
    onClearHistory,
  ]);

  const trigger = (
    <Tooltip content="更多操作" side={UNIT_CHROME_TOOL_TIP_SIDE}>
      <Button
        type="button"
        variant="ghost"
        className={`${className || ''} top-action-btn`}
        data-testid="chat-header-more"
        aria-label="更多选项"
      >
        <AppIcon name="more-horizontal" size={14} aria-hidden="true" />
      </Button>
    </Tooltip>
  );

  return (
    <SmartExpandablePanel
      trigger={trigger}
      items={menuItems}
      position={{ align: 'end', side: 'bottom', sideOffset: 6 }}
      className="chat-header-more-panel"
    />
  );
};
