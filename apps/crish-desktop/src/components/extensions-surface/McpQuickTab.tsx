import React from 'react';
import { Button, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import type { DetectedExternalMcpServer } from './detectExternalMcpServers';
import styles from './McpConnectModal.module.css';

export interface McpQuickTabProps {
  scanning: boolean;
  detectedList: DetectedExternalMcpServer[];
  existingNames: Set<string>;
  onScan: () => void;
  onConnect: (item: DetectedExternalMcpServer) => void;
}

export const McpQuickTab: React.FC<McpQuickTabProps> = ({
  scanning,
  detectedList,
  existingNames,
  onScan,
  onConnect,
}) => {
  return (
    <div className={styles.quickContainer}>
      <div className={styles.quickStatusBar}>
        <span className={styles.quickCountText}>
          {scanning
            ? '正在扫描本机客户端配置…'
            : `发现 ${detectedList.length} 个外部 MCP 服务`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={styles.presetBtn}
          disabled={scanning}
          onClick={onScan}
        >
          <AppIcon
            name="refresh"
            size={12}
            className={scanning ? styles.spinning : ''}
          />
          <span>重新扫描</span>
        </Button>
      </div>

      {detectedList.length === 0 ? (
        <div className={styles.emptyQuickState}>
          <AppIcon name="package" size={28} />
          <div className={styles.emptyTitle}>未发现已安装的外部 MCP 服务</div>
          <div className={styles.emptyDesc}>
            未在 Antigravity、Claude Desktop 或 Cursor 中检测到已配置的 MCP
            服务。可通过手动表单或词法 JSON 方式接入。
          </div>
        </div>
      ) : (
        <div className={styles.serverCardsList}>
          {detectedList.map((item) => {
            const isAdded = existingNames.has(item.name);
            const sourceClass =
              item.source === 'Antigravity'
                ? styles.sourceAntigravity
                : item.source === 'Claude Desktop'
                  ? styles.sourceClaude
                  : styles.sourceCursor;

            const previewCmd =
              item.type === 'sse'
                ? item.url || ''
                : `${item.command || ''} ${(item.args || []).join(' ')}`.trim();

            return (
              <div key={item.id} className={styles.serverCard}>
                <div className={styles.cardLeft}>
                  <div className={styles.cardTitleRow}>
                    <span className={styles.serverCardName}>{item.name}</span>
                    <span className={`${styles.sourceBadge} ${sourceClass}`}>
                      {item.source}
                    </span>
                  </div>
                  <div className={styles.serverCommandPreview}>
                    {previewCmd}
                  </div>
                </div>
                <div className={styles.cardRight}>
                  {isAdded ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled
                      className={styles.actionBtn}
                    >
                      <AppIcon name="check" size={13} />
                      <span>已接入</span>
                    </Button>
                  ) : (
                    <Tooltip content="一键接入此服务">
                      <Button
                        variant="primary"
                        size="sm"
                        className={styles.actionBtn}
                        onClick={() => onConnect(item)}
                      >
                        <AppIcon name="plug" size={13} />
                        <span>接入</span>
                      </Button>
                    </Tooltip>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
