import React from 'react';
import { Button, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import type { UnifiedExtensionItem } from './buildUnifiedItems';
import styles from './ExtensionsMainSurface.module.css';

export interface ExtensionsSidebarProps {
  sidebarNav: 'explore' | 'featured' | 'import' | 'installed';
  onSelectNav: (nav: 'explore' | 'featured' | 'import' | 'installed') => void;
  installedItems: UnifiedExtensionItem[];
  selectedInstalledId: string | null;
}

export const ExtensionsSidebar: React.FC<ExtensionsSidebarProps> = ({
  sidebarNav,
  onSelectNav,
  installedItems,
  selectedInstalledId,
}) => {
  const selectedItem = selectedInstalledId
    ? installedItems.find((it) => it.id === selectedInstalledId) || null
    : null;

  return (
    <div
      className={styles.functionRow}
      role="navigation"
      aria-label="扩展功能导航"
    >
      <div className={styles.functionNavGroup}>
        <Button
          bare
          type="button"
          className={`${styles.functionNavItem} ${sidebarNav === 'explore' && !selectedInstalledId ? styles.activeFunctionNavItem : ''}`}
          onClick={() => onSelectNav('explore')}
        >
          <span className={styles.sidebarNavIcon}>
            <AppIcon name="compass" size={14} />
          </span>
          <span>发现</span>
        </Button>

        <Button
          bare
          type="button"
          className={`${styles.functionNavItem} ${sidebarNav === 'featured' && !selectedInstalledId ? styles.activeFunctionNavItem : ''}`}
          onClick={() => onSelectNav('featured')}
        >
          <span className={styles.sidebarNavIcon}>
            <AppIcon name="sparkles" size={14} />
          </span>
          <span>精选</span>
        </Button>

        <Button
          bare
          type="button"
          className={`${styles.functionNavItem} ${sidebarNav === 'import' && !selectedInstalledId ? styles.activeFunctionNavItem : ''}`}
          onClick={() => onSelectNav('import')}
        >
          <span className={styles.sidebarNavIcon}>
            <AppIcon name="folder-input" size={14} />
          </span>
          <span>导入</span>
        </Button>

        <Button
          bare
          type="button"
          className={`${styles.functionNavItem} ${sidebarNav === 'installed' && !selectedInstalledId ? styles.activeFunctionNavItem : ''}`}
          onClick={() => onSelectNav('installed')}
        >
          <span className={styles.sidebarNavIcon}>
            <AppIcon name="check-circle" size={14} />
          </span>
          <span>已安装 ({installedItems.length})</span>
        </Button>
      </div>

      {selectedItem && (
        <div className={styles.functionRowRight}>
          <span className={styles.activeWorkbenchCrumb}>
            <AppIcon name={selectedItem.icon} size={13} />
            <span>{selectedItem.name}</span>
          </span>
          <Tooltip content="返回卡片列表">
            <Button
              bare
              type="button"
              className={styles.backToListBtn}
              onClick={() => onSelectNav('installed')}
              aria-label="返回卡片列表"
            >
              <AppIcon name="arrow-left" size={14} />
              <span>返回</span>
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
};
