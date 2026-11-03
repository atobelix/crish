/**
 * components/files/FileTreeContextMenu.tsx
 *
 * 文件树行右键菜单（全应用统一上下文菜单基座 ui/ContextMenu 之上）。
 * 只放已有真能力的条目，能力出处：
 * - 打开：FilesCard.handleFileSelect（文件→预览打开；目录→展开/折叠切换）
 * - 在资源管理器中显示：api/workspaceFsApi.revealInOs（FileActions 同一入口）
 * - 用系统默认打开 / 用 X 打开：api/hostOpenersApi.openPathDefault /
 *   openWithHostOpener（fileOpeners 由 useFilePreview 经 listHostOpeners 装配）
 * - 复制相对/绝对路径：FilesCard 的 path 定向 copyPath（preview.copyPath + toast）
 * 重命名/删除：仓库内无 workspace 文件重命名/删除命令（commandManifest 仅有
 * 设备与笔记文档重命名），不放条目，缺口登记于本批报告。
 */
import React from 'react';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '../ui/ContextMenu';
import { AppIcon } from '@/components/ui/icons';
import { revealInOs } from '../../api/workspaceFsApi';
import {
  openPathDefault,
  openWithHostOpener,
  type HostOpener,
} from '../../api/hostOpenersApi';
import { logInternalError } from '../../api/userFacingErrors';
import { t } from '../../i18n';
import { getOpenerIcon } from './FileActions';
import type { TreeNode } from './hooks/useFileNavigation';

export interface FileTreeContextMenuProps {
  node: TreeNode;
  x: number;
  y: number;
  anchorEl: HTMLElement | null;
  isExpanded: boolean;
  fileOpeners: HostOpener[];
  onClose: () => void;
  /** 打开语义与行点击一致：文件→预览；目录→展开/折叠 */
  onOpen: (path: string, isDir: boolean) => void;
  onCopyPath?: (path: string, mode: 'abs' | 'rel') => void;
}

export const FileTreeContextMenu: React.FC<FileTreeContextMenuProps> = ({
  node,
  x,
  y,
  anchorEl,
  isExpanded,
  fileOpeners,
  onClose,
  onOpen,
  onCopyPath,
}) => {
  const handleReveal = () => {
    void revealInOs(node.path).catch((e) =>
      logInternalError('components/files/FileTreeContextMenu/revealInOs', e)
    );
  };

  const handleOpenDefault = () => {
    void openPathDefault(node.path).catch((e) =>
      logInternalError('components/files/FileTreeContextMenu/openDefault', e)
    );
  };

  const handleOpenWith = (op: HostOpener) => {
    void openWithHostOpener(op.id, node.path).catch((e) =>
      logInternalError('components/files/FileTreeContextMenu/openWith', e)
    );
  };

  return (
    <ContextMenu
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      anchor={{ x, y }}
      anchorElement={anchorEl}
      aria-label={t('workspace.fileTree.menuLabel', '文件操作')}
      data-testid="file-tree-context-menu"
    >
      {node.isDir ? (
        <ContextMenuItem
          icon={
            <AppIcon
              name={isExpanded ? 'chevron-down' : 'chevron-right'}
              size={16}
              aria-hidden
            />
          }
          onSelect={() => onOpen(node.path, true)}
        >
          {isExpanded
            ? t('workspace.fileTree.collapse', '折叠')
            : t('workspace.fileTree.expand', '展开')}
        </ContextMenuItem>
      ) : (
        <ContextMenuItem
          icon={<AppIcon name="eye" size={16} aria-hidden />}
          onSelect={() => onOpen(node.path, false)}
        >
          {t('workspace.fileTree.open', '打开')}
        </ContextMenuItem>
      )}
      {!node.isDir && (
        <ContextMenuItem
          icon={<AppIcon name="external-link" size={16} aria-hidden />}
          onSelect={handleOpenDefault}
        >
          {t('workspace.fileTree.openDefault', '用系统默认打开')}
        </ContextMenuItem>
      )}
      {!node.isDir && fileOpeners.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger
            icon={<AppIcon name="app-window" size={16} aria-hidden />}
          >
            {t('workspace.fileTree.openWith', '打开方式')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {fileOpeners.map((op) => (
              <ContextMenuItem
                key={op.id}
                icon={getOpenerIcon(op, 16)}
                onSelect={() => handleOpenWith(op)}
              >
                {t('workspace.fileTree.openWithApp', '用 {name} 打开', {
                  name: op.displayName,
                })}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuItem
        icon={<AppIcon name="folder-open" size={16} aria-hidden />}
        onSelect={handleReveal}
      >
        {t('workspace.fileTree.reveal', '在资源管理器中显示')}
      </ContextMenuItem>
      {onCopyPath && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<AppIcon name="copy" size={16} aria-hidden />}
            onSelect={() => onCopyPath(node.path, 'rel')}
          >
            {t('workspace.fileTree.copyRelativePath', '复制相对路径')}
          </ContextMenuItem>
          <ContextMenuItem
            icon={<AppIcon name="file-code" size={16} aria-hidden />}
            onSelect={() => onCopyPath(node.path, 'abs')}
          >
            {t('workspace.fileTree.copyAbsolutePath', '复制绝对路径')}
          </ContextMenuItem>
        </>
      )}
    </ContextMenu>
  );
};
