import React from 'react';
import type { CatalogEntry, InstalledExtension } from '../../api/extensionCatalog';
import { ExtensionCard } from './ExtensionCard';
import type { ExpandMode, ExpandTarget, KindFilter, MainView, ManageKind } from './types';

export type ExtensionListProps = {
  view: MainView;
  loading: boolean;
  query: string;
  kindFilter: KindFilter;
  installedFiltered: InstalledExtension[];
  catalogFiltered: CatalogEntry[];
  catalogInstalled: Set<string>;
  installed: InstalledExtension[];
  busyId: string | null;
  mcpServerBusy: boolean;
  mcpToolBusy: boolean;
  expandedMcpTools: Set<string>;
  toolTick: number;
  highlightMatch: (text: string) => React.ReactNode;
  toggleExpand: (scope: 'installed' | 'catalog', id: string, mode: ExpandMode) => void;
  isExpanded: (scope: 'installed' | 'catalog', id: string, mode?: ExpandMode) => boolean;
  onInstallCatalog: (entry: CatalogEntry) => void;
  onRemovePackage: (item: InstalledExtension) => void;
  onToggleMcpServer: (serverId: string, start: boolean) => void;
  onToggleMcpTool: (serverId: string, tool: string, enabled: boolean) => void;
  onToggleExpandMcpTools: (id: string) => void;
  onSetManage: (kind: ManageKind) => void;
  onSetView: (view: MainView) => void;
  onSetExpand: (expand: ExpandTarget | null) => void;
};

export const ExtensionList: React.FC<ExtensionListProps> = ({
  view,
  loading,
  query,
  kindFilter,
  installedFiltered,
  catalogFiltered,
  catalogInstalled,
  installed,
  busyId,
  mcpServerBusy,
  mcpToolBusy,
  expandedMcpTools,
  toolTick,
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
}) => {
  if (view === 'installed') {
    return (
      <div
        className="ext-list ext-list--cards"
        role="list"
        aria-label="已安装"
      >
        {loading && installedFiltered.length === 0 ? (
          <div className="ext-empty" role="status">
            加载中…
          </div>
        ) : installedFiltered.length === 0 ? (
          <div className="ext-empty" role="status">
            {query || kindFilter !== 'all'
              ? '没有匹配的扩展'
              : '还没有安装扩展'}
            {!(query || kindFilter !== 'all') ? (
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
                onClick={() => onSetView('discover')}
              >
                去发现
              </button>
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
                scope="installed"
                item={item}
                canUninstall={canUninstall}
                detailOpen={detailOpen}
                configOpen={configOpen}
                busyId={busyId}
                mcpServerBusy={mcpServerBusy}
                mcpToolBusy={mcpToolBusy}
                expandedMcpTools={expandedMcpTools}
                toolTick={toolTick}
                highlightMatch={highlightMatch}
                toggleExpand={toggleExpand}
                onRemovePackage={onRemovePackage}
                onToggleMcpServer={onToggleMcpServer}
                onToggleMcpTool={onToggleMcpTool}
                onToggleExpandMcpTools={onToggleExpandMcpTools}
                onSetManage={onSetManage}
              />
            );
          })
        )}
      </div>
    );
  }

  return (
    <div className="ext-list ext-list--cards" role="list" aria-label="发现">
      {catalogFiltered.length === 0 ? (
        <div className="ext-empty" role="status">
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
              scope="catalog"
              item={entry}
              installedMark={installedMark}
              detailOpen={detailOpen}
              busyId={busyId}
              mcpServerBusy={mcpServerBusy}
              mcpToolBusy={mcpToolBusy}
              expandedMcpTools={expandedMcpTools}
              toolTick={toolTick}
              highlightMatch={highlightMatch}
              toggleExpand={toggleExpand}
              onInstallCatalog={onInstallCatalog}
              onGoToConfig={(entryId) => {
                onSetView('installed');
                onSetExpand({
                  scope: 'installed',
                  id: entryId,
                  mode: 'config',
                });
              }}
            />
          );
        })
      )}
    </div>
  );
};
