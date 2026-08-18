import React from 'react';
import styles from './SettingsExtensionsTab.module.css';
import {
  isMcpToolDisabled,
  type CatalogEntry,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import { mcpStateLabel } from '../../api/mcpApi';
import type { ExpandMode } from './types';
import { Button, Switch, Tooltip } from '../ui';

/** MCP 工具区展示态（与 ExtensionCardMcpProps 同源，子组件按需消费）。 */
export interface McpToolsSectionStateProps {
  expandedMcpTools: Set<string>;
  toolTick: number;
  mcpServerBusy: boolean;
  mcpToolBusy: boolean;
}

/** MCP 工具区回调集合（与 ExtensionCardActionsProps 子集）。 */
export interface McpToolsSectionActionsProps {
  onToggleMcpServer?: (serverId: string, start: boolean) => void;
  onToggleMcpTool?: (serverId: string, tool: string, enabled: boolean) => void;
  onToggleExpandMcpTools?: (id: string) => void;
  onSetManage?: (kind: 'skill' | 'mcp' | null) => void;
}

export interface McpToolsSectionProps {
  item: InstalledExtension | CatalogEntry;
  mode: ExpandMode;
  state: McpToolsSectionStateProps;
  actions: McpToolsSectionActionsProps;
}

/**
 * MCP 卡片展开体：detail 模式渲染服务元信息与工具预览；
 * config 模式渲染启停按钮与逐工具开关。从 ExtensionCard 抽出以收敛行数。
 */
export const McpToolsSection: React.FC<McpToolsSectionProps> = ({
  item,
  mode,
  state,
  actions,
}) => {
  const { expandedMcpTools, toolTick, mcpServerBusy, mcpToolBusy } = state;
  const {
    onToggleMcpServer,
    onToggleMcpTool,
    onToggleExpandMcpTools,
    onSetManage,
  } = actions;

  const installedItem =
    'mcpId' in item || 'mcpTools' in item
      ? (item as InstalledExtension)
      : null;
  const entry = !installedItem ? (item as CatalogEntry) : null;

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
