import React from 'react';
import { Switch, Button, Tooltip, Input } from '../ui';
import { AppIcon } from '../ui/icons/index';
import type { McpServerInfo, McpToolDefinitionDto } from '../../api/mcpApi';
import { useI18n } from '../../i18n';
import {
  resolveToolDisplay,
  type McpProbeResult,
} from './mcpDetailWorkbenchModel';
import styles from './McpDetailWorkbench.module.css';

/** 头部信息区展示属性：仅渲染，行为经回调上抛 */
export interface McpDetailHeaderProps {
  server: McpServerInfo;
  isOnline: boolean;
  probeResult: McpProbeResult;
  testingConn: boolean;
  onTestConnectivity: () => void;
  onToggleServer: (checked: boolean) => void;
}

/** 头部信息区：单行紧凑布局 */
export const McpDetailHeader: React.FC<McpDetailHeaderProps> = ({
  server,
  isOnline,
  probeResult,
  testingConn,
  onTestConnectivity,
  onToggleServer,
}) => {
  const { t } = useI18n();
  return (
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
            onClick={onTestConnectivity}
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
              onCheckedChange={onToggleServer}
              aria-label={`切换服务状态 ${server.id}`}
            />
          </div>
        </Tooltip>
      </div>
    </div>
  );
};

/** 工具区头部展示属性 */
export interface McpToolsHeaderProps {
  toolsCount: number;
  enabledCount: number;
  searchQuery: string;
  canEnableAll: boolean;
  canDisableAll: boolean;
  onSearchChange: (value: string) => void;
  onEnableAll: () => void;
  onDisableAll: () => void;
}

/** 工具区头部：清单计数、搜索与批量允许/禁止 */
export const McpToolsHeader: React.FC<McpToolsHeaderProps> = ({
  toolsCount,
  enabledCount,
  searchQuery,
  canEnableAll,
  canDisableAll,
  onSearchChange,
  onEnableAll,
  onDisableAll,
}) => (
  <div className={styles.toolsHeader}>
    <div className={styles.toolsHeaderLeft}>
      <div className={styles.sectionHeaderTitle}>
        <AppIcon name="wrench" size={14} />
        <span>可用工具清单 ({toolsCount})</span>
      </div>
      <span className={styles.toolsStatsBadge}>
        已允许 Agent 调用: {enabledCount} / {toolsCount} 个工具
      </span>
    </div>

    <div className={styles.toolsHeaderActions}>
      <div className={styles.toolSearchBar}>
        <Input
          variant="search"
          size="sm"
          placeholder="搜索工具名称或描述..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          clearable
          onClear={() => onSearchChange('')}
          aria-label="搜索工具"
        />
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onEnableAll}
        disabled={canEnableAll}
      >
        全部允许
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={onDisableAll}
        disabled={canDisableAll}
      >
        全部禁止
      </Button>
    </div>
  </div>
);

/** 未连接空态展示属性 */
export interface McpOfflineEmptyStateProps {
  server: McpServerInfo;
}

/** 未连接空态：提示开启运行状态开关后动态反射 */
export const McpOfflineEmptyState: React.FC<McpOfflineEmptyStateProps> = ({
  server,
}) => {
  const { t } = useI18n();
  return (
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
  );
};

/** 无工具空态展示属性 */
export interface McpNoToolsEmptyStateProps {
  server: McpServerInfo;
}

/** 无工具空态：服务已连接但远端未声明工具 */
export const McpNoToolsEmptyState: React.FC<McpNoToolsEmptyStateProps> = ({
  server,
}) => {
  const { t } = useI18n();
  return (
    <div className={styles.emptyWorkbenchState}>
      <AppIcon name="package" size={22} />
      <div className={styles.emptyTitle}>
        {t('tools.mcp.noExportedTools', '暂未发现导出的工具')}
      </div>
      <div className={styles.emptyDesc}>
        {server.lastError
          ? server.lastError
          : t('tools.mcp.noToolsDeclared', '服务已连接，但远端未声明任何工具')}
      </div>
    </div>
  );
};

/** 搜索无结果空态展示属性 */
export interface McpEmptySearchStateProps {
  query: string;
  onClearSearch: () => void;
}

/** 搜索无结果空态：提示并支持一键清空搜索 */
export const McpEmptySearchState: React.FC<McpEmptySearchStateProps> = ({
  query,
  onClearSearch,
}) => {
  const { t } = useI18n();
  return (
    <div className={styles.emptySearchState}>
      <AppIcon name="search" size={20} />
      <span className={styles.emptyTitle}>
        {t('tools.mcp.noMatchingTools', '未找到匹配「{query}」的工具', {
          query,
        })}
      </span>
      <Button variant="secondary" size="sm" onClick={onClearSearch}>
        {t('tools.mcp.clearSearch', '清空搜索')}
      </Button>
    </div>
  );
};

/** 工具卡片展示属性 */
export interface McpToolCardProps {
  tool: string | McpToolDefinitionDto;
  idx: number;
  toolDefs: McpToolDefinitionDto[];
  isEnabled: boolean;
  onToggle: (toolName: string, checked: boolean) => void;
}

/** 单个工具卡片：名称、描述、开关与入参 Schema 参数列表 */
export const McpToolCard: React.FC<McpToolCardProps> = ({
  tool,
  idx,
  toolDefs,
  isEnabled,
  onToggle,
}) => {
  const { t } = useI18n();
  const { name, desc, schema, hasSchemaProps } = resolveToolDisplay(
    tool,
    idx,
    toolDefs
  );

  return (
    <div
      className={`${styles.toolItemCard} ${!isEnabled ? styles.toolItemCardDisabled : ''}`}
    >
      <div className={styles.toolItemHeader}>
        <div className={styles.toolItemHeaderLeft}>
          <AppIcon name="wrench" size={13} className={styles.toolIcon} />
          <span className={styles.toolName}>{name}</span>
        </div>
        <Switch
          checked={isEnabled}
          onCheckedChange={(checked) => onToggle(name, checked)}
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
              schema.properties as Record<string, Record<string, unknown>>
            ).map(([propName, propDef]) => {
              const isRequired =
                Array.isArray(schema.required) &&
                schema.required.includes(propName);
              const propType =
                typeof propDef?.type === 'string' ? propDef.type : 'any';
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
                        <span className={styles.requiredAsterisk}>*</span>
                      )}
                    </span>
                    <span className={styles.toolParamType}>({propType})</span>
                    {propDesc ? (
                      <span className={styles.toolParamDesc}>- {propDesc}</span>
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
};
