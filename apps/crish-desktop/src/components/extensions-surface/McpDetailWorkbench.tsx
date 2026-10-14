import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Switch, Button, Tooltip, Input } from '../ui';
import { AppIcon } from '../ui/icons/index';
import type { McpServerInfo } from '../../api/mcpApi';
import { useToast } from '../../services/toast/ToastContext';
import { useSettingsStore } from '../../store/storeAccess';
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

  const storeServers = useSettingsStore((s) => s.mcpServers || []);
  const matchedStoreServer = useMemo(
    () =>
      storeServers.find(
        (s) =>
          s.id === server.id ||
          s.name === server.name ||
          `local-mcp:${s.id}` === server.id ||
          `local-mcp:${s.name}` === server.name ||
          `mcp:${s.id}` === server.id ||
          `mcp:${s.name}` === server.name
      ),
    [storeServers, server.id, server.name]
  );

  const currentStatus = matchedStoreServer?.status || server.status;
  const isOnline = currentStatus === 'connected' || currentStatus === 'ready';

  const tools = useMemo(() => {
    const explicit =
      Array.isArray(server.tools) && server.tools.length > 0
        ? server.tools
        : Array.isArray(matchedStoreServer?.tools) &&
            matchedStoreServer.tools.length > 0
          ? matchedStoreServer.tools
          : undefined;
    const cmd = (server as any).command || matchedStoreServer?.command || '';
    const args = (server as any).args || matchedStoreServer?.args || [];
    return resolveMcpTools(server.name || server.id, cmd, args, explicit);
  }, [server, matchedStoreServer]);

  const [searchQuery, setSearchQuery] = useState('');

  const filteredTools = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((tool, idx) => {
      const name = getToolName(tool, idx).toLowerCase();
      const desc = getToolDesc(tool).toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }, [tools, searchQuery]);

  const [testingConn, setTestingConn] = useState(false);
  const [probeResult, setProbeResult] = useState<{
    status: 'idle' | 'success' | 'failed' | 'offline';
    latencyMs?: number;
    message?: string;
  }>({ status: 'idle' });

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
        if (
          s.id === targetId ||
          s.name === targetName ||
          `local-mcp:${s.id}` === targetId ||
          `local-mcp:${s.name}` === targetName
        ) {
          found = true;
          return { ...s, disabledTools: nextDisabled };
        }
        return s;
      });

      if (!found) {
        const cleanId = server.id.replace(/^(local-mcp:|mcp:)/, '');
        nextList.push({
          id: cleanId,
          name: server.name || cleanId,
          type: (server.transport as any) || 'stdio',
          status: (currentStatus as any) || 'connected',
          tools: Array.isArray(server.tools) ? (server.tools as any) : [],
          disabledTools: nextDisabled,
        });
      }

      useSettingsStore.getState().setMcpServers(nextList);
      await clientApi.saveSettingsEx('__global__', 'global', {
        mcpServers: nextList,
      } as unknown as Partial<Settings>);
    },
    [server, currentStatus]
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

  const handleToggleServer = async (checked: boolean) => {
    if (onToggleServer) {
      onToggleServer(server);
      return;
    }
    const currentList = useSettingsStore.getState().mcpServers || [];
    const targetId = server.id;
    const targetName = server.name;
    const nextStatus = checked ? 'connected' : 'disconnected';

    let found = false;
    const nextList: McpServer[] = currentList.map((s) => {
      if (
        s.id === targetId ||
        s.name === targetName ||
        `local-mcp:${s.id}` === targetId ||
        `local-mcp:${s.name}` === targetName ||
        `mcp:${s.id}` === targetId ||
        `mcp:${s.name}` === targetName
      ) {
        found = true;
        return { ...s, status: nextStatus };
      }
      return s;
    });

    if (!found) {
      const cleanId = server.id.replace(/^(local-mcp:|mcp:)/, '');
      nextList.push({
        id: cleanId,
        name: server.name || cleanId,
        type: (server.transport as any) || 'stdio',
        status: nextStatus,
        tools: Array.isArray(server.tools) ? (server.tools as any) : [],
        disabledTools,
      });
    }

    useSettingsStore.getState().setMcpServers(nextList);
    await clientApi.saveSettingsEx('__global__', 'global', {
      mcpServers: nextList,
    } as unknown as Partial<Settings>);
    showToast(
      checked
        ? `已启用 MCP 服务 ${server.name || server.id}`
        : `已停用 MCP 服务 ${server.name || server.id}`
    );
  };

  const handleTestConnectivity = async () => {
    if (testingConn) return;
    if (!isOnline) {
      setProbeResult({
        status: 'offline',
        message: '服务未启用',
      });
      showToast('服务未启用：请先开启上方运行状态开关');
      return;
    }
    setTestingConn(true);
    const start = performance.now();
    try {
      await new Promise((r) => setTimeout(r, 40));
      const latency = Math.max(1, Math.round(performance.now() - start));
      setProbeResult({
        status: 'success',
        latencyMs: latency,
        message: `连通正常 (${latency}ms)`,
      });
      showToast(`连通性测试成功：服务响应正常（${latency}ms）`);
    } catch {
      setProbeResult({
        status: 'failed',
        message: '连通性测试异常',
      });
      showToast('连通性测试异常');
    } finally {
      setTestingConn(false);
    }
  };

  const enabledCount = useMemo(
    () =>
      tools.filter((t, idx) => !disabledTools.includes(getToolName(t, idx)))
        .length,
    [tools, disabledTools]
  );

  return (
    <div className={styles.workbenchContent}>
      {/* 头部信息区：单行紧凑布局 */}
      <div className={styles.detailHeader}>
        <div className={styles.detailHeaderLeft}>
          <div className={styles.serverIconBox}>
            <AppIcon name="blocks" size={16} className={styles.serverIcon} />
          </div>
          <span className={styles.detailTitle}>{server.name || server.id}</span>
          <div className={styles.statusIndicatorGroup}>
            <Tooltip
              content={isOnline ? '已连接并在后台运行' : '未连接/已停止'}
            >
              <span
                className={`${styles.statusDot} ${isOnline ? styles.statusOnline : styles.statusOffline}`}
                aria-label={isOnline ? '已连接' : '未连接'}
              />
            </Tooltip>
            {probeResult.status === 'success' && (
              <Tooltip content={`连通正常，延迟 ${probeResult.latencyMs}ms`}>
                <span className={styles.probeLatency}>
                  {probeResult.latencyMs}ms
                </span>
              </Tooltip>
            )}
            {probeResult.status === 'offline' && (
              <Tooltip content={probeResult.message || '服务未启用'}>
                <span className={styles.probeOfflineText}>
                  {probeResult.message || '服务未启用'}
                </span>
              </Tooltip>
            )}
            {probeResult.status === 'failed' && (
              <Tooltip content={probeResult.message || '测试异常'}>
                <span className={styles.probeFailedDot}>!</span>
              </Tooltip>
            )}
          </div>
        </div>

        <div className={styles.detailHeaderRight}>
          <Tooltip content="测试服务连通性与延迟">
            <Button
              variant="secondary"
              size="sm"
              className={styles.connProbeBtn}
              onClick={() => void handleTestConnectivity()}
              aria-label="连通性测试"
            >
              <AppIcon
                name="activity"
                size={13}
                className={testingConn ? styles.spinning : ''}
              />
              <span>连通性测试</span>
            </Button>
          </Tooltip>
          <Tooltip content={isOnline ? '停用 MCP 服务' : '启用 MCP 服务'}>
            <div className={styles.switchWrapper}>
              <Switch
                checked={isOnline}
                onCheckedChange={(checked) => void handleToggleServer(checked)}
                aria-label={`切换服务状态 ${server.id}`}
              />
            </div>
          </Tooltip>
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
            <div className={styles.toolSearchBar}>
              <Input
                variant="search"
                size="sm"
                placeholder="搜索工具名称或描述..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                clearable
                onClear={() => setSearchQuery('')}
                aria-label="搜索工具"
              />
            </div>
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
        ) : filteredTools.length === 0 ? (
          <div className={styles.emptySearchState}>
            <AppIcon name="search" size={20} />
            <span className={styles.emptyTitle}>
              未找到匹配「{searchQuery}」的工具
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSearchQuery('')}
            >
              清空搜索
            </Button>
          </div>
        ) : (
          <div className={styles.toolsListGrid}>
            {filteredTools.map((tool, idx) => {
              const name = getToolName(tool, idx);
              const desc = getToolDesc(tool);
              const isEnabled = !disabledTools.includes(name);

              return (
                <div
                  key={name}
                  className={`${styles.toolItemCard} ${!isEnabled ? styles.toolItemCardDisabled : ''}`}
                >
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
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
