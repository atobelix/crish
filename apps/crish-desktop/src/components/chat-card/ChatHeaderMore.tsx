import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatHeaderMore.module.css';
import { Button, Menu } from '../ui';
import type { SelectOptionItem } from '../ui';

interface Props {
  onClearHistory?: () => void;
  onExportMarkdown?: () => void;
  onTogglePin?: () => void;
  isPinned?: boolean;
  canExport?: boolean;
}

/**
 * 会话更多选项按钮 (⋯)
 * 基于 ui/Menu 基座（T05.3.2 由 common/UnifiedSelectPopover 改 import），
 * 靠近视口底部/右侧时自动视口翻转 (Auto Flip & Shift)，绝不受侧栏滚动条溢出遮挡。
 */
export const ChatHeaderMore: React.FC<Props> = ({
  onClearHistory,
  onExportMarkdown,
  onTogglePin,
  isPinned = false,
  canExport = true,
}) => {
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.moreBtn}
          aria-label="更多选项"
          icon={<Lucide.MoreHorizontal size={15} />}
        />
      }
      options={options}
      align="end"
      side="bottom"
      sideOffset={6}
      contentClassName={`${styles.moreMenu} no-drag`}
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
