import React from 'react';
import { Wrench } from 'lucide-react';
import { Tooltip } from '../SettingsUI';
import styles from '../../McpSettingsTab.module.css';

interface McpServerToolsProps {
  tools: string[];
  toolCount?: number;
  serverId: string;
  serverName: string;
  onCopy: (text: string) => void;
}

export const McpServerTools: React.FC<McpServerToolsProps> = React.memo(({
  tools, toolCount, serverId, serverName, onCopy,
}) => {
  const panelId = `mcp-tools-${serverId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const toolN = toolCount ?? tools.length;

  return (
    <div className={`${styles.mcpTools} mcp-tools`} id={panelId} role="region" aria-label={`${serverName} 的工具`}>
      {tools.length === 0 ? (
        <div className={`${styles.mcpToolsEmpty} mcp-tools-empty`} role="status">
          {toolN > 0 ? `工具 ${toolN}（未返回名称）` : '暂无工具'}
        </div>
      ) : (
        <ul>{tools.map((t) => (
          <li key={t}>
            <Wrench size={12} aria-hidden />
            <Tooltip content="复制工具名">
              <button type="button" className={`${styles.mcpInlineCopy} mcp-inline-copy`}
                aria-label={`复制工具名 ${t}`} onClick={() => onCopy(t)}><code>{t}</code></button>
            </Tooltip>
          </li>
        ))}</ul>
      )}
      <div className={`${styles.mcpCardId} mcp-card-id`}>
        标识 <Tooltip content="复制标识">
          <button type="button" className={`${styles.mcpInlineCopy} mcp-inline-copy`}
            aria-label={`复制标识 ${serverId}`} onClick={() => onCopy(serverId)}><code>{serverId}</code></button>
        </Tooltip>
      </div>
    </div>
  );
});
