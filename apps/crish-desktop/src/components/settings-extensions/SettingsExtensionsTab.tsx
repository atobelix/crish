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
import {
  Button,
  ConfirmDialog,
  Input,
  SegmentedControl,
  Tooltip,
} from '@/components/ui';
import type { KindFilter, MainView } from './types';
import styles from './SettingsExtensionsTab.module.css';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

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
  const { t } = useI18n();
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
  const [pendingRemove, setPendingRemove] = useState<InstalledExtension | null>(
    null
  );

  const kindFilters: { id: KindFilter; label: string }[] = [
    { id: 'all', label: t('settings.extensions.kindAll', '全部') },
    { id: 'plugin', label: t('settings.extensions.kindPlugin', '插件') },
    { id: 'mcp', label: t('settings.extensions.kindMcp', 'MCP') },
    { id: 'skill', label: t('settings.extensions.kindSkill', '技能') },
  ];

  const uninstallConfirm = (
    <ConfirmDialog
      open={pendingRemove !== null}
      danger
      title={t('settings.extensions.uninstallConfirmTitle', '卸载扩展')}
      description={
        pendingRemove
          ? t(
              'settings.extensions.uninstallConfirm',
              '确定要卸载扩展「{name}」吗？',
              { name: pendingRemove.name }
            )
          : undefined
      }
      confirmLabel={t('settings.extensions.uninstallConfirmAction', '确认卸载')}
      cancelLabel={t('common.cancel', '取消')}
      onCancel={() => setPendingRemove(null)}
      onConfirm={() => {
        if (pendingRemove) void handleRemovePackage(pendingRemove);
        setPendingRemove(null);
      }}
    />
  );

  // —— 全页内嵌：技能/MCP 高级管理 ——
  if (manage === 'skill' || manage === 'mcp') {
    const label =
      manage === 'skill'
        ? t('settings.skills.pageTitle', '技能')
        : t('settings.extensions.kindMcp', 'MCP');
    const backLabel = t('settings.extensions.backToExtensions', '返回扩展');
    return (
      <div className={styles.manageWrapper}>
        <div className={styles.manageBackBar}>
          <Tooltip content={backLabel}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={backLabel}
              onClick={() => {
                setManage(null);
                void refresh();
              }}
              icon={<AppIcon name="arrow-left" size={16} aria-hidden />}
            />
          </Tooltip>
        </div>
        <Suspense
          fallback={
            <div className={styles.empty} role="status">
              {t('settings.extensions.loadingKind', '加载{label}…', {
                label,
              })}
            </div>
          }
        >
          <AppErrorBoundary
            compact
            title={t('settings.extensions.loadFailedKind', '{label}加载失败', {
              label,
            })}
          >
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
      title={t('settings.extensions.pageTitle', '扩展')}
      meta={
        <SettingsHeadTools>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={t('settings.extensions.refreshAria', '刷新')}
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
      <div
        className={styles.toolbar}
        role="group"
        aria-label={t('settings.extensions.filterAria', '筛选')}
      >
        <SegmentedControl
          aria-label={t('settings.extensions.viewAria', '视图')}
          size="sm"
          className={styles.segment}
          value={view}
          options={[
            {
              value: 'installed',
              label: t('settings.extensions.viewInstalled', '已安装'),
            },
            {
              value: 'discover',
              label: t('settings.extensions.viewDiscover', '发现'),
            },
          ]}
          onChange={(v) => {
            setView(v as MainView);
            setExpand(null);
          }}
        />
        <SegmentedControl
          aria-label={t('settings.extensions.kindAria', '类型')}
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
            placeholder={t('settings.extensions.searchPlaceholder', '搜索…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('settings.extensions.searchAria', '搜索扩展')}
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
          onRemovePackage: (item) => setPendingRemove(item),
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
        onRemovePackage={(item) => setPendingRemove(item)}
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
      {uninstallConfirm}
    </SettingsPage>
  );
};
