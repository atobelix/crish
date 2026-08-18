import { useToast } from '../../services/toast/ToastContext';
/**
 * MCP 设置 tab：服务列表 + 状态监控 + 环境变量/工具预览。
 * 支持正式（通过 Rust core）与 demo 模式。
 * 遵循设计系统规范：使用扁平化设计，无双边框，统一悬浮与焦点。
 */
import React from 'react';
import { Tooltip } from '../ui';
import styles from './McpSettingsTab.module.css';
import { SettingsPage } from '../settings/SettingsUI';
import { mcpStateLabel, mcpStateKind } from '../../api/mcpApi';
import { McpServerList } from './McpServerList';
import { McpServerForm } from './McpServerForm';
import { useMcpSettings } from './useMcpSettings';

type Props = {
  onBlockingOverlayChange?: (open: boolean) => void;
};

export const McpSettingsTab: React.FC<Props> = ({ onBlockingOverlayChange: _onBlockingOverlayChange }) => {
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
          <Tooltip
            content={
              status?.configured
                ? '引擎已配置扩展服务'
                : '引擎侧未配置扩展服务'
            }
          >
            <span
              className={`${styles.mcpStatusPill} mcp-status-pill ${status?.configured ? 'is-on' : ''}`}
            >
              {status?.configured ? '已配置' : '未配置'}
            </span>
          </Tooltip>
          {status?.readiness ? (
            <Tooltip content={`就绪：${mcpStateLabel(status.readiness)}`}>
              <span
                className={`${styles.mcpStatusPill} mcp-status-pill kind-${mcpStateKind(status.readiness)}`}
              >
                {mcpStateLabel(status.readiness)}
              </span>
            </Tooltip>
          ) : null}
          <Tooltip content={`共 ${servers.length} 个服务`}>
            <span className={`${styles.mcpStatusPill} mcp-status-pill`}>
              服务 {servers.length}
            </span>
          </Tooltip>
          <Tooltip content={canStartStop ? '可从界面启动/停止' : stopHint}>
            <span
              className={`${styles.mcpStatusPill} mcp-status-pill ${canStartStop ? 'is-on' : ''}`}
            >
              {canStartStop ? '启停可用' : '启停不可用'}
            </span>
          </Tooltip>
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
        <Tooltip content={error}>
          <div className={`${styles.mcpErrorLine} mcp-error-line`} role="alert">
            {error}
          </div>
        </Tooltip>
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
