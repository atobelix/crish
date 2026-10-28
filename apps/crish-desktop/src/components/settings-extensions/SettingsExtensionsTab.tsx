import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 扩展：插件、MCP、技能；列表内直接查看与配置。
 */
import React, { useState, lazy, Suspense } from 'react';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { SettingsHeadTools, SettingsPage } from '../settings/SettingsUI';
import uiStyles from '../settings/SettingsUI.module.css';

import { useExtensionMarket } from './useExtensionMarket';
import { ExtensionList } from './ExtensionList';
import { ExtensionDetailModal } from './ExtensionDetailModal';
import { emitUiEvent } from '../../api/uiEvents';
import type {
  CatalogEntry,
  InstalledExtension,
} from '../../api/extensionCatalog';
import { Button, Input, SegmentedControl } from '@/components/ui';
import type { KindFilter, MainView } from './types';
import styles from './SettingsExtensionsTab.module.css';
import { AppIcon } from '@/components/ui/icons';

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

  const [selectedDetailItem, setSelectedDetailItem] = useState<
    InstalledExtension | CatalogEntry | null
  >(null);

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
      <div className={styles.manageWrapper}>
        <div className={styles.manageBackBar}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setManage(null);
              void refresh();
            }}
            icon={<AppIcon name="arrow-left" size={14} aria-hidden />}
          >
            返回扩展
          </Button>
        </div>
        <Suspense
          fallback={
            <div className={styles.empty} role="status">
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
      </div>
    );
  }

  return (
    <SettingsPage
      title="扩展"
      meta={
        <SettingsHeadTools>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="刷新"
            icon={
              <AppIcon
                name="refresh"
                size={14}
                className={loading ? 'spin' : undefined}
                aria-hidden
              />
            }
          />
        </SettingsHeadTools>
      }
    >
      <div className={styles.toolbar} role="group" aria-label="筛选">
        <SegmentedControl
          aria-label="视图"
          size="sm"
          className={styles.segment}
          value={view}
          options={[
            { value: 'installed', label: '已安装' },
            { value: 'discover', label: '发现' },
          ]}
          onChange={(v) => {
            setView(v as MainView);
            setExpand(null);
          }}
        />
        <SegmentedControl
          aria-label="类型"
          size="sm"
          className={styles.segment}
          value={kindFilter}
          options={kindFilters.map((f) => ({
            value: f.id,
            label: f.label,
          }))}
          onChange={(v) => setKindFilter(v as KindFilter)}
        />
        <div className={uiStyles.filterInputGrow}>
          <Input
            variant="search"
            size="sm"
            placeholder="搜索…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索扩展"
          />
        </div>
      </div>

      {loadError ? (
        <div className={styles.empty} role="alert">
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
          onSelect: (item) => setSelectedDetailItem(item),
          onManage: (item) => {
            const isImport =
              item.id === '@crish/plugin-import-claude-codex' ||
              item.id === '@crish/import-claude-codex' ||
              item.id.includes('import-claude-codex');
            if (isImport) {
              emitUiEvent('open-external-import');
            } else if (item.kind === 'mcp') {
              setManage('mcp');
            } else if (item.kind === 'skill') {
              setManage('skill');
            } else {
              setSelectedDetailItem(item);
            }
          },
        }}
      />

      <ExtensionDetailModal
        open={Boolean(selectedDetailItem)}
        onClose={() => setSelectedDetailItem(null)}
        scope={view === 'discover' ? 'catalog' : 'installed'}
        item={selectedDetailItem}
        canUninstall={
          selectedDetailItem
            ? selectedDetailItem.id.startsWith('local-plugin:') ||
              !(
                'fromSystem' in selectedDetailItem &&
                selectedDetailItem.fromSystem
              )
            : false
        }
        busyId={busyId}
        mcpState={{
          expandedMcpTools,
          toolTick,
          mcpServerBusy,
          mcpToolBusy,
        }}
        onInstallCatalog={handleInstallCatalog}
        onRemovePackage={handleRemovePackage}
        onTogglePlugin={togglePlugin}
        onToggleMcpServer={toggleMcpServer}
        onToggleMcpTool={toggleMcpTool}
        onToggleExpandMcpTools={toggleExpandMcpTools}
        onSetManage={(k) => {
          setSelectedDetailItem(null);
          setManage(k);
        }}
        onOpenExternalSync={() => {
          emitUiEvent('open-external-import');
        }}
      />
    </SettingsPage>
  );
};
