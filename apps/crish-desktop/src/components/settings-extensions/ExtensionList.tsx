import React from 'react';
import type {
  CatalogEntry,
  InstalledExtension,
} from '../../api/extensionCatalog';
import { ExtensionCard } from './ExtensionCard';
import { Button } from '../ui';
import type {
  ExpandMode,
  ExpandTarget,
  KindFilter,
  MainView,
  ManageKind,
} from './types';
import styles from './SettingsExtensionsTab.module.css';

/** 扩展数据域 */
export interface ExtensionsGroup {
  view: MainView;
  loading: boolean;
  installedFiltered: InstalledExtension[];
  catalogFiltered: CatalogEntry[];
  catalogInstalled: Set<string>;
  installed: InstalledExtension[];
  busyId: string | null;
  mcpServerBusy: boolean;
  mcpToolBusy: boolean;
  expandedMcpTools: Set<string>;
  toolTick: number;
}

/** 筛选域 */
export interface FiltersGroup {
  query: string;
  kindFilter: KindFilter;
}

/** 操作回调域 */
export interface ActionsGroup {
  highlightMatch: (text: string) => React.ReactNode;
  toggleExpand: (
    scope: 'installed' | 'catalog',
    id: string,
    mode: ExpandMode
  ) => void;
  isExpanded: (
    scope: 'installed' | 'catalog',
    id: string,
    mode?: ExpandMode
  ) => boolean;
  onInstallCatalog: (entry: CatalogEntry) => void;
  onRemovePackage: (item: InstalledExtension) => void;
  onToggleMcpServer: (serverId: string, start: boolean) => void;
  onToggleMcpTool: (serverId: string, tool: string, enabled: boolean) => void;
  onToggleExpandMcpTools: (id: string) => void;
  onSetManage: (kind: ManageKind) => void;
  onSetView: (view: MainView) => void;
  onSetExpand: (expand: ExpandTarget | null) => void;
  /** 插件启停（E3 UI 泛化）。 */
  onTogglePlugin: (pluginId: string, enabled: boolean) => void;
  onSelect?: (item: InstalledExtension | CatalogEntry) => void;
  onManage?: (item: InstalledExtension) => void;
}

export type ExtensionListProps = {
  extensions: ExtensionsGroup;
  filters: FiltersGroup;
  actions: ActionsGroup;
};

export const ExtensionList: React.FC<ExtensionListProps> = ({
  extensions: ext,
  filters: flt,
  actions: ac,
}) => {
  const {
    view,
    loading,
    installedFiltered,
    catalogFiltered,
    catalogInstalled,
    installed,
    busyId,
    mcpServerBusy,
    mcpToolBusy,
    expandedMcpTools,
    toolTick,
  } = ext;
  const { query, kindFilter } = flt;
  const {
    highlightMatch,
    toggleExpand,
    isExpanded,
    onInstallCatalog,
    onRemovePackage,
    onToggleMcpServer,
    onToggleMcpTool,
    onToggleExpandMcpTools,
    onSetManage,
    onSetView,
    onSetExpand,
    onTogglePlugin,
    onSelect,
    onManage,
  } = ac;
  if (view === 'installed') {
    return (
      <div className={styles.list} role="list" aria-label="已安装">
        {loading && installedFiltered.length === 0 ? (
          <div className={styles.empty} role="status">
            加载中…
          </div>
        ) : installedFiltered.length === 0 ? (
          <div className={styles.empty} role="status">
            {query || kindFilter !== 'all'
              ? '没有匹配的扩展'
              : '还没有安装扩展'}
            {!(query || kindFilter !== 'all') ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onSetView('discover')}
              >
                去发现
              </Button>
            ) : null}
          </div>
        ) : (
          installedFiltered.map((item) => {
            const canUninstall =
              item.id.startsWith('local-plugin:') || !item.fromSystem;
            const detailOpen = isExpanded('installed', item.id, 'detail');
            const configOpen = isExpanded('installed', item.id, 'config');
            return (
              <ExtensionCard
                key={item.id}
                extension={{
                  scope: 'installed',
                  item,
                  canUninstall,
                  detailOpen,
                  configOpen,
                  busyId,
                }}
                mcp={{
                  expandedMcpTools,
                  toolTick,
                  mcpServerBusy,
                  mcpToolBusy,
                }}
                actions={{
                  highlightMatch,
                  toggleExpand,
                  onRemovePackage,
                  onToggleMcpServer,
                  onToggleMcpTool,
                  onToggleExpandMcpTools,
                  onSetManage,
                  onTogglePlugin,
                  onSelect,
                  onManage,
                }}
              />
            );
          })
        )}
      </div>
    );
  }

  return (
    <div className={styles.list} role="list" aria-label="发现">
      {catalogFiltered.length === 0 ? (
        <div className={styles.empty} role="status">
          没有匹配的扩展
        </div>
      ) : (
        catalogFiltered.map((entry) => {
          const installedMark =
            catalogInstalled.has(entry.id) ||
            installed.some(
              (i) =>
                i.kind === entry.kind &&
                i.name.toLowerCase() === entry.name.toLowerCase()
            );
          const detailOpen = isExpanded('catalog', entry.id, 'detail');
          return (
            <ExtensionCard
              key={entry.id}
              extension={{
                scope: 'catalog',
                item: entry,
                installedMark,
                detailOpen,
                busyId,
              }}
              mcp={{
                expandedMcpTools,
                toolTick,
                mcpServerBusy,
                mcpToolBusy,
              }}
              actions={{
                highlightMatch,
                toggleExpand,
                onInstallCatalog,
                onGoToConfig: (entryId) => {
                  onSetView('installed');
                  onSetExpand({
                    scope: 'installed',
                    id: entryId,
                    mode: 'config',
                  });
                },
                onSelect,
              }}
            />
          );
        })
      )}
    </div>
  );
};
