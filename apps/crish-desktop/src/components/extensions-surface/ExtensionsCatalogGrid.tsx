import React from 'react';
import { AppIcon } from '@/components/ui/icons';
import type {
  CatalogEntry,
  InstalledExtension,
} from '../../api/extensionCatalog';
import type { UnifiedExtensionItem } from './buildUnifiedItems';
import { ExtensionActionCard } from './ExtensionActionCard';
import styles from './ExtensionsMainSurface.module.css';

export interface ExtensionsCatalogGridProps {
  catalogItems: UnifiedExtensionItem[];
  sidebarNav: 'explore' | 'featured' | 'installed';
  categoryFilter: 'plugins' | 'skills' | 'mcp';
  searchQuery: string;
  busyId: string | null;
  onSelectDetail: (item: CatalogEntry | InstalledExtension) => void;
  onSelectInstalled?: (item: UnifiedExtensionItem) => void;
  onInstall: (item: UnifiedExtensionItem) => void;
  onUninstall: (item: UnifiedExtensionItem) => void;
}

export const ExtensionsCatalogGrid: React.FC<ExtensionsCatalogGridProps> = ({
  catalogItems,
  sidebarNav,
  categoryFilter: _categoryFilter,
  searchQuery,
  busyId,
  onSelectDetail,
  onSelectInstalled,
  onInstall,
  onUninstall,
}) => {
  return (
    <div className={styles.catalogGridContainer}>
      {catalogItems.length === 0 ? (
        <div className={styles.emptyWorkbenchState}>
          <AppIcon name="package" size={26} />
          <div className={styles.emptyDesc}>
            {searchQuery
              ? '未找到匹配搜索条件的扩展'
              : sidebarNav === 'installed'
                ? '当前分类下暂无已安装条目'
                : '当前分类下暂无发现条目'}
          </div>
        </div>
      ) : (
        <div className={styles.cardsGrid}>
          {catalogItems.map((item) => {
            const isInstalled = Boolean(item.isInstalled);
            const badge = item.isOfficial
              ? '官方'
              : item.source &&
                  !['community', 'local', 'official'].includes(item.source)
                ? item.source
                : item.source === 'local' || item.scope === 'installed'
                  ? '本地'
                  : '精选';
            return (
              <ExtensionActionCard
                key={item.id}
                name={item.name}
                description={item.description}
                badge={badge}
                icon={item.icon}
                placement={
                  item.id.startsWith('custom-plugin:') ? 'custom' : 'catalog'
                }
                installed={isInstalled}
                busy={busyId === item.id}
                onOpen={() => {
                  if (isInstalled && onSelectInstalled) {
                    onSelectInstalled(item);
                  } else {
                    onSelectDetail(item.nativeItem);
                  }
                }}
                onAction={() => {
                  if (isInstalled) onUninstall(item);
                  else onInstall(item);
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};
