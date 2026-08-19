import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatHeaderMore.module.css';
import { IconButton, Menu, Tooltip } from '../ui';
import type { SelectOptionItem } from '../ui';
import { UNIT_CHROME_TOOL_TIP_SIDE } from './unitChromeLabel';

interface FolderOption {
  id: string;
  label: string;
}

interface Props {
  onClearHistory?: () => void;
  onExportMarkdown?: () => void;
  onTogglePin?: () => void;
  isPinned?: boolean;
  canExport?: boolean;
  onMoveToFolder?: (folderId: string) => void;
  folderOptions?: FolderOption[];
  currentFolder?: string;
  className?: string;
}

/**
 * 会话更多选项按钮 (⋯)
 * 对话顶行右侧固定钮；基于 ui/Menu 基座。
 */
export const ChatHeaderMore: React.FC<Props> = ({
  onClearHistory,
  onExportMarkdown,
  onTogglePin,
  isPinned = false,
  canExport = true,
  onMoveToFolder,
  folderOptions,
  currentFolder,
  className,
}) => {
  const moveItems: SelectOptionItem[] =
    onMoveToFolder && folderOptions
      ? folderOptions
          .filter((f) => f.id !== currentFolder)
          .map((f) => ({
            id: `move:${f.id}`,
            label: `移到${f.label}`,
            icon: <Lucide.Folder size={13} style={{ marginRight: 6 }} />,
            onClick: () => onMoveToFolder(f.id),
          }))
      : [];

  const options: SelectOptionItem[] = [
    ...(onTogglePin
      ? [
          {
            id: 'pin',
            label: isPinned ? '取消固定' : '固定会话',
            icon: <Lucide.Pin size={13} style={{ marginRight: 6 }} />,
            onClick: onTogglePin,
          },
        ]
      : []),
    ...moveItems,
    ...(onExportMarkdown && canExport
      ? [
          {
            id: 'export',
            label: '导出 Markdown',
            icon: <Lucide.Download size={13} style={{ marginRight: 6 }} />,
            onClick: onExportMarkdown,
          },
        ]
      : []),
    ...(onClearHistory
      ? [
          {
            id: 'clear',
            label: '清空记录',
            icon: <Lucide.Trash2 size={13} style={{ marginRight: 6 }} />,
            danger: true,
            onClick: onClearHistory,
          },
        ]
      : []),
  ];

  return (
    <Menu
      trigger={
        <Tooltip content="更多操作" side={UNIT_CHROME_TOOL_TIP_SIDE}>
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.moreBtn}${className ? ` ${className}` : ''}`}
            data-testid="chat-header-more"
            aria-label="更多选项"
            icon={<Lucide.MoreHorizontal size={16} />}
          />
        </Tooltip>
      }
      options={options}
      position={{ align: 'end', side: 'bottom', sideOffset: 6 }}
      panel={{ contentClassName: `${styles.moreMenu} no-drag` }}
      renderItem={(opt) => (
        <button
          key={opt.id}
          type="button"
          role="menuitem"
          className={`${styles.moreItem} ${opt.danger ? styles.danger : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            opt.onClick?.();
          }}
        >
          {opt.icon}
          <span>{opt.label}</span>
        </button>
      )}
    />
  );
};
