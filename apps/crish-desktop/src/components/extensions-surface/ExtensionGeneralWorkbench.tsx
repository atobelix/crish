import React from 'react';
import { Button, Switch, Tooltip } from '@/components/ui';
import { AppIcon, type IconName } from '@/components/ui/icons';
import { useToast } from '../../services/toast/ToastContext';
import styles from './ExtensionsMainSurface.module.css';

export interface GeneralExtensionItem {
  id: string;
  kind: 'plugin' | 'skill' | 'mcp';
  name: string;
  description: string;
  icon: IconName;
  isOfficial?: boolean;
  isEnabled: boolean;
  installRef?: string;
  tools?: string[];
  version?: string;
  tags?: readonly string[];
}

interface ExtensionGeneralWorkbenchProps {
  item: GeneralExtensionItem;
  onToggleEnabled?: (item: GeneralExtensionItem) => void;
  onSharePlugin?: () => void;
}

export const ExtensionGeneralWorkbench: React.FC<
  ExtensionGeneralWorkbenchProps
> = ({ item, onToggleEnabled, onSharePlugin }) => {
  const { showToast } = useToast();

  const handleCopyInstallRef = () => {
    if (!item.installRef) return;
    navigator.clipboard.writeText(item.installRef);
    showToast(`已复制引用命令: ${item.installRef}`);
  };

  return (
    <div className={styles.workbenchContent}>
      <div className={styles.skillUnifiedHeader}>
        <div className={styles.skillHeaderMain}>
          <div className={styles.skillHeaderIconBox}>
            <AppIcon name={item.icon} size={18} />
          </div>
          <div className={styles.detailTitleInfo}>
            <div className={styles.skillHeaderTitleLine}>
              <span className={styles.detailTitle}>{item.name}</span>
              <span className={styles.metaPill}>
                {item.isOfficial ? '官方扩展' : '社区生态'}
              </span>
              {item.version && (
                <span className={styles.metaPill}>v{item.version}</span>
              )}
              {item.installRef && (
                <Tooltip content="复制引用命令">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyInstallRef}
                    className={styles.copyCmdBtn}
                  >
                    <AppIcon name="copy" size={12} />
                    <span>复制引用</span>
                  </Button>
                </Tooltip>
              )}
            </div>
            {item.description ? (
              <div className={styles.detailSubtitle}>{item.description}</div>
            ) : null}
          </div>
        </div>
        <div className={styles.headerActions}>
          {onSharePlugin && (
            <Tooltip content="导出或复制插件配置">
              <Button
                variant="secondary"
                size="sm"
                className={styles.headerActionBtn}
                onClick={onSharePlugin}
              >
                <AppIcon name="upload" size={13} />
                <span>分享插件</span>
              </Button>
            </Tooltip>
          )}
          {onToggleEnabled && (
            <Tooltip
              content={
                item.isEnabled ? '已启用（点击停用）' : '已停用（点击启用）'
              }
            >
              <div className={styles.switchSlot}>
                <Switch
                  checked={item.isEnabled}
                  onCheckedChange={() => onToggleEnabled(item)}
                  aria-label={`切换 ${item.name} 启用状态`}
                />
              </div>
            </Tooltip>
          )}
        </div>
      </div>

      {/* 导出的工具或特性清单 */}
      {item.tools && item.tools.length > 0 && (
        <div className={styles.detailBodySection}>
          <div className={styles.sectionHeader}>
            <AppIcon name="wrench" size={15} />
            <span>包含的工具与能力 ({item.tools.length})</span>
          </div>
          <div className={styles.toolsListGrid}>
            {item.tools.map((tool, idx) => (
              <div key={idx} className={styles.toolItemCard}>
                <div className={styles.toolItemHeader}>
                  <AppIcon
                    name="wrench"
                    size={13}
                    className={styles.toolIcon}
                  />
                  <span className={styles.toolName}>{tool}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 引用与配置信息 */}
      {item.installRef && (
        <div className={styles.detailBodySection}>
          <div className={styles.sectionHeader}>
            <AppIcon name="terminal" size={15} />
            <span>模块源与包信息</span>
          </div>
          <div className={styles.codePreviewCard}>
            <pre className={styles.codeBlock}>{item.installRef}</pre>
          </div>
        </div>
      )}
    </div>
  );
};
