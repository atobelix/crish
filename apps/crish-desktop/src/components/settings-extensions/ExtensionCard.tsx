import React from 'react';
import styles from './SettingsExtensionsTab.module.css';
import {
  kindLabel,
  isMcpToolDisabled,
  type CatalogEntry,
  type ExtensionKind,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import { mcpStateLabel } from '../../api/mcpApi';
import type { ExpandMode, ManageKind, PluginInstalledExtension } from './types';
import { Button, Switch, Tooltip } from '../ui';

/** 插件卡片收窄：manifest 元数据条目（useExtensionMarket 构造，id 恒有 pluginId）。 */
function isPluginCardItem(
  item: InstalledExtension | CatalogEntry,
): item is PluginInstalledExtension {
  return 'pluginId' in item && item.kind === 'plugin';
}

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
  const { expandedMcpTools, toolTick, mcpServerBusy, mcpToolBusy } = mcp;
  const {
    highlightMatch,
    toggleExpand,
    onInstallCatalog,
    onRemovePackage,
    onToggleMcpServer,
    onToggleMcpTool,
    onToggleExpandMcpTools,
    onSetManage,
    onGoToConfig,
    onTogglePlugin,
  } = actions;
  const renderSkillBody = (
    targetItem: InstalledExtension | CatalogEntry,
    mode: ExpandMode
  ) => {
    const isInstalled = 'skillPath' in targetItem || 'skillRaw' in targetItem;
    const installedItem = isInstalled ? (targetItem as InstalledExtension) : null;
    const entry = !isInstalled ? (targetItem as CatalogEntry) : null;
    if (mode === 'detail') {
      return (
        <div className="ext-inline-panel">
          {installedItem?.skillPath ? (
            <Tooltip content={installedItem.skillPath}>
              <div className="ext-detail-meta">
                {installedItem.skillPath}
              </div>
            </Tooltip>
          ) : null}
          <pre className="ext-detail-md" tabIndex={0}>
            {(installedItem &&
              (installedItem.skillRaw ||
                installedItem.skillContent ||
                '# 暂无 SKILL.md 内容')) ||
              (entry
                ? `# ${entry.name}\n\n${entry.description}\n\n安装后可在本机技能目录中查看完整 SKILL.md。`
                : '# 暂无内容')}
          </pre>
        </div>
      );
    }
    return (
      <div className="ext-inline-panel">
        <p className="ext-detail-desc">
          {installedItem?.fromSystem
            ? '可在高级管理中编辑路径、同步与更多选项。'
            : '安装后的技能可在本机技能目录维护；高级入口提供完整管理。'}
        </p>
        <div className="ext-detail-actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="settings-btn-rect"
            onClick={() => onSetManage?.('skill')}
          >
            高级管理
          </Button>
        </div>
      </div>
    );
  };

  const renderMcpBody = (
    targetItem: InstalledExtension | CatalogEntry,
    mode: ExpandMode
  ) => {
    const installedItem =
      'mcpId' in targetItem || 'mcpTools' in targetItem
        ? (targetItem as InstalledExtension)
        : null;
    const entry = !installedItem ? (targetItem as CatalogEntry) : null;

    if (mode === 'detail') {
      return (
        <div className="ext-inline-panel">
          {installedItem ? (
            <div className="ext-detail-meta">
              {[
                installedItem.mcpState
                  ? `状态 ${mcpStateLabel(installedItem.mcpState)}`
                  : null,
                installedItem.mcpTransport
                  ? `传输 ${installedItem.mcpTransport}`
                  : null,
                installedItem.mcpTools?.length
                  ? `${installedItem.mcpTools.length} 个工具`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ') || '本机 MCP 服务'}
            </div>
          ) : (
            <p className="ext-detail-desc">
              {entry?.description}
              {entry?.installRef ? `\n引用：${entry.installRef}` : ''}
            </p>
          )}
          {installedItem?.mcpTools && installedItem.mcpTools.length > 0 ? (
            <ul className="ext-inline-tool-preview">
              {installedItem.mcpTools
                .slice(
                  0,
                  expandedMcpTools.has(installedItem.id) ? undefined : 12
                )
                .map((t) => (
                  <li key={t}>{t}</li>
                ))}
              {installedItem.mcpTools.length > 12 ? (
                <li>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onToggleExpandMcpTools?.(installedItem!.id)}
                  >
                    {expandedMcpTools.has(installedItem.id)
                      ? '收起'
                      : `展开全部（${installedItem.mcpTools.length}）`}
                  </Button>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      );
    }

    return (
      <div className="ext-inline-panel">
        {installedItem?.mcpId ? (
          <div className="ext-detail-actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="settings-btn-rect"
              disabled={mcpServerBusy}
              onClick={() => void onToggleMcpServer?.(installedItem.mcpId!, true)}
            >
              {mcpServerBusy ? '…' : '启动服务'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="settings-btn-rect"
              disabled={mcpServerBusy}
              onClick={() => void onToggleMcpServer?.(installedItem.mcpId!, false)}
            >
              停止服务
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="settings-btn-rect"
              onClick={() => onSetManage?.('mcp')}
            >
              高级管理
            </Button>
          </div>
        ) : (
          <p className="ext-detail-desc">
            安装并连接后可在此启停服务与开关工具。
          </p>
        )}
        {installedItem?.mcpTools && installedItem.mcpTools.length > 0 ? (
          <div className="ext-tool-list" role="list" aria-label="MCP 工具">
            {installedItem.mcpTools
              .slice(0, expandedMcpTools.has(installedItem.id) ? undefined : 12)
              .map((tool) => {
                void toolTick;
                const serverId = installedItem.mcpId || installedItem.id;
                const off = isMcpToolDisabled(serverId, tool);
                return (
                  <div
                    key={tool}
                    className={`ext-tool-row${off ? ' is-off' : ''}`}
                    role="listitem"
                  >
                    <Tooltip content={tool}>
                      <span className="ext-tool-name">
                        {tool}
                      </span>
                    </Tooltip>
                    <label className="settings-list-control">
                      <span className={`ext-detail-meta ${styles.detailMeta}`}>
                        {off ? '禁用' : '启用'}
                      </span>
                      <Switch
                        checked={!off}
                        disabled={mcpToolBusy}
                        aria-label={`${off ? '启用' : '禁用'}工具 ${tool}`}
                        onCheckedChange={(checked) => {
                          void onToggleMcpTool?.(serverId, tool, checked);
                        }}
                      />
                    </label>
                  </div>
                );
              })}
            {installedItem.mcpTools.length > 12 ? (
              <div style={{ padding: '4px 0' }}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onToggleExpandMcpTools?.(installedItem!.id)}
                >
                  {expandedMcpTools.has(installedItem.id)
                    ? '收起'
                    : `展开全部（${installedItem.mcpTools.length}）`}
                </Button>
              </div>
            ) : null}
          </div>
        ) : installedItem ? (
          <div className={`ext-empty ${styles.emptyCompact}`} role="status">
            暂无上报工具 · 启动服务后刷新
          </div>
        ) : null}
      </div>
    );
  };

  const renderPluginBody = (
    targetItem: InstalledExtension | CatalogEntry,
    mode: ExpandMode
  ) => {
    const name = targetItem.name;
    const desc = targetItem.description;
    const ref =
      'installRef' in targetItem && targetItem.installRef ? targetItem.installRef : undefined;
    const pluginCard = isPluginCardItem(targetItem) ? targetItem : null;
    return (
      <div className="ext-inline-panel">
        <div className={`ext-detail-md ${styles.detailMdSans}`}>
          {desc}
          {'\n\n'}
          {mode === 'config'
            ? '此插件已安装，可在任务与对话流程中使用。'
            : '安装后会写入本机扩展包列表，供工作台加载。'}
          {ref ? `\n\n引用：${ref}` : ''}
          {`\n名称：${name}`}
          {pluginCard?.pluginVersion ? `\n版本：${pluginCard.pluginVersion}` : ''}
          {pluginCard?.pluginTrustLevel
            ? `\n信任级别：${pluginCard.pluginTrustLevel}`
            : ''}
          {pluginCard?.pluginHooks && pluginCard.pluginHooks.length > 0
            ? `\n钩子：${pluginCard.pluginHooks.join('、')}`
            : ''}
          {pluginCard?.pluginTools && pluginCard.pluginTools.length > 0
            ? `\n工具：${pluginCard.pluginTools.join('、')}`
            : ''}
        </div>
      </div>
    );
  };

  const renderExpandBody = (
    kind: ExtensionKind,
    targetItem: InstalledExtension | CatalogEntry,
    mode: ExpandMode
  ) => {
    if (kind === 'skill') return renderSkillBody(targetItem, mode);
    if (kind === 'mcp') return renderMcpBody(targetItem, mode);
    return renderPluginBody(targetItem, mode);
  };

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
        {detailOpen ? renderExpandBody(installedItem.kind, installedItem, 'detail') : null}
        {configOpen ? renderExpandBody(installedItem.kind, installedItem, 'config') : null}
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
      {detailOpen ? renderExpandBody(entry.kind, entry, 'detail') : null}
    </div>
  );
};
