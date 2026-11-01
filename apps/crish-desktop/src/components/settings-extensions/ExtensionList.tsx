import React from 'react';
import type {
  CatalogEntry,
  InstalledExtension,
} from '../../api/extensionCatalog';
import { ExtensionCard } from './ExtensionCard';
import { Button } from '@/components/ui';
import { SettingsEmpty } from '../settings/SettingsUI';
import { useI18n } from '../../i18n';
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
  const { t } = useI18n();
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
  const filtering = Boolean(query) || kindFilter !== 'all';
  if (view === 'installed') {
    return (
      <div
        className={styles.list}
        role="list"
        aria-label={t('settings.extensions.listInstalledAria', '已安装')}
      >
        {loading && installedFiltered.length === 0 ? (
          <div className={styles.empty} role="status">
            {t('settings.extensions.loading', '加载中…')}
          </div>
        ) : installedFiltered.length === 0 ? (
          filtering ? (
            <SettingsEmpty
              title={t('settings.extensions.noMatch', '没有匹配的扩展')}
            />
          ) : (
            <div className={styles.empty} role="status">
              {t('settings.extensions.noneInstalled', '还没有安装扩展')}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onSetView('discover')}
              >
                {t('settings.extensions.goDiscover', '去发现')}
              </Button>
            </div>
          )
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
    <div
      className={styles.list}
      role="list"
      aria-label={t('settings.extensions.listDiscoverAria', '发现')}
    >
      {catalogFiltered.length === 0 ? (
        <SettingsEmpty
          title={t('settings.extensions.noMatch', '没有匹配的扩展')}
        />
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
