import React from 'react';
import { Button, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons';
import type {
  CatalogEntry,
  InstalledExtension,
} from '../../api/extensionCatalog';
import type { UnifiedExtensionItem } from './buildUnifiedItems';
import styles from './ExtensionsMainSurface.module.css';

export interface ExtensionsCatalogGridProps {
  catalogItems: UnifiedExtensionItem[];
  sidebarNav: 'explore' | 'featured';
  categoryFilter: 'plugins' | 'skills' | 'mcp';
  searchQuery: string;
  busyId: string | null;
  onSelectDetail: (item: CatalogEntry | InstalledExtension) => void;
  onInstall: (item: UnifiedExtensionItem) => void;
}

export const ExtensionsCatalogGrid: React.FC<ExtensionsCatalogGridProps> = ({
  catalogItems,
  sidebarNav,
  categoryFilter,
  searchQuery,
  busyId,
  onSelectDetail,
  onInstall,
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
          {catalogItems.map((item) => (
            <div
              key={item.id}
              className={styles.compactExtCard}
              onClick={() => onSelectDetail(item.nativeItem)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectDetail(item.nativeItem);
                }
              }}
            >
              <div className={styles.cardHeaderRow}>
                <div className={styles.cardHeaderLeft}>
                  <div className={styles.compactCardIcon}>
                    <AppIcon name={item.icon} size={15} />
                  </div>
                  <span className={styles.compactCardName}>{item.name}</span>
                </div>
                <div
                  className={styles.cardHeaderRight}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Tooltip content="安装">
                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.iconActionBtn}
                      disabled={busyId === item.id}
                      onClick={() => onInstall(item)}
                      aria-label={`安装 ${item.name}`}
                    >
                      <AppIcon
                        name={busyId === item.id ? 'refresh' : 'download'}
                        size={14}
                        className={busyId === item.id ? styles.spinning : ''}
                      />
                    </Button>
                  </Tooltip>
                </div>
              </div>
              <Tooltip content={item.description}>
                <div className={styles.cardDescRow}>{item.description}</div>
              </Tooltip>
              <div className={styles.cardFooterRow}>
                <span className={styles.cardBadge}>
                  {item.isOfficial ? '官方' : '精选'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
