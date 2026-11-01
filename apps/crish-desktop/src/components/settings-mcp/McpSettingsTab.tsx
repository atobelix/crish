import { useToast } from '../../services/toast/ToastContext';
/**
 * MCP 设置 tab：服务列表 + 状态监控 + 环境变量/工具预览。
 * 支持正式（通过 Rust core）与 demo 模式。
 * 遵循设计系统规范：使用扁平化设计，无双边框，统一悬浮与焦点。
 */
import React from 'react';
import { Tooltip } from '@/components/ui';
import styles from './McpSettingsTab.module.css';
import { SettingsPage } from '../settings/SettingsUI';
import { mcpStateLabel, mcpStateKind } from '../../api/mcpApi';
import { McpServerList } from './McpServerList';
import { McpServerForm } from './McpServerForm';
import { useMcpSettings } from './useMcpSettings';
import { useMcpServerListState } from './useMcpServerListState';
import { useI18n } from '../../i18n';

type Props = {
  onBlockingOverlayChange?: (open: boolean) => void;
};

const kindClassMap: Record<'ok' | 'warn' | 'err' | 'idle', string | undefined> =
  {
    ok: styles.kindOk,
    warn: styles.kindWarn,
    err: styles.kindErr,
    idle: styles.kindIdle,
  };

export const McpSettingsTab: React.FC<Props> = ({
  onBlockingOverlayChange: _onBlockingOverlayChange,
}) => {
  const { t } = useI18n();
  const { showToast: _showToast } = useToast();
  const {
    demo,
    listLabelId,
    toolsPanelPrefix,
    loading,
    servers,
    status,
    error,
    expanded,
    busyId,
    filter,
    sortMode,
    canStartStop,
    controlHint,
    demoServers,
    demoEnabled,
    showAdd,
    newName,
    newType,
    newCmd,
    newArgs,
    newUrl,
    setFilter,
    setShowAdd,
    setNewName,
    setNewType,
    setNewCmd,
    setNewArgs,
    setNewUrl,
    refreshLive,
    refreshDemo,
    refresh,
    handleCopy,
    filtered,
    filteredDemo,
    setSort,
    clearFilter,
    handleToggleServer,
    handleAddDemo,
    handleDeleteDemo,
    toggleExpanded,
    toggleDemoEnabled,
  } = useMcpSettings();

  // 收敛 McpServerList 29 props 为 3 分组对象
  const listState = useMcpServerListState({
    demo,
    loading,
    servers,
    status,
    demoServers,
    demoEnabled,
    filtered,
    filteredDemo,
    expanded,
    busyId,
    filter,
    sortMode,
    canStartStop,
    controlHint,
    showAdd,
    listLabelId,
    toolsPanelPrefix,
    onRefresh: refresh,
    onSetSort: setSort,
    onSetFilter: setFilter,
    onClearFilter: clearFilter,
    onSetShowAdd: setShowAdd,
    onToggleServer: handleToggleServer,
    onCopy: handleCopy,
    onToggleExpanded: toggleExpanded,
    onToggleDemoEnabled: toggleDemoEnabled,
    onDeleteDemo: handleDeleteDemo,
    refreshDemo,
    refreshLive,
  });

  const stopHint =
    controlHint ||
    t(
      'settings.mcp.startStopHint',
      '当前引擎不支持从界面启停；扩展服务通常随任务运行时连接'
    );
  const filterActive = filter.trim().length > 0;
  const demoEnabledCount = demoServers.filter(
    (s) => demoEnabled[s.id] !== false
  ).length;

  /* ───────── 演示模式 ───────── */
  if (demo) {
    return (
      <SettingsPage
        title={t('settings.mcp.pageTitle', 'MCP 服务')}
        meta={
          <div className={`${styles.mcpHeadStats} mcp-head-stats`}>
            <span
              className={`${styles.mcpStatusPill} mcp-status-pill is-demo`}
              aria-live="polite"
            >
              {t('settings.mcp.demoMode', '演示模式')}
            </span>
            <span
              className={`${styles.mcpStatusPill} mcp-status-pill`}
              aria-live="polite"
            >
              {t('settings.mcp.demoCount', '{enabled} 个启用 / 共 {total} 个', {
                enabled: demoEnabledCount,
                total: demoServers.length,
              })}
            </span>
          </div>
        }
      >
        {showAdd ? (
          <McpServerForm
            newName={newName}
            newType={newType}
            newCmd={newCmd}
            newArgs={newArgs}
            newUrl={newUrl}
            setNewName={setNewName}
            setNewType={setNewType}
            setNewCmd={setNewCmd}
            setNewArgs={setNewArgs}
            setNewUrl={setNewUrl}
            setShowAdd={setShowAdd}
            onAddDemo={handleAddDemo}
          />
        ) : null}

        <McpServerList
          servers={listState.servers}
          ui={listState.ui}
          actions={listState.actions}
        />
      </SettingsPage>
    );
  }

  /* ───────── 正式 / 引擎模式 ───────── */
  const readinessKind = status?.readiness
    ? mcpStateKind(status.readiness)
    : null;
  const statusParts = [
    status?.configured
      ? t('settings.mcp.configured', '已配置')
      : t('settings.mcp.unconfigured', '未配置'),
    ...(status?.readiness ? [mcpStateLabel(status.readiness)] : []),
    t('settings.mcp.serverCount', '服务 {count}', {
      count: servers.length,
    }),
  ];
  const statusTooltip = status?.readiness
    ? t('settings.mcp.readinessTooltip', '就绪：{state}', {
        state: mcpStateLabel(status.readiness),
      })
    : status?.configured
      ? t('settings.mcp.configuredTooltip', '引擎已配置扩展服务')
      : t('settings.mcp.unconfiguredTooltip', '引擎侧未配置扩展服务');
  return (
    <SettingsPage
      title={t('settings.mcp.pageTitle', 'MCP 服务')}
      meta={
        <div className={`${styles.mcpHeadStats} mcp-head-stats`}>
          <Tooltip content={statusTooltip}>
            <span
              className={`${styles.mcpStatusPill} mcp-status-pill ${
                readinessKind
                  ? `kind-${readinessKind} ${kindClassMap[readinessKind] ?? ''}`
                  : status?.configured
                    ? `${styles.isOn} is-on`
                    : ''
              }`}
            >
              {statusParts.join(' · ')}
            </span>
          </Tooltip>
          {filterActive ? (
            <span
              className={`${styles.mcpStatusPill} mcp-status-pill`}
              aria-label={t('settings.mcp.filterResultAria', '当前筛选结果数')}
            >
              {t('settings.mcp.showingCount', '显示 {count}', {
                count: filtered.length,
              })}
            </span>
          ) : null}
          {loading ? (
            <span
              className={`${styles.mcpStatusPill} mcp-status-pill`}
              aria-busy="true"
            >
              {t('settings.mcp.refreshing', '刷新中…')}
            </span>
          ) : null}
        </div>
      }
    >
      {!canStartStop ? (
        <div className={styles.mcpHintLine} role="note">
          {stopHint}
        </div>
      ) : null}

      {error ? (
        <Tooltip content={error}>
          <div className={`${styles.mcpErrorLine} mcp-error-line`} role="alert">
            {error}
          </div>
        </Tooltip>
      ) : null}

      <McpServerList
        servers={listState.servers}
        ui={listState.ui}
        actions={listState.actions}
      />
    </SettingsPage>
  );
};
