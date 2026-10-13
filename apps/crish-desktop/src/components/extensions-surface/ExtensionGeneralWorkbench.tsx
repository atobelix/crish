import React from 'react';
import { Button, Switch } from '../ui';
import { AppIcon, type IconName } from '../ui/icons/index';
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
}

export const ExtensionGeneralWorkbench: React.FC<
  ExtensionGeneralWorkbenchProps
> = ({ item, onToggleEnabled }) => {
  const { showToast } = useToast();

  const handleCopyInstallRef = () => {
    if (!item.installRef) return;
    navigator.clipboard.writeText(item.installRef);
    showToast(`已复制引用命令: ${item.installRef}`);
  };

  const kindText =
    item.kind === 'plugin'
      ? '插件'
      : item.kind === 'skill'
        ? '技能'
        : 'MCP 服务';

  return (
    <div className={styles.workbenchContent}>
      {/* 头部标题与操作 */}
      <div className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          <div className={styles.detailTitleInfo}>
            <div className={styles.detailTitle}>{item.name}</div>
            <div className={styles.detailSubtitle}>
              {item.description || '功能扩展模块'}
            </div>
          </div>
          <div className={styles.headerActions}>
            <span
              className={`${styles.statusBadge} ${item.isEnabled ? styles.statusOnline : styles.statusOffline}`}
            >
              {item.isEnabled ? '已启用' : '未启用'}
            </span>
          </div>
        </div>

        {/* 状态与控制条（大圆角面板） */}
        <div className={styles.pluginSettingsRow}>
          <div className={styles.settingItem}>
            <div className={styles.settingLabelGroup}>
              <span className={styles.settingTitle}>启用扩展</span>
              <span className={styles.settingDesc}>
                {item.isEnabled
                  ? `${kindText}已就绪并在对应环境中生效`
                  : `${kindText}当前处于禁用状态`}
              </span>
            </div>
            {onToggleEnabled && (
              <Switch
                checked={item.isEnabled}
                onCheckedChange={() => onToggleEnabled(item)}
                aria-label={`切换 ${item.name} 启用状态`}
              />
            )}
          </div>
          <div className={styles.metaPillGroup}>
            <span className={styles.metaPill}>
              {item.isOfficial ? '官方扩展' : '社区生态'}
            </span>
            {item.version && (
              <span className={styles.metaPill}>v{item.version}</span>
            )}
            {item.installRef && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyInstallRef}
                className={styles.copyCmdBtn}
              >
                <AppIcon name="copy" size={12} />
                <span>复制引用</span>
              </Button>
            )}
          </div>
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
