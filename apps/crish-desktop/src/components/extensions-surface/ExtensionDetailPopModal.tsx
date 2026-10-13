import React from 'react';
import { Dialog } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { ExternalSessionsWorkbench } from './ExternalSessionsWorkbench';
import { SkillDetailWorkbench } from './SkillDetailWorkbench';
import { McpDetailWorkbench } from './McpDetailWorkbench';
import {
  ExtensionGeneralWorkbench,
  type GeneralExtensionItem,
} from './ExtensionGeneralWorkbench';
import { isImportClaudeCodexPlugin } from './extensionIdentity';
import type { DesktopSkill } from '../../api/skillsApi';
import type { McpServerInfo } from '../../api/mcpApi';
import type { UnifiedExtensionItem } from './ExtensionsMainSurface';
import styles from './ExtensionsMainSurface.module.css';

export interface ExtensionDetailPopModalProps {
  open: boolean;
  onClose: () => void;
  item: UnifiedExtensionItem | null;
  onToggleSkill?: (skill: DesktopSkill) => void | Promise<void>;
  onToggleMcp?: (server: McpServerInfo) => void | Promise<void>;
  onToggleGeneral?: (item: GeneralExtensionItem) => void;
  onBackToChat?: () => void;
}

/**
 * ExtensionDetailPopModal 宽幅详情 Pop 界面
 * 点击两行紧凑卡片后弹出，全屏模态展示扩展功能工作台与详细配置
 */
export const ExtensionDetailPopModal: React.FC<
  ExtensionDetailPopModalProps
> = ({
  open,
  onClose,
  item,
  onToggleSkill,
  onToggleMcp,
  onToggleGeneral,
  onBackToChat,
}) => {
  if (!item) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel={`${item.name} 详情`}
      role="dialog"
      showCloseButton={true}
      classNames={{
        panel: styles.popModalPanel,
        body: styles.popModalBody,
      }}
      title={
        <div className={styles.popModalHeaderTitle}>
          <AppIcon
            name={item.icon}
            size={16}
            className={styles.popModalHeaderIcon}
          />
          <span className={styles.popModalHeaderName}>{item.name}</span>
          <span
            className={
              item.isOfficial
                ? styles.sourceBadgeOfficial
                : styles.sourceBadgeCommunity
            }
          >
            {item.isOfficial ? '官方' : '社区'}
          </span>
        </div>
      }
    >
      <div className={styles.popModalContent}>
        {isImportClaudeCodexPlugin(item) ? (
          <ExternalSessionsWorkbench
            onBackToChat={() => {
              onClose();
              onBackToChat?.();
            }}
          />
        ) : item.kind === 'skill' && item.rawSkill ? (
          <SkillDetailWorkbench
            skill={item.rawSkill}
            onToggleActivation={onToggleSkill}
          />
        ) : item.kind === 'mcp' && item.rawMcp ? (
          <McpDetailWorkbench
            server={item.rawMcp}
            onToggleServer={onToggleMcp}
          />
        ) : (
          <ExtensionGeneralWorkbench
            item={item as GeneralExtensionItem}
            onToggleEnabled={onToggleGeneral}
          />
        )}
      </div>
    </Dialog>
  );
};
