import React from 'react';
import styles from '../SettingsExtensionsTab.module.css';
import {
  kindLabel,
  isMcpToolDisabled,
  type CatalogEntry,
  type ExtensionKind,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import { mcpStateLabel } from '../../api/mcpApi';
import type { ExpandMode, ManageKind } from './types';

export type ExtensionCardProps = {
  scope: 'installed' | 'catalog';
  item: InstalledExtension | CatalogEntry;
  installedMark?: boolean;
  canUninstall?: boolean;
  detailOpen: boolean;
  configOpen?: boolean;
  busyId: string | null;
  mcpServerBusy: boolean;
  mcpToolBusy: boolean;
  expandedMcpTools: Set<string>;
  toolTick: number;
  highlightMatch: (text: string) => React.ReactNode;
  toggleExpand: (scope: 'installed' | 'catalog', id: string, mode: ExpandMode) => void;
  onInstallCatalog?: (entry: CatalogEntry) => void;
  onRemovePackage?: (item: InstalledExtension) => void;
  onToggleMcpServer?: (serverId: string, start: boolean) => void;
  onToggleMcpTool?: (serverId: string, tool: string, enabled: boolean) => void;
  onToggleExpandMcpTools?: (id: string) => void;
  onSetManage?: (kind: ManageKind) => void;
  onGoToConfig?: (id: string) => void;
};

export const ExtensionCard: React.FC<ExtensionCardProps> = ({
  scope,
  item,
  installedMark,
  canUninstall,
  detailOpen,
  configOpen = false,
  busyId,
  mcpServerBusy,
  mcpToolBusy,
  expandedMcpTools,
  toolTick,
  highlightMatch,
  toggleExpand,
  onInstallCatalog,
  onRemovePackage,
  onToggleMcpServer,
  onToggleMcpTool,
  onToggleExpandMcpTools,
  onSetManage,
  onGoToConfig,
}) => {
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
            <div className="ext-detail-meta" title={installedItem.skillPath}>
              {installedItem.skillPath}
            </div>
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
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
            onClick={() => onSetManage?.('skill')}
          >
            高级管理
          </button>
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
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    onClick={() => onToggleExpandMcpTools?.(installedItem!.id)}
                  >
                    {expandedMcpTools.has(installedItem.id)
                      ? '收起'
                      : `展开全部（${installedItem.mcpTools.length}）`}
                  </button>
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
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
              disabled={mcpServerBusy}
              onClick={() => void onToggleMcpServer?.(installedItem.mcpId!, true)}
            >
              {mcpServerBusy ? '…' : '启动服务'}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
              disabled={mcpServerBusy}
              onClick={() => void onToggleMcpServer?.(installedItem.mcpId!, false)}
            >
              停止服务
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
              onClick={() => onSetManage?.('mcp')}
            >
              高级管理
            </button>
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
                    <span className="ext-tool-name" title={tool}>
                      {tool}
                    </span>
                    <label className="settings-list-control">
                      <span className={`ext-detail-meta ${styles.detailMeta}`}>
                        {off ? '禁用' : '启用'}
                      </span>
                      <input
                        type="checkbox"
                        className="settings-switch"
                        checked={!off}
                        disabled={mcpToolBusy}
                        onChange={(e) => {
                          void onToggleMcpTool?.(serverId, tool, e.target.checked);
                        }}
                        aria-label={`${off ? '启用' : '禁用'}工具 ${tool}`}
                      />
                    </label>
                  </div>
                );
              })}
            {installedItem.mcpTools.length > 12 ? (
              <div style={{ padding: '4px 0' }}>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  onClick={() => onToggleExpandMcpTools?.(installedItem!.id)}
                >
                  {expandedMcpTools.has(installedItem.id)
                    ? '收起'
                    : `展开全部（${installedItem.mcpTools.length}）`}
                </button>
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
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
              aria-expanded={detailOpen}
              onClick={() => toggleExpand('installed', installedItem.id, 'detail')}
            >
              {detailOpen ? '收起' : '详情'}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
              aria-expanded={configOpen}
              onClick={() => toggleExpand('installed', installedItem.id, 'config')}
            >
              {configOpen ? '收起' : '配置'}
            </button>
            {canUninstall ? (
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect danger"
                onClick={() => void onRemovePackage?.(installedItem)}
              >
                卸载
              </button>
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
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
            aria-expanded={detailOpen}
            onClick={() => toggleExpand('catalog', entry.id, 'detail')}
          >
            {detailOpen ? '收起' : '详情'}
          </button>
          {installedMark ? (
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
              onClick={() => onGoToConfig?.(entry.id)}
            >
              去配置
            </button>
          ) : (
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
              disabled={busyId === entry.id}
              onClick={() => void onInstallCatalog?.(entry)}
            >
              {busyId === entry.id ? '安装中…' : '安装'}
            </button>
          )}
        </div>
      </div>
      {detailOpen ? renderExpandBody(entry.kind, entry, 'detail') : null}
    </div>
  );
};
