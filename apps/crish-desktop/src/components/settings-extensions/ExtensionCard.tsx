import React from 'react';
import {
  kindLabel,
  type CatalogEntry,
  type ExtensionKind,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import type { ExpandMode, ManageKind } from './types';
import { Button } from '../ui';
import { McpToolsSection } from './McpToolsSection';
import { ExtensionBody } from './ExtensionBody';
import { isPluginCardItem } from './ExtensionCardIdentity';

/** 扩展卡身份与展示态（标识当前卡片属于哪一项、展开/配置/卸载可见性）。 */
export interface ExtensionCardExtensionProps {
  scope: 'installed' | 'catalog';
  item: InstalledExtension | CatalogEntry;
  installedMark?: boolean;
  canUninstall?: boolean;
  detailOpen: boolean;
  configOpen?: boolean;
  /** 全局安装/卸载 busy 标记（catalog 安装按钮、installed 卸载按钮共用）。 */
  busyId: string | null;
}

/** MCP 工具展示态（仅 mcp 类型分支消费）。 */
export interface ExtensionCardMcpProps {
  expandedMcpTools: Set<string>;
  toolTick: number;
  mcpServerBusy: boolean;
  mcpToolBusy: boolean;
}

/** 扩展卡回调集合（高亮、展开切换、安装/卸载、MCP 启停、插件启停、管理跳转）。 */
export interface ExtensionCardActionsProps {
  highlightMatch: (text: string) => React.ReactNode;
  toggleExpand: (scope: 'installed' | 'catalog', id: string, mode: ExpandMode) => void;
  onInstallCatalog?: (entry: CatalogEntry) => void;
  onRemovePackage?: (item: InstalledExtension) => void;
  onToggleMcpServer?: (serverId: string, start: boolean) => void;
  onToggleMcpTool?: (serverId: string, tool: string, enabled: boolean) => void;
  onToggleExpandMcpTools?: (id: string) => void;
  onSetManage?: (kind: ManageKind) => void;
  onGoToConfig?: (id: string) => void;
  /** 插件启停开关（E3 UI 泛化：kind: 'plugin' 分支）。 */
  onTogglePlugin?: (pluginId: string, enabled: boolean) => void;
}

/** Props 分组：extension（身份/展示态）+ mcp（MCP 工具态）+ actions（回调集合）。 */
export type ExtensionCardProps = {
  extension: ExtensionCardExtensionProps;
  mcp: ExtensionCardMcpProps;
  actions: ExtensionCardActionsProps;
};

/** 展开体分发：skill/plugin → ExtensionBody；mcp → McpToolsSection。 */
function renderExpandBody(
  kind: ExtensionKind,
  targetItem: InstalledExtension | CatalogEntry,
  mode: ExpandMode,
  mcp: ExtensionCardMcpProps,
  actions: ExtensionCardActionsProps,
) {
  if (kind === 'mcp') {
    return (
      <McpToolsSection
        item={targetItem}
        mode={mode}
        state={mcp}
        actions={{
          onToggleMcpServer: actions.onToggleMcpServer,
          onToggleMcpTool: actions.onToggleMcpTool,
          onToggleExpandMcpTools: actions.onToggleExpandMcpTools,
          onSetManage: actions.onSetManage,
        }}
      />
    );
  }
  return (
    <ExtensionBody
      item={targetItem}
      mode={mode}
      kind={kind === 'skill' ? 'skill' : 'plugin'}
      actions={{
        onSetManage: actions.onSetManage,
      }}
    />
  );
}

export const ExtensionCard: React.FC<ExtensionCardProps> = ({
  extension,
  mcp,
  actions,
}) => {
  const {
    scope,
    item,
    installedMark,
    canUninstall,
    detailOpen,
    configOpen = false,
    busyId,
  } = extension;
  const {
    highlightMatch,
    toggleExpand,
    onInstallCatalog,
    onRemovePackage,
    onSetManage,
    onGoToConfig,
    onTogglePlugin,
  } = actions;

  if (scope === 'installed') {
    const installedItem = item as InstalledExtension;
    const pluginCard = isPluginCardItem(installedItem) ? installedItem : null;
    return (
      <div
        className={`ext-row-block${
          detailOpen || configOpen ? ' is-expanded' : ''
        }`}
        role="listitem"
      >
        <div className="ext-row ext-row--card ext-row--static">
          <div className="ext-row-main">
            <div className="ext-row-title-line">
              <span className="ext-kind-badge">
                {kindLabel(installedItem.kind)}
              </span>
              <span className="ext-row-name">
                {highlightMatch(installedItem.name)}
              </span>
              <span className="ext-source-badge">
                {installedItem.source === 'official'
                  ? '官方'
                  : installedItem.source === 'community'
                    ? '三方'
                    : '本机'}
              </span>
            </div>
            <div className="ext-row-desc">
              {highlightMatch(installedItem.description)}
            </div>
          </div>
          <div className="ext-row-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="settings-btn-rect"
              aria-expanded={detailOpen}
              onClick={() => toggleExpand('installed', installedItem.id, 'detail')}
            >
              {detailOpen ? '收起' : '详情'}
            </Button>
            {pluginCard ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="settings-btn-rect"
                aria-pressed={pluginCard.pluginEnabled}
                onClick={() =>
                  onTogglePlugin?.(
                    pluginCard.pluginId!,
                    !pluginCard.pluginEnabled
                  )
                }
              >
                {pluginCard.pluginEnabled ? '停用' : '启用'}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="settings-btn-rect"
                aria-expanded={configOpen}
                onClick={() => toggleExpand('installed', installedItem.id, 'config')}
              >
                {configOpen ? '收起' : '配置'}
              </Button>
            )}
            {canUninstall ? (
              <Button
                type="button"
                variant="danger"
                size="sm"
                className="settings-btn-rect"
                onClick={() => void onRemovePackage?.(installedItem)}
              >
                卸载
              </Button>
            ) : null}
          </div>
        </div>
        {detailOpen ? renderExpandBody(installedItem.kind, installedItem, 'detail', mcp, actions) : null}
        {configOpen ? renderExpandBody(installedItem.kind, installedItem, 'config', mcp, actions) : null}
      </div>
    );
  }

  // catalog scope
  const entry = item as CatalogEntry;
  return (
    <div
      className={`ext-row-block${detailOpen ? ' is-expanded' : ''}`}
      role="listitem"
    >
      <div className="ext-row ext-row--card ext-row--static">
        <div className="ext-row-main">
          <div className="ext-row-title-line">
            <span className="ext-kind-badge">{kindLabel(entry.kind)}</span>
            <span className="ext-row-name">
              {highlightMatch(entry.name)}
            </span>
            <span className="ext-source-badge">
              {entry.source === 'official' ? '官方' : '三方'}
            </span>
            {installedMark ? (
              <span className="ext-installed-mark">已装</span>
            ) : null}
          </div>
          <div className="ext-row-desc">
            {highlightMatch(entry.description)}
          </div>
        </div>
        <div className="ext-row-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="settings-btn-rect"
            aria-expanded={detailOpen}
            onClick={() => toggleExpand('catalog', entry.id, 'detail')}
          >
            {detailOpen ? '收起' : '详情'}
          </Button>
          {installedMark ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="settings-btn-rect"
              onClick={() => onGoToConfig?.(entry.id)}
            >
              去配置
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="settings-btn-rect"
              disabled={busyId === entry.id}
              onClick={() => void onInstallCatalog?.(entry)}
            >
              {busyId === entry.id ? '安装中…' : '安装'}
            </Button>
          )}
        </div>
      </div>
      {detailOpen ? renderExpandBody(entry.kind, entry, 'detail', mcp, actions) : null}
    </div>
  );
};
