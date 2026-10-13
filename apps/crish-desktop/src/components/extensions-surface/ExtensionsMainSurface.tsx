import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Input, Button } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { useExtensionMarket } from '../settings-extensions/useExtensionMarket';
import { ExtensionDetailModal } from '../settings-extensions/ExtensionDetailModal';
import { ExternalImportWorkbench } from './ExternalImportWorkbench';
import { McpDetailWorkbench } from './McpDetailWorkbench';
import { SkillDetailWorkbench } from './SkillDetailWorkbench';
import {
  ExtensionGeneralWorkbench,
  type GeneralExtensionItem,
} from './ExtensionGeneralWorkbench';
import {
  CANONICAL_IMPORT_PLUGIN_ID,
  isImportClaudeCodexPlugin,
} from './extensionIdentity';
import {
  setOfficialPluginUninstalled,
  type CatalogEntry,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import {
  setSkillActivation,
  invalidateSkillSlashCache,
  type DesktopSkill,
} from '../../api/skillsApi';
import type { McpServerInfo } from '../../api/mcpApi';
import {
  isPluginEnabled,
  setPluginEnabled,
} from '../settings-extensions/pluginRegistryAdapter';
import {
  buildUnifiedItems,
  type UnifiedExtensionItem,
} from './buildUnifiedItems';
export type { UnifiedExtensionItem };
import { useSettingsStore } from '../../store/settingsStore';
import { useToast } from '../../services/toast/ToastContext';
import { clientApi, type Settings, type McpServer } from '../../api/clientApi';
import {
  loadCustomPlugins,
  removeCustomPlugin,
  type CustomPluginItem,
} from './customPluginStorage';
import { McpConnectModal } from './McpConnectModal';
import { SkillCreateModal } from './SkillCreateModal';
import { PluginCreateModal } from './PluginCreateModal';
import { PluginShareModal } from './PluginShareModal';
import { ExtensionsSidebar } from './ExtensionsSidebar';
import { ExtensionsCatalogGrid } from './ExtensionsCatalogGrid';
import styles from './ExtensionsMainSurface.module.css';

export interface ExtensionsMainSurfaceProps {
  onBackToChat?: () => void;
}

type CategoryFilter = 'plugins' | 'skills' | 'mcp';
type SidebarNav = 'explore' | 'featured' | 'import' | 'installed';

const CATEGORY_TABS: { id: CategoryFilter; label: string }[] = [
  { id: 'plugins', label: '插件' },
  { id: 'skills', label: '技能' },
  { id: 'mcp', label: 'MCP 服务' },
];

export const ExtensionsMainSurface: React.FC<ExtensionsMainSurfaceProps> = ({
  onBackToChat,
}) => {
  const { showToast } = useToast();
  const {
    skills,
    mcpServers,
    installed,
    refresh,
    toggleMcpServer,
    toggleMcpTool,
    toggleExpandMcpTools,
    expandedMcpTools,
    toolTick,
    mcpServerBusy,
    mcpToolBusy,
    busyId,
    handleInstallCatalog,
    handleRemovePackage,
    togglePlugin,
    catalogInstalled,
  } = useExtensionMarket();

  // Top Bar 分类与左侧导航状态
  const [categoryFilter, setCategoryFilter] =
    useState<CategoryFilter>('plugins');
  const [sidebarNav, setSidebarNav] = useState<SidebarNav>('explore');
  const [selectedInstalledId, setSelectedInstalledId] = useState<string | null>(
    null
  );
  const [searchQuery, setSearchQuery] = useState('');

  // 模态弹窗状态
  const [showPluginCreateModal, setShowPluginCreateModal] = useState(false);
  const [showPluginShareModal, setShowPluginShareModal] = useState(false);
  const [sharePluginTarget, setSharePluginTarget] = useState<
    | CustomPluginItem
    | { id: string; name: string; description: string; version?: string }
    | null
  >(null);
  const [showSkillCreateModal, setShowSkillCreateModal] = useState(false);
  const [showMcpConnectModal, setShowMcpConnectModal] = useState(false);
  const [selectedDetailItem, setSelectedDetailItem] = useState<
    InstalledExtension | CatalogEntry | null
  >(null);

  // 自定义插件与 MCP 动态监听
  const [customPlugins, setCustomPlugins] = useState<CustomPluginItem[]>(() =>
    loadCustomPlugins()
  );
  useEffect(() => {
    const handler = () => setCustomPlugins(loadCustomPlugins());
    window.addEventListener('crish:custom-plugins-changed', handler);
    return () =>
      window.removeEventListener('crish:custom-plugins-changed', handler);
  }, []);

  const settingsMcpServers = useSettingsStore((s) => s.mcpServers || []);

  // 构建统一去重生态列表（接入 settingsMcpServers 与 customPlugins）
  const unifiedItems = useMemo<UnifiedExtensionItem[]>(() => {
    const baseList = buildUnifiedItems({
      skills,
      mcpServers,
      settingsMcpServers,
      installed,
      catalogInstalled,
    });
    const ids = new Set(baseList.map((it) => it.id));
    const merged = [...baseList];

    for (const cp of customPlugins) {
      const id = `custom-plugin:${cp.id}`;
      if (!ids.has(id) && !ids.has(cp.id)) {
        const inst: InstalledExtension = {
          id,
          kind: 'plugin',
          source: 'local',
          name: cp.name,
          description: cp.description || '自定义扩展插件',
          fromSystem: false,
          detail: cp.version ? `v${cp.version}` : undefined,
        };
        merged.push({
          id,
          kind: 'plugin',
          scope: 'installed',
          name: cp.name,
          description: cp.description || '自定义扩展插件',
          icon: 'puzzle',
          isOfficial: false,
          isEnabled: isPluginEnabled(id),
          installedItem: inst,
          nativeItem: inst,
        });
        ids.add(id);
      }
    }
    return merged;
  }, [
    skills,
    mcpServers,
    settingsMcpServers,
    installed,
    catalogInstalled,
    customPlugins,
  ]);

  // 当前分类过滤（插件 / 技能 / MCP）
  const currentKind =
    categoryFilter === 'mcp'
      ? 'mcp'
      : categoryFilter === 'skills'
        ? 'skill'
        : 'plugin';

  const installedItems = useMemo(() => {
    return unifiedItems.filter(
      (item) => item.scope === 'installed' && item.kind === currentKind
    );
  }, [unifiedItems, currentKind]);

  const catalogItems = useMemo(() => {
    let items = unifiedItems.filter(
      (item) => item.scope === 'catalog' && item.kind === currentKind
    );
    if (sidebarNav === 'featured') {
      items = items.filter(
        (item) =>
          item.isOfficial ||
          item.catalogEntry?.source === 'official' ||
          item.id.includes('import') ||
          item.id.includes('audit')
      );
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q)
      );
    }
    return items;
  }, [unifiedItems, currentKind, sidebarNav, searchQuery]);

  const selectedInstalledItem = useMemo(() => {
    if (sidebarNav !== 'installed' || !selectedInstalledId) return null;
    return installedItems.find((it) => it.id === selectedInstalledId) || null;
  }, [sidebarNav, selectedInstalledId, installedItems]);

  const handleCategoryChange = (cat: CategoryFilter) => {
    setCategoryFilter(cat);
    setSidebarNav('explore');
    setSelectedInstalledId(null);
  };

  const handleToggleSkill = useCallback(
    async (s: DesktopSkill) => {
      const next =
        s.activation === 'enabled' || s.activation === 'recommended'
          ? 'disabled'
          : 'enabled';
      await setSkillActivation(s, next);
      invalidateSkillSlashCache();
      await refresh();
    },
    [refresh]
  );

  const handleToggleMcpServerId = useCallback(
    (serverId: string, start: boolean) => {
      const currentList = useSettingsStore.getState().mcpServers || [];
      const matchIndex = currentList.findIndex(
        (s) =>
          s.id === serverId ||
          s.name === serverId ||
          `local-mcp:${s.id}` === serverId ||
          `local-mcp:${s.name}` === serverId
      );
      const item = matchIndex >= 0 ? currentList[matchIndex] : undefined;
      if (item) {
        const nextStatus = start ? 'connected' : 'disconnected';
        const updatedItem: McpServer = { ...item, status: nextStatus };
        const nextList = [...currentList];
        nextList[matchIndex] = updatedItem;
        useSettingsStore.getState().setMcpServers(nextList);
        void clientApi.saveSettingsEx('__global__', 'global', {
          mcpServers: nextList,
        } as unknown as Partial<Settings>);
        showToast(
          start
            ? `已启用 MCP 服务 ${item.name}`
            : `已停用 MCP 服务 ${item.name}`
        );
        void refresh();
        return;
      }
      void toggleMcpServer(serverId, start);
    },
    [refresh, showToast, toggleMcpServer]
  );

  const handleToggleMcp = useCallback(
    (m: McpServerInfo) => {
      handleToggleMcpServerId(
        m.id,
        !(m.status === 'connected' || m.status === 'ready')
      );
    },
    [handleToggleMcpServerId]
  );

  const handleToggleGeneral = useCallback(
    (item: GeneralExtensionItem) => {
      if (item.id === CANONICAL_IMPORT_PLUGIN_ID) {
        setPluginEnabled(CANONICAL_IMPORT_PLUGIN_ID, !item.isEnabled);
        void refresh();
      } else {
        togglePlugin(item.id, !item.isEnabled);
      }
    },
    [refresh, togglePlugin]
  );

  const handleToggleInstalledItem = useCallback(
    (item: UnifiedExtensionItem, checked: boolean) => {
      if (isImportClaudeCodexPlugin(item)) {
        setPluginEnabled(CANONICAL_IMPORT_PLUGIN_ID, checked);
        void refresh();
      } else if (item.rawSkill) {
        void handleToggleSkill(item.rawSkill);
      } else if (item.rawMcp) {
        handleToggleMcp(item.rawMcp);
      } else {
        togglePlugin(item.id, checked);
      }
    },
    [handleToggleMcp, handleToggleSkill, refresh, togglePlugin]
  );

  const handleUninstallItem = useCallback(
    (item: UnifiedExtensionItem) => {
      if (isImportClaudeCodexPlugin(item)) {
        setOfficialPluginUninstalled(CANONICAL_IMPORT_PLUGIN_ID, true);
        setPluginEnabled(CANONICAL_IMPORT_PLUGIN_ID, false);
        void refresh();
      } else if (item.id.startsWith('custom-plugin:')) {
        const realId = item.id.replace('custom-plugin:', '');
        removeCustomPlugin(realId);
        setCustomPlugins(loadCustomPlugins());
      } else if (item.installedItem) {
        void handleRemovePackage(item.installedItem);
      }
      if (selectedInstalledId === item.id) {
        setSidebarNav('explore');
        setSelectedInstalledId(null);
      }
    },
    [refresh, handleRemovePackage, selectedInstalledId]
  );

  const handleInstallCatalogItem = useCallback(
    (item: UnifiedExtensionItem) => {
      if (isImportClaudeCodexPlugin(item)) {
        setOfficialPluginUninstalled(CANONICAL_IMPORT_PLUGIN_ID, false);
        setPluginEnabled(CANONICAL_IMPORT_PLUGIN_ID, true);
        void refresh();
      } else if (item.catalogEntry) {
        void handleInstallCatalog(item.catalogEntry);
      }
    },
    [handleInstallCatalog, refresh]
  );

  return (
    <div className={styles.surfaceRoot} data-testid="extensions-main-surface">
      {/* 顶部导航栏：纯净文字大字号下划线高亮导航，无胶囊容器背景 */}
      <div className={styles.surfaceHeader}>
        <div className={styles.topNavTabs} role="tablist">
          {CATEGORY_TABS.map((tab) => (
            <Button
              key={tab.id}
              bare
              type="button"
              className={`${styles.topNavTab} ${categoryFilter === tab.id ? styles.activeTopNavTab : ''}`}
              onClick={() => handleCategoryChange(tab.id)}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        <div className={styles.headerRight}>
          {categoryFilter === 'plugins' && (
            <>
              <Button
                variant="secondary"
                size="sm"
                className={styles.headerActionBtn}
                onClick={() => setShowPluginCreateModal(true)}
              >
                <AppIcon name="plus" size={13} />
                <span>制作插件</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className={styles.headerActionBtn}
                onClick={() => setShowPluginCreateModal(true)}
              >
                <AppIcon name="download" size={13} />
                <span>安装插件</span>
              </Button>
            </>
          )}
          {categoryFilter === 'skills' && (
            <Button
              variant="secondary"
              size="sm"
              className={styles.headerActionBtn}
              onClick={() => setShowSkillCreateModal(true)}
            >
              <AppIcon name="plus" size={13} />
              <span>+ 添加技能</span>
            </Button>
          )}
          {categoryFilter === 'mcp' && (
            <Button
              variant="secondary"
              size="sm"
              className={styles.headerActionBtn}
              onClick={() => setShowMcpConnectModal(true)}
            >
              <AppIcon name="plus" size={13} />
              <span>+ 接入 MCP</span>
            </Button>
          )}

          <div className={styles.searchBarWrapper}>
            <AppIcon name="search" size={13} className={styles.searchIcon} />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索扩展、技能与工具…"
              className={styles.searchInput}
            />
          </div>
        </div>
      </div>

      {/* 左右两栏架构 */}
      <div className={styles.mainLayout}>
        <ExtensionsSidebar
          sidebarNav={sidebarNav}
          onSelectNav={(nav) => {
            setSidebarNav(nav);
            setSelectedInstalledId(null);
            if (nav === 'import') {
              void refresh();
            }
          }}
          installedItems={installedItems}
          selectedInstalledId={selectedInstalledId}
          onSelectInstalled={(item) => {
            setSidebarNav('installed');
            setSelectedInstalledId(item.id);
          }}
          onToggleItem={handleToggleInstalledItem}
          onUninstallItem={handleUninstallItem}
        />

        {/* 右侧主工作区 */}
        <div className={styles.rightWorkspace}>
          {sidebarNav === 'import' ? (
            <div className={styles.workbenchContainer}>
              <ExternalImportWorkbench
                onBackToChat={onBackToChat}
                onRefresh={refresh}
                onImportSuccess={refresh}
              />
            </div>
          ) : sidebarNav === 'installed' && selectedInstalledItem ? (
            <div className={styles.workbenchContainer}>
              {isImportClaudeCodexPlugin(selectedInstalledItem) ? (
                <ExternalImportWorkbench
                  onBackToChat={onBackToChat}
                  onRefresh={refresh}
                  onImportSuccess={refresh}
                />
              ) : selectedInstalledItem.kind === 'mcp' &&
                selectedInstalledItem.rawMcp ? (
                <McpDetailWorkbench
                  server={selectedInstalledItem.rawMcp}
                  onToggleServer={handleToggleMcp}
                />
              ) : selectedInstalledItem.kind === 'skill' &&
                selectedInstalledItem.rawSkill ? (
                <SkillDetailWorkbench
                  skill={selectedInstalledItem.rawSkill}
                  onToggleActivation={handleToggleSkill}
                />
              ) : (
                <>
                  <div className={styles.workbenchTopBar}>
                    <span className={styles.workbenchTopBarTitle}>
                      <AppIcon name={selectedInstalledItem.icon} size={14} />
                      <span>{selectedInstalledItem.name} 专属工作台</span>
                    </span>
                    <div className={styles.workbenchTopBarActions}>
                      <Button
                        variant="secondary"
                        size="sm"
                        className={styles.headerActionBtn}
                        onClick={() => {
                          setSharePluginTarget({
                            id: selectedInstalledItem.id.replace(
                              'custom-plugin:',
                              ''
                            ),
                            name: selectedInstalledItem.name,
                            description: selectedInstalledItem.description,
                            version:
                              (selectedInstalledItem.installedItem as any)
                                ?.version || '1.0.0',
                          });
                          setShowPluginShareModal(true);
                        }}
                      >
                        <AppIcon name="upload" size={13} />
                        <span>分享插件</span>
                      </Button>
                    </div>
                  </div>
                  <ExtensionGeneralWorkbench
                    item={{
                      id: selectedInstalledItem.id,
                      kind: selectedInstalledItem.kind,
                      name: selectedInstalledItem.name,
                      description: selectedInstalledItem.description,
                      icon: selectedInstalledItem.icon,
                      isOfficial: selectedInstalledItem.isOfficial,
                      isEnabled: selectedInstalledItem.isEnabled,
                      installRef: selectedInstalledItem.installRef,
                      version:
                        (selectedInstalledItem.installedItem as any)?.version ||
                        '1.0.0',
                    }}
                    onToggleEnabled={handleToggleGeneral}
                  />
                </>
              )}
            </div>
          ) : (
            <ExtensionsCatalogGrid
              catalogItems={catalogItems}
              sidebarNav={sidebarNav === 'featured' ? 'featured' : 'explore'}
              categoryFilter={categoryFilter}
              searchQuery={searchQuery}
              busyId={busyId}
              onSelectDetail={setSelectedDetailItem}
              onInstall={handleInstallCatalogItem}
            />
          )}
        </div>
      </div>

      {/* 目录项详情弹窗 */}
      <ExtensionDetailModal
        open={Boolean(selectedDetailItem)}
        onClose={() => setSelectedDetailItem(null)}
        scope={
          selectedDetailItem &&
          'installRef' in selectedDetailItem &&
          !catalogInstalled.has(selectedDetailItem.id)
            ? 'catalog'
            : 'installed'
        }
        item={selectedDetailItem}
        canUninstall={false}
        busyId={busyId}
        mcpState={{ expandedMcpTools, toolTick, mcpServerBusy, mcpToolBusy }}
        onInstallCatalog={handleInstallCatalog}
        onRemovePackage={handleRemovePackage}
        onTogglePlugin={togglePlugin}
        onToggleMcpServer={handleToggleMcpServerId}
        onToggleMcpTool={toggleMcpTool}
        onToggleExpandMcpTools={toggleExpandMcpTools}
      />

      {/* 扩展/技能/MCP 弹窗 */}
      <SkillCreateModal
        open={showSkillCreateModal}
        onClose={() => setShowSkillCreateModal(false)}
        onSuccess={() => void refresh()}
      />
      <McpConnectModal
        open={showMcpConnectModal}
        onClose={() => setShowMcpConnectModal(false)}
        onSuccess={() => void refresh()}
      />
      <PluginCreateModal
        open={showPluginCreateModal}
        onClose={() => setShowPluginCreateModal(false)}
        onSuccess={() => {
          setCustomPlugins(loadCustomPlugins());
          void refresh();
        }}
      />
      <PluginShareModal
        open={showPluginShareModal}
        onClose={() => setShowPluginShareModal(false)}
        plugin={sharePluginTarget}
      />
    </div>
  );
};
