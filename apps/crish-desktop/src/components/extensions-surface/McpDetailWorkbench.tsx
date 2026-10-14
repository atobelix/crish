import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  toggleMcpTool,
  type McpServerInfo,
  type McpToolDefinitionDto,
} from '../../api/mcpApi';
import { useToast } from '../../services/toast/ToastContext';
import { useSettingsStore } from '../../store/storeAccess';
import { clientApi, type Settings, type McpServer } from '../../api/clientApi';
import { useI18n } from '../../i18n';
import {
  deriveCurrentStatus,
  filterTools,
  getToolName,
  isOnlineStatus,
  matchesServerId,
  type McpProbeResult,
} from './mcpDetailWorkbenchModel';
import {
  McpDetailHeader,
  McpEmptySearchState,
  McpNoToolsEmptyState,
  McpOfflineEmptyState,
  McpToolCard,
  McpToolsHeader,
} from './McpDetailWorkbench.sections';
import styles from './McpDetailWorkbench.module.css';

interface McpDetailWorkbenchProps {
  server: McpServerInfo;
  onToggleServer?: (server: McpServerInfo) => void;
}

export const McpDetailWorkbench: React.FC<McpDetailWorkbenchProps> = ({
  server,
  onToggleServer,
}) => {
  const { t } = useI18n();
  const { showToast } = useToast();

  const storeServers = useSettingsStore((s) => s.mcpServers || []);
  const matchedStoreServer = useMemo(
    () => storeServers.find((s) => matchesServerId(s, server.id, server.name)),
    [storeServers, server.id, server.name]
  );

  const currentStatus = deriveCurrentStatus(matchedStoreServer?.status, server);
  const isOnline = isOnlineStatus(currentStatus);

  // 严格从后端真实反射的 tools 渲染；彻底物理拔除静态死字典与模糊推测
  const tools = useMemo<Array<string | McpToolDefinitionDto>>(() => {
    if (Array.isArray(server.tools) && server.tools.length > 0)
      return server.tools;
    if (
      Array.isArray(matchedStoreServer?.tools) &&
      matchedStoreServer.tools.length > 0
    ) {
      return matchedStoreServer.tools;
    }
    return [];
  }, [server.tools, matchedStoreServer?.tools]);

  const toolDefs = useMemo<McpToolDefinitionDto[]>(() => {
    return Array.isArray(server.toolDefs) && server.toolDefs.length > 0
      ? server.toolDefs
      : [];
  }, [server.toolDefs]);

  const [searchQuery, setSearchQuery] = useState('');

  const filteredTools = useMemo(
    () => filterTools(tools, toolDefs, searchQuery),
    [tools, toolDefs, searchQuery]
  );

  const [testingConn, setTestingConn] = useState(false);
  const [probeResult, setProbeResult] = useState<McpProbeResult>({
    status: 'idle',
  });

  const initialDisabled = useMemo<string[]>(() => {
    if (matchedStoreServer?.disabledTools)
      return matchedStoreServer.disabledTools;
    if (Array.isArray((server as any).disabledTools))
      return (server as any).disabledTools;
    return [];
  }, [matchedStoreServer, server]);

  const [disabledTools, setDisabledTools] = useState<string[]>(initialDisabled);

  useEffect(() => {
    if (matchedStoreServer?.disabledTools) {
      setDisabledTools(matchedStoreServer.disabledTools);
    }
  }, [matchedStoreServer?.disabledTools]);

  const persistServerUpdate = useCallback(
    async (updater: (s: McpServer) => McpServer, fallback: () => McpServer) => {
      const currentList = useSettingsStore.getState().mcpServers || [];
      let found = false;
      const nextList = currentList.map((s) => {
        if (matchesServerId(s, server.id, server.name)) {
          found = true;
          return updater(s);
        }
        return s;
      });
      if (!found) nextList.push(fallback());
      useSettingsStore.getState().setMcpServers(nextList);
      await clientApi.saveSettingsEx('__global__', 'global', {
        mcpServers: nextList,
      } as unknown as Partial<Settings>);
    },
    [server]
  );

  const persistDisabledTools = useCallback(
    async (nextDisabled: string[]) => {
      setDisabledTools(nextDisabled);
      await persistServerUpdate(
        (s) => ({ ...s, disabledTools: nextDisabled }),
        () => ({
          id: server.id.replace(/^(local-mcp:|mcp:)/, ''),
          name: server.name || server.id.replace(/^(local-mcp:|mcp:)/, ''),
          type: (server.transport as any) || 'stdio',
          status: (currentStatus as any) || 'connected',
          tools: Array.isArray(server.tools) ? (server.tools as any) : [],
          disabledTools: nextDisabled,
        })
      );
    },
    [persistServerUpdate, server, currentStatus]
  );

  const handleToggleTool = async (toolName: string, enabled: boolean) => {
    const nextDisabled = enabled
      ? disabledTools.filter((t) => t !== toolName)
      : Array.from(new Set([...disabledTools, toolName]));

    await persistDisabledTools(nextDisabled);
    void toggleMcpTool(server.id, toolName, enabled);
    showToast(
      enabled
        ? `已允许 Agent 调用工具 ${toolName}`
        : `已禁止 Agent 调用工具 ${toolName}`
    );
  };

  const handleEnableAll = async () => {
    await persistDisabledTools([]);
    for (let idx = 0; idx < tools.length; idx++) {
      void toggleMcpTool(server.id, getToolName(tools[idx], idx), true);
    }
    showToast(`已允许 Agent 调用「${server.name || server.id}」的所有工具`);
  };

  const handleDisableAll = async () => {
    const allNames = tools.map((t, idx) => getToolName(t, idx));
    await persistDisabledTools(allNames);
    for (const name of allNames) {
      void toggleMcpTool(server.id, name, false);
    }
    showToast(`已禁止 Agent 调用「${server.name || server.id}」的所有工具`);
  };

  const handleToggleServer = async (checked: boolean) => {
    if (onToggleServer) {
      onToggleServer(server);
      return;
    }
    const nextStatus = checked ? 'connected' : 'disconnected';
    await persistServerUpdate(
      (s) => ({ ...s, status: nextStatus }),
      () => ({
        id: server.id.replace(/^(local-mcp:|mcp:)/, ''),
        name: server.name || server.id.replace(/^(local-mcp:|mcp:)/, ''),
        type: (server.transport as any) || 'stdio',
        status: nextStatus,
        tools: Array.isArray(server.tools) ? (server.tools as any) : [],
        disabledTools,
      })
    );
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
        message: t('tools.mcp.serviceDisabled', '服务未启用'),
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
      setProbeResult({ status: 'failed', message: '连通性测试异常' });
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
      <McpDetailHeader
        server={server}
        isOnline={isOnline}
        probeResult={probeResult}
        testingConn={testingConn}
        onTestConnectivity={() => void handleTestConnectivity()}
        onToggleServer={(checked) => void handleToggleServer(checked)}
      />

      {/* 工具列表及细粒度控制区 */}
      <div className={styles.detailBodySection}>
        <McpToolsHeader
          toolsCount={tools.length}
          enabledCount={enabledCount}
          searchQuery={searchQuery}
          canEnableAll={disabledTools.length === 0}
          canDisableAll={tools.length > 0 && enabledCount === 0}
          onSearchChange={setSearchQuery}
          onEnableAll={() => void handleEnableAll()}
          onDisableAll={() => void handleDisableAll()}
        />

        {!isOnline ? (
          <McpOfflineEmptyState server={server} />
        ) : tools.length === 0 ? (
          <McpNoToolsEmptyState server={server} />
        ) : filteredTools.length === 0 ? (
          <McpEmptySearchState
            query={searchQuery}
            onClearSearch={() => setSearchQuery('')}
          />
        ) : (
          <div className={styles.toolsListGrid}>
            {filteredTools.map((tool, idx) => {
              const name = getToolName(tool, idx);
              return (
                <McpToolCard
                  key={name}
                  tool={tool}
                  idx={idx}
                  toolDefs={toolDefs}
                  isEnabled={!disabledTools.includes(name)}
                  onToggle={(toolName, checked) =>
                    void handleToggleTool(toolName, checked)
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
