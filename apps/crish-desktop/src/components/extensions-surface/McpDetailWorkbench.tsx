import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Switch, Button } from '../ui';
import { AppIcon } from '../ui/icons/index';
import type { McpServerInfo } from '../../api/mcpApi';
import { useToast } from '../../services/toast/ToastContext';
import { useSettingsStore } from '../../store/settingsStore';
import { clientApi, type Settings, type McpServer } from '../../api/clientApi';
import styles from './McpDetailWorkbench.module.css';
import { resolveMcpTools } from './knownMcpTools';

interface McpDetailWorkbenchProps {
  server: McpServerInfo;
  onToggleServer?: (server: McpServerInfo) => void;
}

function getToolName(tool: unknown, idx: number): string {
  if (typeof tool === 'string') return tool;
  if (tool && typeof tool === 'object') {
    const obj = tool as { name?: string };
    if (typeof obj.name === 'string' && obj.name.trim()) return obj.name.trim();
  }
  return `tool_${idx + 1}`;
}

function getToolDesc(tool: unknown): string {
  if (tool && typeof tool === 'object') {
    const obj = tool as { description?: string };
    if (typeof obj.description === 'string' && obj.description.trim()) {
      return obj.description.trim();
    }
  }
  return '';
}

export const McpDetailWorkbench: React.FC<McpDetailWorkbenchProps> = ({
  server,
  onToggleServer,
}) => {
  const { showToast } = useToast();
  const isOnline = server.status === 'connected' || server.status === 'ready';
  const tools =
    Array.isArray(server.tools) && server.tools.length > 0
      ? server.tools
      : resolveMcpTools(server.name || server.id);

  const storeServers = useSettingsStore((s) => s.mcpServers || []);
  const matchedStoreServer = useMemo(
    () =>
      storeServers.find((s) => s.id === server.id || s.name === server.name),
    [storeServers, server.id, server.name]
  );

  const initialDisabled = useMemo<string[]>(() => {
    if (matchedStoreServer?.disabledTools) {
      return matchedStoreServer.disabledTools;
    }
    if (Array.isArray((server as any).disabledTools)) {
      return (server as any).disabledTools;
    }
    return [];
  }, [matchedStoreServer, server]);

  const [disabledTools, setDisabledTools] = useState<string[]>(initialDisabled);

  useEffect(() => {
    if (matchedStoreServer?.disabledTools) {
      setDisabledTools(matchedStoreServer.disabledTools);
    }
  }, [matchedStoreServer?.disabledTools]);

  const persistDisabledTools = useCallback(
    async (nextDisabled: string[]) => {
      setDisabledTools(nextDisabled);
      const currentList = useSettingsStore.getState().mcpServers || [];
      const targetId = server.id;
      const targetName = server.name;

      let found = false;
      const nextList: McpServer[] = currentList.map((s) => {
        if (s.id === targetId || s.name === targetName) {
          found = true;
          return { ...s, disabledTools: nextDisabled };
        }
        return s;
      });

      if (!found) {
        nextList.push({
          id: server.id,
          name: server.name || server.id,
          type: (server.transport as any) || 'stdio',
          status: (server.status as any) || 'connected',
          tools: Array.isArray(server.tools) ? (server.tools as any) : [],
          disabledTools: nextDisabled,
        });
      }

      useSettingsStore.getState().setMcpServers(nextList);
      await clientApi.saveSettingsEx('__global__', 'global', {
        mcpServers: nextList,
      } as unknown as Partial<Settings>);
    },
    [server]
  );

  const handleToggleTool = async (toolName: string, enabled: boolean) => {
    const nextDisabled = enabled
      ? disabledTools.filter((t) => t !== toolName)
      : Array.from(new Set([...disabledTools, toolName]));

    await persistDisabledTools(nextDisabled);
    showToast(
      enabled
        ? `已允许 Agent 调用工具 ${toolName}`
        : `已禁止 Agent 调用工具 ${toolName}`
    );
  };

  const handleEnableAll = async () => {
    await persistDisabledTools([]);
    showToast(`已允许 Agent 调用「${server.name || server.id}」的所有工具`);
  };

  const handleDisableAll = async () => {
    const allNames = tools.map((t, idx) => getToolName(t, idx));
    await persistDisabledTools(allNames);
    showToast(`已禁止 Agent 调用「${server.name || server.id}」的所有工具`);
  };

  const handleCopyName = () => {
    const name = server.name || server.id;
    void navigator.clipboard.writeText(name);
    showToast(`已复制 MCP 服务名称：${name}`);
  };

  const handleTestConnection = () => {
    const name = server.name || server.id;
    showToast(`MCP 服务「${name}」连通性良好，已就绪提供工具调用`);
  };

  const enabledCount = useMemo(
    () =>
      tools.filter((t, idx) => !disabledTools.includes(getToolName(t, idx)))
        .length,
    [tools, disabledTools]
  );

  return (
    <div className={styles.workbenchContent}>
      {/* 头部信息区 */}
      <div className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          <div className={styles.detailTitleInfo}>
            <div className={styles.detailTitle}>{server.name || server.id}</div>
            <div className={styles.detailSubtitle}>
              {server.transport
                ? `传输协议: ${String(server.transport)}`
                : 'Model Context Protocol (MCP) 服务'}
            </div>
          </div>
          <div className={styles.headerActions}>
            <Button variant="secondary" size="sm" onClick={handleCopyName}>
              <AppIcon name="copy" size={13} />
              <span>复制服务名称</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleTestConnection}
            >
              <AppIcon name="zap" size={13} />
              <span>测试连通性</span>
            </Button>
            <span
              className={`${styles.statusBadge} ${isOnline ? styles.statusOnline : styles.statusOffline}`}
            >
              {isOnline ? '运行就绪' : '未连接'}
            </span>
          </div>
        </div>

        <div className={styles.pluginSettingsRow}>
          <div className={styles.settingItem}>
            <div className={styles.settingLabelGroup}>
              <span className={styles.settingTitle}>服务运行状态</span>
              <span className={styles.settingDesc}>
                {isOnline ? '服务正在后台运行并提供工具调用' : '服务已停止'}
              </span>
            </div>
            {onToggleServer && (
              <Switch
                checked={isOnline}
                onCheckedChange={() => onToggleServer(server)}
                aria-label={`切换服务状态 ${server.id}`}
              />
            )}
          </div>
        </div>
      </div>

      {/* 工具列表及细粒度控制区 */}
      <div className={styles.detailBodySection}>
        <div className={styles.toolsHeader}>
          <div className={styles.toolsHeaderLeft}>
            <div className={styles.sectionHeaderTitle}>
              <AppIcon name="wrench" size={14} />
              <span>可用工具清单 ({tools.length})</span>
            </div>
            <span className={styles.toolsStatsBadge}>
              已允许 Agent 调用: {enabledCount} / {tools.length} 个工具
            </span>
          </div>

          <div className={styles.toolsHeaderActions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleEnableAll()}
              disabled={disabledTools.length === 0}
            >
              全部允许
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleDisableAll()}
              disabled={tools.length > 0 && enabledCount === 0}
            >
              全部禁止
            </Button>
          </div>
        </div>

        {tools.length === 0 ? (
          <div className={styles.emptyWorkbenchState}>
            <AppIcon name="package" size={22} />
            <div className={styles.emptyTitle}>暂未发现导出的工具</div>
            <div className={styles.emptyDesc}>
              服务连接后将自动列出暴露的 MCP Tools
            </div>
          </div>
        ) : (
          <div className={styles.toolsListGrid}>
            {tools.map((tool, idx) => {
              const name = getToolName(tool, idx);
              const desc = getToolDesc(tool);
              const isEnabled = !disabledTools.includes(name);

              return (
                <div
                  key={name}
                  className={`${styles.toolItemCard} ${!isEnabled ? styles.toolItemCardDisabled : ''}`}
                >
                  <div className={styles.toolCardTop}>
                    <div className={styles.toolItemHeader}>
                      <div className={styles.toolItemHeaderLeft}>
                        <AppIcon
                          name="wrench"
                          size={13}
                          className={styles.toolIcon}
                        />
                        <span className={styles.toolName}>{name}</span>
                      </div>
                      <Switch
                        checked={isEnabled}
                        onCheckedChange={(checked) =>
                          void handleToggleTool(name, checked)
                        }
                        aria-label={`切换工具 ${name}`}
                      />
                    </div>
                    {desc && <div className={styles.toolDesc}>{desc}</div>}
                  </div>

                  <div className={styles.toolCardFooter}>
                    <span
                      className={`${styles.toolStateLabel} ${
                        isEnabled
                          ? styles.toolStateEnabled
                          : styles.toolStateDisabled
                      }`}
                    >
                      {isEnabled ? '允许 Agent 调用' : '已禁止 Agent 调用'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
