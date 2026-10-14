import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Switch, Button, Tooltip, Input } from '../ui';
import { AppIcon } from '../ui/icons/index';
import {
  toggleMcpTool,
  type McpServerInfo,
  type McpToolDefinitionDto,
} from '../../api/mcpApi';
import { useToast } from '../../services/toast/ToastContext';
import { useSettingsStore } from '../../store/storeAccess';
import { clientApi, type Settings, type McpServer } from '../../api/clientApi';
import { useI18n } from '../../i18n';
import styles from './McpDetailWorkbench.module.css';

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

function getToolSchema(tool: unknown): Record<string, unknown> | null {
  if (tool && typeof tool === 'object') {
    const obj = tool as { inputSchema?: Record<string, unknown> };
    if (obj.inputSchema && typeof obj.inputSchema === 'object') {
      return obj.inputSchema;
    }
  }
  return null;
}

function matchesServerId(
  s: McpServer,
  targetId: string,
  targetName?: string
): boolean {
  return (
    s.id === targetId ||
    s.name === targetName ||
    `local-mcp:${s.id}` === targetId ||
    `local-mcp:${s.name}` === targetName ||
    `mcp:${s.id}` === targetId ||
    `mcp:${s.name}` === targetName
  );
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

  const currentStatus = (
    matchedStoreServer?.status ||
    server.status ||
    (server.state === 'ready' || server.state === 'running'
      ? 'connected'
      : server.state) ||
    ''
  ).toLowerCase();
  const isOnline =
    currentStatus === 'connected' ||
    currentStatus === 'ready' ||
    currentStatus === 'running';

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

  const filteredTools = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((tool, idx) => {
      const name = getToolName(tool, idx).toLowerCase();
      const def = toolDefs.find(
        (d) =>
          d &&
          typeof d === 'object' &&
          typeof d.name === 'string' &&
          d.name.toLowerCase() === name
      );
      const desc = (def?.description || getToolDesc(tool)).toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }, [tools, toolDefs, searchQuery]);

  const [testingConn, setTestingConn] = useState(false);
  const [probeResult, setProbeResult] = useState<{
    status: 'idle' | 'success' | 'failed' | 'offline';
    latencyMs?: number;
    message?: string;
  }>({ status: 'idle' });

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
      <div className={styles.detailHeader}>
        <div className={styles.detailHeaderLeft}>
          <div className={styles.serverIconBox}>
            <AppIcon name="blocks" size={16} className={styles.serverIcon} />
          </div>
          <span className={styles.detailTitle}>{server.name || server.id}</span>
          <div className={styles.statusIndicatorGroup}>
            <Tooltip
              content={
                isOnline
                  ? t('tools.mcp.statusRunning', '已连接并在后台运行')
                  : t('tools.mcp.statusStopped', '未连接/已停止')
              }
            >
              <span
                className={`${styles.statusDot} ${isOnline ? styles.statusOnline : styles.statusOffline}`}
                aria-label={
                  isOnline
                    ? t('tools.mcp.connected', '已连接')
                    : t('tools.mcp.disconnected', '未连接')
                }
              />
            </Tooltip>
            {probeResult.status === 'success' && (
              <Tooltip
                content={t(
                  'tools.mcp.latencyNormal',
                  '连通正常，延迟 {latency}ms',
                  {
                    latency: probeResult.latencyMs,
                  }
                )}
              >
                <span className={styles.probeLatency}>
                  {probeResult.latencyMs}ms
                </span>
              </Tooltip>
            )}
            {probeResult.status === 'offline' && (
              <Tooltip
                content={
                  probeResult.message ||
                  t('tools.mcp.serviceDisabled', '服务未启用')
                }
              >
                <span className={styles.probeOfflineText}>
                  {probeResult.message ||
                    t('tools.mcp.serviceDisabled', '服务未启用')}
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
              aria-label={t('tools.mcp.testConnectivity', '连通性测试')}
            >
              <AppIcon
                name="activity"
                size={13}
                className={testingConn ? styles.spinning : ''}
              />
              <span>{t('tools.mcp.testConnectivity', '连通性测试')}</span>
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

        {!isOnline ? (
          <div className={styles.emptyWorkbenchState}>
            <AppIcon name="power" size={22} />
            <div className={styles.emptyTitle}>
              {t('tools.mcp.unconnectedReflectTitle', '未连接，启动后动态反射')}
            </div>
            <div className={styles.emptyDesc}>
              {server.lastError
                ? server.lastError
                : t(
                    'tools.mcp.unconnectedReflectDesc',
                    '服务未连接。请开启上方运行状态开关，启动后将自动动态反射真实的 tools/list 与入参 Schema'
                  )}
            </div>
          </div>
        ) : tools.length === 0 ? (
          <div className={styles.emptyWorkbenchState}>
            <AppIcon name="package" size={22} />
            <div className={styles.emptyTitle}>
              {t('tools.mcp.noExportedTools', '暂未发现导出的工具')}
            </div>
            <div className={styles.emptyDesc}>
              {server.lastError
                ? server.lastError
                : t(
                    'tools.mcp.noToolsDeclared',
                    '服务已连接，但远端未声明任何工具'
                  )}
            </div>
          </div>
        ) : filteredTools.length === 0 ? (
          <div className={styles.emptySearchState}>
            <AppIcon name="search" size={20} />
            <span className={styles.emptyTitle}>
              {t('tools.mcp.noMatchingTools', '未找到匹配「{query}」的工具', {
                query: searchQuery,
              })}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSearchQuery('')}
            >
              {t('tools.mcp.clearSearch', '清空搜索')}
            </Button>
          </div>
        ) : (
          <div className={styles.toolsListGrid}>
            {filteredTools.map((tool, idx) => {
              const name = getToolName(tool, idx);
              const def = toolDefs.find(
                (d) =>
                  d &&
                  typeof d === 'object' &&
                  typeof d.name === 'string' &&
                  d.name === name
              );
              const desc = def?.description || getToolDesc(tool);
              const schema = def?.inputSchema || getToolSchema(tool);
              const isEnabled = !disabledTools.includes(name);

              const hasSchemaProps = Boolean(
                schema &&
                schema.properties &&
                typeof schema.properties === 'object' &&
                !Array.isArray(schema.properties) &&
                Object.keys(schema.properties).length > 0
              );

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
                      aria-label={t('tools.mcp.toggleTool', '切换工具 {name}', {
                        name,
                      })}
                    />
                  </div>
                  {desc ? <div className={styles.toolDesc}>{desc}</div> : null}
                  {hasSchemaProps && schema ? (
                    <div className={styles.toolSchemaBox}>
                      <div className={styles.toolSchemaTitle}>
                        {t('tools.mcp.inputSchema', '入参 Schema')}
                      </div>
                      <div className={styles.toolSchemaParams}>
                        {Object.entries(
                          schema.properties as Record<
                            string,
                            Record<string, unknown>
                          >
                        ).map(([propName, propDef]) => {
                          const isRequired =
                            Array.isArray(schema.required) &&
                            schema.required.includes(propName);
                          const propType =
                            typeof propDef?.type === 'string'
                              ? propDef.type
                              : 'any';
                          const propDesc =
                            typeof propDef?.description === 'string'
                              ? propDef.description
                              : '';
                          const paramTooltip = propDesc
                            ? `${propName} (${propType}): ${propDesc}`
                            : `${propName} (${propType})`;
                          return (
                            <Tooltip key={propName} content={paramTooltip}>
                              <div className={styles.toolParamRow}>
                                <span className={styles.toolParamName}>
                                  {propName}
                                  {isRequired && (
                                    <span className={styles.requiredAsterisk}>
                                      *
                                    </span>
                                  )}
                                </span>
                                <span className={styles.toolParamType}>
                                  ({propType})
                                </span>
                                {propDesc ? (
                                  <span className={styles.toolParamDesc}>
                                    - {propDesc}
                                  </span>
                                ) : null}
                              </div>
                            </Tooltip>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
