import React from 'react';
import { Switch, Button, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons';
import type { UnifiedExtensionItem } from './buildUnifiedItems';
import styles from './ExtensionsMainSurface.module.css';

export interface ExtensionsSidebarProps {
  sidebarNav: 'explore' | 'featured' | 'import' | 'installed';
  categoryFilter?: 'plugins' | 'skills' | 'mcp';
  onSelectNav: (nav: 'explore' | 'featured' | 'import') => void;
  installedItems: UnifiedExtensionItem[];
  selectedInstalledId: string | null;
  onSelectInstalled: (item: UnifiedExtensionItem) => void;
  onToggleItem: (item: UnifiedExtensionItem, checked: boolean) => void;
  onUninstallItem: (item: UnifiedExtensionItem) => void;
}

export const ExtensionsSidebar: React.FC<ExtensionsSidebarProps> = ({
  sidebarNav,
  onSelectNav,
  installedItems,
  selectedInstalledId,
  onSelectInstalled,
  onToggleItem,
  onUninstallItem,
}) => {
  return (
    <div className={styles.leftSidebar}>
      <div className={styles.sidebarNav}>
        <Button
          bare
          type="button"
          className={`${styles.sidebarNavItem} ${sidebarNav === 'explore' ? styles.activeSidebarNavItem : ''}`}
          onClick={() => onSelectNav('explore')}
        >
          <div className={styles.sidebarNavIcon}>
            <AppIcon name="compass" size={15} />
          </div>
          <span>发现</span>
        </Button>
        <Button
          bare
          type="button"
          className={`${styles.sidebarNavItem} ${sidebarNav === 'featured' ? styles.activeSidebarNavItem : ''}`}
          onClick={() => onSelectNav('featured')}
        >
          <div className={styles.sidebarNavIcon}>
            <AppIcon name="sparkles" size={15} />
          </div>
          <span>精选</span>
        </Button>
        <Button
          bare
          type="button"
          className={`${styles.sidebarNavItem} ${sidebarNav === 'import' ? styles.activeSidebarNavItem : ''}`}
          onClick={() => onSelectNav('import')}
        >
          <div className={styles.sidebarNavIcon}>
            <AppIcon name="folder-input" size={15} />
          </div>
          <span>导入</span>
        </Button>
      </div>

      <div className={styles.sidebarSectionTitle}>
        已安装 ({installedItems.length})
      </div>

      <div className={styles.installedList}>
        {installedItems.length === 0 ? (
          <div className={styles.emptyInstalledHint}>暂无已安装条目</div>
        ) : (
          installedItems.map((item) => (
            <div
              key={item.id}
              className={`${styles.installedItemRow} ${sidebarNav === 'installed' && selectedInstalledId === item.id ? styles.activeInstalledItem : ''}`}
              onClick={() => onSelectInstalled(item)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectInstalled(item);
                }
              }}
            >
              <div className={styles.installedItemTop}>
                <div className={styles.installedItemLeft}>
                  <div className={styles.installedItemIcon}>
                    <AppIcon name={item.icon} size={14} />
                  </div>
                  <Tooltip content={item.name}>
                    <span className={styles.installedItemName}>
                      {item.name}
                    </span>
                  </Tooltip>
                </div>
                <div
                  className={styles.installedItemRight}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Switch
                    checked={item.isEnabled}
                    onCheckedChange={(checked) => onToggleItem(item, checked)}
                    aria-label={`切换 ${item.name}`}
                  />
                  <Tooltip
                    content={
                      item.id.startsWith('custom-plugin:') ? '删除' : '卸载'
                    }
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.iconActionBtn}
                      onClick={() => onUninstallItem(item)}
                      aria-label={`${item.id.startsWith('custom-plugin:') ? '删除' : '卸载'} ${item.name}`}
                    >
                      <AppIcon name="trash" size={12} />
                    </Button>
                  </Tooltip>
                </div>
              </div>
              <Tooltip content={item.description}>
                <div className={styles.installedItemDesc}>
                  {item.description}
                </div>
              </Tooltip>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
