import React from 'react';
import {
  type CatalogEntry,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import type { ExpandMode, ManageKind } from './types';
import { Button } from '../ui';
import { isPluginCardItem } from './ExtensionCardIdentity';
import styles from './SettingsExtensionsTab.module.css';

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
  toggleExpand: (
    scope: 'installed' | 'catalog',
    id: string,
    mode: ExpandMode
  ) => void;
  onInstallCatalog?: (entry: CatalogEntry) => void;
  onRemovePackage?: (item: InstalledExtension) => void;
  onToggleMcpServer?: (serverId: string, start: boolean) => void;
  onToggleMcpTool?: (serverId: string, tool: string, enabled: boolean) => void;
  onToggleExpandMcpTools?: (id: string) => void;
  onSetManage?: (kind: ManageKind) => void;
  onGoToConfig?: (id: string) => void;
  /** 插件启停开关（E3 UI 泛化：kind: 'plugin' 分支）。 */
  onTogglePlugin?: (pluginId: string, enabled: boolean) => void;
  /** 点击卡片弹窗详情 */
  onSelect?: (item: InstalledExtension | CatalogEntry) => void;
  /** 点击管理 */
  onManage?: (item: InstalledExtension) => void;
}

/** Props 分组：extension（身份/展示态）+ mcp（MCP 工具态）+ actions（回调集合）。 */
export type ExtensionCardProps = {
  extension: ExtensionCardExtensionProps;
  mcp: ExtensionCardMcpProps;
  actions: ExtensionCardActionsProps;
};

import { AppIcon } from '../ui/icons/index';
import { getExtensionIcon } from './ExtensionDetailModal';

export const ExtensionCard: React.FC<ExtensionCardProps> = ({
  extension,
  mcp: _mcp,
  actions,
}) => {
  const { scope, item, installedMark, canUninstall, detailOpen, busyId } =
    extension;
  const {
    highlightMatch,
    toggleExpand,
    onInstallCatalog,
    onRemovePackage,
    onGoToConfig,
    onTogglePlugin,
    onSelect,
    onManage,
  } = actions;

  const handleCardClick = () => {
    if (onSelect) {
      onSelect(item);
    } else {
      toggleExpand(scope, item.id, 'detail');
    }
  };

  if (scope === 'installed') {
    const installedItem = item as InstalledExtension;
    const pluginCard = isPluginCardItem(installedItem) ? installedItem : null;
    return (
      <div
        className={`${styles.rowBlock}${
          detailOpen ? ` ${styles.rowBlockExpanded}` : ''
        }`}
        role="listitem"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleCardClick();
          }
        }}
      >
        <div className={styles.row}>
          <div className={styles.cardIconBox} aria-hidden>
            <AppIcon name={getExtensionIcon(installedItem)} size={18} />
          </div>
          <div className={styles.rowMain}>
            <div className={styles.titleLine}>
              <span className={styles.name}>
                {highlightMatch(installedItem.name)}
              </span>
            </div>
            <div className={styles.desc}>
              {highlightMatch(installedItem.description)}
            </div>
          </div>
          <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
            {pluginCard ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                active={pluginCard.pluginEnabled}
                aria-pressed={pluginCard.pluginEnabled}
                onClick={() =>
                  onTogglePlugin?.(
                    pluginCard.pluginId!,
                    !pluginCard.pluginEnabled
                  )
                }
              >
                {pluginCard.pluginEnabled ? '已启用' : '已停用'}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              active={detailOpen}
              onClick={() => {
                if (onManage) {
                  onManage(installedItem);
                } else {
                  handleCardClick();
                }
              }}
            >
              管理
            </Button>
            {canUninstall ? (
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => void onRemovePackage?.(installedItem)}
              >
                卸载
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // catalog scope
  const entry = item as CatalogEntry;
  return (
    <div
      className={`${styles.rowBlock}${detailOpen ? ` ${styles.rowBlockExpanded}` : ''}`}
      role="listitem"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCardClick();
        }
      }}
    >
      <div className={styles.row}>
        <div className={styles.cardIconBox} aria-hidden>
          <AppIcon name={getExtensionIcon(entry)} size={18} />
        </div>
        <div className={styles.rowMain}>
          <div className={styles.titleLine}>
            <span className={styles.name}>{highlightMatch(entry.name)}</span>
          </div>
          <div className={styles.desc}>{highlightMatch(entry.description)}</div>
        </div>
        <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
          {installedMark ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              active={detailOpen}
              onClick={() => onGoToConfig?.(entry.id)}
            >
              已安装
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busyId === entry.id}
              onClick={() => void onInstallCatalog?.(entry)}
            >
              {busyId === entry.id ? '安装中…' : '安装'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
