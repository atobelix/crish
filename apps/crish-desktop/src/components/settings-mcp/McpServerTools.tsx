/**
 * MCP 服务列表·工具面板：单行展开后的工具名 / 标识展示与复制。
 * G-03d 拆分自 McpServerList 的 renderTools（行为等价搬移）。
 */

import React from 'react';

import type { McpServerInfo } from '../../api/mcpApi';
import styles from './McpSettingsTab.module.css';
import { Button, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

export type McpServerToolsProps = {
  srv: McpServerInfo;
  panelId: string;
  onCopy: (text: string) => void;
};

export const McpServerTools: React.FC<McpServerToolsProps> = ({
  srv,
  panelId,
  onCopy,
}) => {
  const { t } = useI18n();
  const toolN = srv.toolCount ?? srv.tools.length;
  return (
    <div
      className={`${styles.mcpTools} mcp-tools`}
      id={panelId}
      role="region"
      aria-label={t('settings.mcp.toolsRegionAria', '{name} 的工具', {
        name: srv.name,
      })}
    >
      {srv.tools.length === 0 ? (
        <div
          className={`${styles.mcpToolsEmpty} mcp-tools-empty`}
          role="status"
        >
          {toolN > 0
            ? t(
                'settings.mcp.toolsCountUnnamed',
                '工具 {count}（未返回名称）',
                {
                  count: toolN,
                }
              )
            : t('settings.mcp.noTools', '暂无工具')}
        </div>
      ) : (
        <ul>
          {srv.tools.map((tool) => (
            <li key={tool}>
              <AppIcon name="wrench" size={12} aria-hidden />
              <Tooltip content={t('settings.mcp.copyToolName', '复制工具名')}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`${styles.mcpInlineCopy} mcp-inline-copy`}
                  aria-label={t(
                    'settings.mcp.copyToolNameAria',
                    '复制工具名 {tool}',
                    { tool }
                  )}
                  onClick={() => onCopy(tool)}
                >
                  <code>{tool}</code>
                </Button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      <div className={`${styles.mcpCardId} mcp-card-id`}>
        {t('settings.mcp.idLabel', '标识')}{' '}
        <Tooltip content={t('settings.mcp.copyIdLabel', '复制标识')}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.mcpInlineCopy} mcp-inline-copy`}
            aria-label={t('settings.mcp.copyIdAriaById', '复制标识 {id}', {
              id: srv.id,
            })}
            onClick={() => onCopy(srv.id)}
          >
            <code>{srv.id}</code>
          </Button>
        </Tooltip>
      </div>
    </div>
  );
};
