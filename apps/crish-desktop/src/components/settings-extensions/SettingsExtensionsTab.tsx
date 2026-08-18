import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 扩展：插件、MCP、技能；列表内直接查看与配置。
 */
import React, { lazy, Suspense } from 'react';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { SettingsPage } from '../settings/SettingsUI';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useExtensionMarket } from './useExtensionMarket';
import { ExtensionList } from './ExtensionList';
import { Button } from '../ui';
import type { KindFilter } from './types';

const SkillsSettingsTab = lazy(() =>
  import('../settings-skills/SkillsSettingsTab').then((m) => ({
    default: m.SkillsSettingsTab,
  }))
);
const McpSettingsTab = lazy(() =>
  import('../settings-mcp/McpSettingsTab').then((m) => ({
    default: m.McpSettingsTab,
  }))
);

type Props = {
  onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsExtensionsTab: React.FC<Props> = ({
  onBlockingOverlayChange,
}) => {
  const { showToast: _showToast } = useToast();
  const {
    view,
    setView,
    kindFilter,
    setKindFilter,
    query,
    setQuery,
    loading,
    loadError,
    manage,
    setManage,
    installed,
    installedFiltered,
    catalogFiltered,
    catalogInstalled,
    busyId,
    mcpToolBusy,
    mcpServerBusy,
    expandedMcpTools,
    toolTick,
    toggleExpandMcpTools,
    highlightMatch,
    refresh,
    toggleExpand,
    isExpanded,
    handleInstallCatalog,
    handleRemovePackage,
    toggleMcpTool,
    toggleMcpServer,
    togglePlugin,
    setExpand,
  } = useExtensionMarket();

  const kindFilters: { id: KindFilter; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'plugin', label: '插件' },
    { id: 'mcp', label: 'MCP' },
    { id: 'skill', label: '技能' },
  ];

  // —— 全页内嵌：技能/MCP 高级管理 ——
  if (manage === 'skill' || manage === 'mcp') {
    const label = manage === 'skill' ? '技能' : 'MCP';
    return (
      <SettingsPage
        title={label}
        meta={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="settings-btn-rect"
            onClick={() => {
              setManage(null);
              void refresh();
            }}
            icon={<ArrowLeft size={14} aria-hidden />}
          >
            返回扩展
          </Button>
        }
      >
        <Suspense
          fallback={
            <div className="ext-empty" role="status">
              加载{label}…
            </div>
          }
        >
          <AppErrorBoundary compact title={`${label}加载失败`}>
            {manage === 'skill' ? (
              <SkillsSettingsTab
                onBlockingOverlayChange={onBlockingOverlayChange}
              />
            ) : (
              <McpSettingsTab
                onBlockingOverlayChange={onBlockingOverlayChange}
              />
            )}
          </AppErrorBoundary>
        </Suspense>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="扩展"
      meta={
        <div className="settings-head-tools">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="settings-btn-rect"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="刷新"
            icon={
              <RefreshCw
                size={14}
                className={loading ? 'spin' : undefined}
                aria-hidden
              />
            }
          />
        </div>
      }
    >
      <div
        className="ext-toolbar ext-toolbar--one"
        role="group"
        aria-label="筛选"
      >
        <div className="settings-choice-group" role="group" aria-label="视图">
          <button
            type="button"
            className={`settings-choice-btn ${view === 'installed' ? 'active' : ''}`}
            aria-pressed={view === 'installed'}
            onClick={() => {
              setView('installed');
              setExpand(null);
            }}
          >
            已安装
          </button>
          <button
            type="button"
            className={`settings-choice-btn ${view === 'discover' ? 'active' : ''}`}
            aria-pressed={view === 'discover'}
            onClick={() => {
              setView('discover');
              setExpand(null);
            }}
          >
            发现
          </button>
        </div>
        <div className="settings-choice-group" role="group" aria-label="类型">
          {kindFilters.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`settings-choice-btn ${kindFilter === f.id ? 'active' : ''}`}
              aria-pressed={kindFilter === f.id}
              onClick={() => setKindFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          className="settings-field-input settings-field-input--sm ext-search"
          type="search"
          placeholder="搜索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索扩展"
        />
      </div>

      {loadError ? (
        <div className="ext-empty" role="alert">
          {loadError}
        </div>
      ) : null}

      <ExtensionList
        extensions={{
          view,
          loading,
          installedFiltered,
          catalogFiltered,
          catalogInstalled,
          installed,
          busyId,
          mcpServerBusy,
          mcpToolBusy,
          expandedMcpTools,
          toolTick,
        }}
        filters={{
          query,
          kindFilter,
        }}
        actions={{
          highlightMatch,
          toggleExpand,
          isExpanded,
          onInstallCatalog: handleInstallCatalog,
          onRemovePackage: handleRemovePackage,
          onToggleMcpServer: toggleMcpServer,
          onToggleMcpTool: toggleMcpTool,
          onToggleExpandMcpTools: toggleExpandMcpTools,
          onSetManage: setManage,
          onSetView: setView,
          onSetExpand: setExpand,
          onTogglePlugin: togglePlugin,
        }}
      />
    </SettingsPage>
  );
};
