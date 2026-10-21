import React from 'react';
import { AppIcon } from '../ui/icons';
import type {
  CatalogEntry,
  InstalledExtension,
} from '../../api/extensionCatalog';
import type { UnifiedExtensionItem } from './buildUnifiedItems';
import { ExtensionActionCard } from './ExtensionActionCard';
import styles from './ExtensionsMainSurface.module.css';

export interface ExtensionsCatalogGridProps {
  catalogItems: UnifiedExtensionItem[];
  sidebarNav: 'explore' | 'featured';
  categoryFilter: 'plugins' | 'skills' | 'mcp';
  searchQuery: string;
  busyId: string | null;
  onSelectDetail: (item: CatalogEntry | InstalledExtension) => void;
  onInstall: (item: UnifiedExtensionItem) => void;
  onUninstall: (item: UnifiedExtensionItem) => void;
}

export const ExtensionsCatalogGrid: React.FC<ExtensionsCatalogGridProps> = ({
  catalogItems,
  sidebarNav,
  categoryFilter,
  searchQuery,
  busyId,
  onSelectDetail,
  onInstall,
  onUninstall,
}) => {
  return (
    <div className={styles.catalogGridContainer}>
      <div className={styles.catalogGridHeader}>
        <div>
          <div className={styles.catalogGridTitle}>
            {sidebarNav === 'featured' ? '精选推荐' : '发现生态'}
          </div>
          <div className={styles.catalogGridDesc}>
            {categoryFilter === 'plugins'
              ? '浏览并一键配置社区与官方扩展插件'
              : categoryFilter === 'skills'
                ? '发现预设提示词工作流与专业技能包'
                : '连接外部工具与 Model Context Protocol 服务'}
          </div>
        </div>
      </div>

      {catalogItems.length === 0 ? (
        <div className={styles.emptyWorkbenchState}>
          <AppIcon name="package" size={26} />
          <div className={styles.emptyTitle}>暂无相关扩展</div>
          <div className={styles.emptyDesc}>
            {searchQuery
              ? '未找到匹配搜索条件的扩展'
              : '当前分类下暂无发现条目'}
          </div>
        </div>
      ) : (
        <div className={styles.cardsGrid}>
          {catalogItems.map((item) => {
            const isInstalled = Boolean(item.isInstalled);
            return (
              <ExtensionActionCard
                key={item.id}
                name={item.name}
                description={item.description}
                badge={item.isOfficial ? '官方' : '精选'}
                icon={item.icon}
                placement="catalog"
                installed={isInstalled}
                busy={busyId === item.id}
                onOpen={() => onSelectDetail(item.nativeItem)}
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
