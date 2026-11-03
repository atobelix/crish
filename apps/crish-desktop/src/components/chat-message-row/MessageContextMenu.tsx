/**
 * components/chat-message-row/MessageContextMenu.tsx
 *
 * 消息行右键菜单（全应用统一上下文菜单基座 ui/ContextMenu 之上）。
 * 只放行级已有真能力的条目，能力出处：
 * - 复制文本：各行既有的 handleCopy（与操作栏复制按钮同一派生与反馈）
 * - 固定/取消固定：行 props 的 onTogglePin（与操作栏固定按钮同一入口）
 * 复制代码：全仓不存在任何代码块复制派生（Markdown 渲染层无复制入口），
 * 不造条目，缺口登记于本批报告。
 */
import React from 'react';
import { ContextMenu, ContextMenuItem } from '../ui/ContextMenu';
import { AppIcon } from '@/components/ui/icons';

export interface MessageContextMenuProps {
  x: number;
  y: number;
  anchorEl: HTMLElement | null;
  copyLabel: string;
  pinLabel: string;
  isPinned: boolean;
  onClose: () => void;
  onCopy: () => void;
  onTogglePin: () => void;
}

export const MessageContextMenu: React.FC<MessageContextMenuProps> = ({
  x,
  y,
  anchorEl,
  copyLabel,
  pinLabel,
  isPinned,
  onClose,
  onCopy,
  onTogglePin,
}) => {
  return (
    <ContextMenu
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      anchor={{ x, y }}
      anchorElement={anchorEl}
      data-testid="message-context-menu"
    >
      <ContextMenuItem
        icon={<AppIcon name="copy" size={16} aria-hidden />}
        onSelect={onCopy}
      >
        {copyLabel}
      </ContextMenuItem>
      <ContextMenuItem
        icon={
          <AppIcon name={isPinned ? 'pin-off' : 'pin'} size={16} aria-hidden />
        }
        onSelect={onTogglePin}
      >
        {pinLabel}
      </ContextMenuItem>
    </ContextMenu>
  );
};
