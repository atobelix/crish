/**
 * MCP 服务列表·工具面板：单行展开后的工具名 / 标识展示与复制。
 * G-03d 拆分自 McpServerList 的 renderTools（行为等价搬移）。
 */

import React from 'react';

import type { McpServerInfo } from '../../api/mcpApi';
import styles from './McpSettingsTab.module.css';
import { Button, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';

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
  const toolN = srv.toolCount ?? srv.tools.length;
  return (
    <div
      className={`${styles.mcpTools} mcp-tools`}
      id={panelId}
      role="region"
      aria-label={`${srv.name} 的工具`}
    >
      {srv.tools.length === 0 ? (
        <div
          className={`${styles.mcpToolsEmpty} mcp-tools-empty`}
          role="status"
        >
          {toolN > 0 ? `工具 ${toolN}（未返回名称）` : '暂无工具'}
        </div>
      ) : (
        <ul>
          {srv.tools.map((t) => (
            <li key={t}>
              <AppIcon name="wrench" size={12} aria-hidden />
              <Tooltip content="复制工具名">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`${styles.mcpInlineCopy} mcp-inline-copy`}
                  aria-label={`复制工具名 ${t}`}
                  onClick={() => onCopy(t)}
                >
                  <code>{t}</code>
                </Button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      <div className={`${styles.mcpCardId} mcp-card-id`}>
        标识{' '}
        <Tooltip content="复制标识">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.mcpInlineCopy} mcp-inline-copy`}
            aria-label={`复制标识 ${srv.id}`}
            onClick={() => onCopy(srv.id)}
          >
            <code>{srv.id}</code>
          </Button>
        </Tooltip>
      </div>
    </div>
  );
};
