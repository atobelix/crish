/**
 * 设置 · 扩展服务（MCP）：单行密度列表 / 状态 / 启停 / 工具展开
 * 正式：仅引擎 list；启停仅在 probe 允许时可用
 * 演示：localStorage mock
 * 行内状态即反馈；仅错误 toast，成功静默（禁启停教育 toast / 成功 spam）
 */
import React from 'react';
import { mcpStateKind, mcpStateLabel } from '../api/mcpApi';
import styles from './McpSettingsTab.module.css';
import { SettingsPage } from './settings/SettingsUI';
import { useMcpSettings } from './settings-mcp/useMcpSettings';
import { McpServerForm } from './settings-mcp/McpServerForm';
import { McpServerList } from './settings-mcp/McpServerList';

type Props = {
  onShowToast?: ((msg: string) => void) | undefined;
  /** 通知父级是否"有可展示 MCP"，用于导航等 */
  onAvailabilityChange?: ((available: boolean) => void) | undefined;
};

export const McpSettingsTab: React.FC<Props> = ({ onShowToast, onAvailabilityChange }) => {
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
  } = useMcpSettings({ onShowToast, onAvailabilityChange });

  const stopHint = controlHint || '当前引擎不支持从界面启停；扩展服务通常随任务运行时连接';
  const filterActive = filter.trim().length > 0;
  const demoEnabledCount = demoServers.filter((s) => demoEnabled[s.id] !== false).length;

  /* ───────── 演示模式 ───────── */
  if (demo) {
    return (
      <SettingsPage
        title="扩展服务"
        meta={
          <div className={`${styles.mcpHeadStats} mcp-head-stats`}>
            <span className={`${styles.mcpStatusPill} mcp-status-pill is-demo`} aria-live="polite">
              演示模式
            </span>
            <span className={`${styles.mcpStatusPill} mcp-status-pill`} aria-live="polite">
              {demoEnabledCount} 个启用 / 共 {demoServers.length} 个
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
            onShowToast={onShowToast}
          />
        ) : null}

        <McpServerList
          demo={true}
          loading={loading}
          servers={servers}
          status={status}
          demoServers={demoServers}
          demoEnabled={demoEnabled}
          filtered={filtered}
          filteredDemo={filteredDemo}
          expanded={expanded}
          busyId={busyId}
          filter={filter}
          sortMode={sortMode}
          canStartStop={canStartStop}
          controlHint={controlHint}
          showAdd={showAdd}
          listLabelId={listLabelId}
          toolsPanelPrefix={toolsPanelPrefix}
          onRefresh={refresh}
          onSetSort={setSort}
          onSetFilter={setFilter}
          onClearFilter={clearFilter}
          onSetShowAdd={setShowAdd}
          onToggleServer={handleToggleServer}
          onCopy={handleCopy}
          onToggleExpanded={toggleExpanded}
          onToggleDemoEnabled={toggleDemoEnabled}
          onDeleteDemo={handleDeleteDemo}
          refreshDemo={refreshDemo}
          refreshLive={refreshLive}
        />
      </SettingsPage>
    );
  }

  /* ───────── 正式 / 引擎模式 ───────── */
  return (
    <SettingsPage
      title="扩展服务"
      meta={
        <div className={`${styles.mcpHeadStats} mcp-head-stats`}>
          <span
            className={`${styles.mcpStatusPill} mcp-status-pill ${status?.configured ? 'is-on' : ''}`}
            title={
              status?.configured
                ? '引擎已配置扩展服务'
                : '引擎侧未配置扩展服务'
            }
          >
            {status?.configured ? '已配置' : '未配置'}
          </span>
          {status?.readiness ? (
            <span
              className={`${styles.mcpStatusPill} mcp-status-pill kind-${mcpStateKind(status.readiness)}`}
              title={`就绪：${mcpStateLabel(status.readiness)}`}
            >
              {mcpStateLabel(status.readiness)}
            </span>
          ) : null}
          <span className={`${styles.mcpStatusPill} mcp-status-pill`} title={`共 ${servers.length} 个服务`}>
            服务 {servers.length}
          </span>
          <span
            className={`${styles.mcpStatusPill} mcp-status-pill ${canStartStop ? 'is-on' : ''}`}
            title={canStartStop ? '可从界面启动/停止' : stopHint}
          >
            {canStartStop ? '启停可用' : '启停不可用'}
          </span>
          {filterActive ? (
            <span className={`${styles.mcpStatusPill} mcp-status-pill`} aria-label="当前筛选结果数">
              显示 {filtered.length}
            </span>
          ) : null}
          {loading ? (
            <span className={`${styles.mcpStatusPill} mcp-status-pill`} aria-busy="true">
              刷新中…
            </span>
          ) : null}
        </div>
      }
    >
      {error ? (
        <div className={`${styles.mcpErrorLine} mcp-error-line`} role="alert" title={error}>
          {error}
        </div>
      ) : null}

      <McpServerList
        demo={false}
        loading={loading}
        servers={servers}
        status={status}
        demoServers={demoServers}
        demoEnabled={demoEnabled}
        filtered={filtered}
        filteredDemo={filteredDemo}
        expanded={expanded}
        busyId={busyId}
        filter={filter}
        sortMode={sortMode}
        canStartStop={canStartStop}
        controlHint={controlHint}
        showAdd={showAdd}
        listLabelId={listLabelId}
        toolsPanelPrefix={toolsPanelPrefix}
        onRefresh={refresh}
        onSetSort={setSort}
        onSetFilter={setFilter}
        onClearFilter={clearFilter}
        onSetShowAdd={setShowAdd}
        onToggleServer={handleToggleServer}
        onCopy={handleCopy}
        onToggleExpanded={toggleExpanded}
        onToggleDemoEnabled={toggleDemoEnabled}
        onDeleteDemo={handleDeleteDemo}
        refreshDemo={refreshDemo}
        refreshLive={refreshLive}
      />
    </SettingsPage>
  );
};
