import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Button } from '../ui';
import { t } from '../../i18n';
import { useExtensionMarket } from '../settings-extensions/useExtensionMarket';
import { ExternalImportWorkbench } from './ExternalImportWorkbench';
import { ExtensionsHeaderActions } from './ExtensionsHeaderActions';
import { ExtensionsInstalledWorkbench } from './ExtensionsInstalledWorkbench';
import { ExtensionsModals } from './ExtensionsModals';
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
import { setPluginEnabled } from '../settings-extensions/pluginRegistryAdapter';
import {
  buildUnifiedItems,
  type UnifiedExtensionItem,
} from './buildUnifiedItems';
export type { UnifiedExtensionItem };
import { commitUserMcpRoster, useSettingsStore } from '../../store/storeAccess';
import { useSessionStore } from '../../store/storeAccess';
import { navigateToChatSession } from '../../store/storeAccess';
import { useToast } from '../../services/toast/ToastContext';
import { clientApi, type Settings, type McpServer } from '../../api/clientApi';
import {
  loadCustomPlugins,
  type CustomPluginItem,
} from './customPluginStorage';
import { ExtensionsSidebar } from './ExtensionsSidebar';
import { ExtensionsCatalogGrid } from './ExtensionsCatalogGrid';
import {
  uninstallInstalledRecord,
  uninstallUnifiedExtension,
} from './externalImportActions';
import { notifyExtensionLifecycle } from './skillDismissState';
import styles from './ExtensionsMainSurface.module.css';

export interface ExtensionsMainSurfaceProps {
  onBackToChat?: () => void;
}

type CategoryFilter = 'plugins' | 'skills' | 'mcp';
type SidebarNav = 'explore' | 'featured' | 'import' | 'installed';

const CATEGORY_TABS: { id: CategoryFilter; labelKey: string }[] = [
  { id: 'plugins', labelKey: 'extensions.tab.plugins' },
  { id: 'skills', labelKey: 'extensions.tab.skills' },
  { id: 'mcp', labelKey: 'extensions.tab.mcp' },
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
  const [lifecycleTick, setLifecycleTick] = useState(0);

  // 模态弹窗状态
  const [showPluginCreateModal, setShowPluginCreateModal] = useState(false);
  const [pluginCreateTab] = useState<'create' | 'manual'>('create');
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

  const [customPlugins, setCustomPlugins] = useState<CustomPluginItem[]>(() =>
    loadCustomPlugins()
  );
  useEffect(() => {
    const onPlugins = () => setCustomPlugins(loadCustomPlugins());
    const onLifecycle = () => setLifecycleTick((value) => value + 1);
    window.addEventListener('crish:custom-plugins-changed', onPlugins);
    window.addEventListener('crish:extensions-lifecycle', onLifecycle);
    return () => {
      window.removeEventListener('crish:custom-plugins-changed', onPlugins);
      window.removeEventListener('crish:extensions-lifecycle', onLifecycle);
    };
  }, []);

  const settingsMcpServers = useSettingsStore((s) => s.mcpServers || []);

  // 构建统一去重生态列表（接入 settingsMcpServers 与 customPlugins）
  const unifiedItems = useMemo<UnifiedExtensionItem[]>(() => {
    return buildUnifiedItems({
      skills,
      mcpServers,
      settingsMcpServers,
      installed,
      catalogInstalled,
      customPlugins,
    });
  }, [
    skills,
    mcpServers,
    settingsMcpServers,
    installed,
    catalogInstalled,
    customPlugins,
    lifecycleTick,
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
      (item) =>
        item.kind === currentKind &&
        (item.isInstalled ??
          (item.scope === 'installed' || item.scope === 'both'))
    );
  }, [unifiedItems, currentKind]);

  const catalogItems = useMemo(() => {
    let items = unifiedItems.filter((item) => {
      if (item.kind !== currentKind) return false;
      return (
        item.scope === 'catalog' ||
        item.scope === 'both' ||
        Boolean(item.catalogEntry)
      );
    });
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
          `local-mcp:${s.name}` === serverId ||
          `mcp:${s.id}` === serverId ||
          `mcp:${s.name}` === serverId
      );
      const item = matchIndex >= 0 ? currentList[matchIndex] : undefined;
      const nextStatus = start ? 'connected' : 'disconnected';
      let nextList: McpServer[];
      let name = serverId;
      if (item) {
        name = item.name || item.id;
        const updatedItem: McpServer = { ...item, status: nextStatus };
        nextList = [...currentList];
        nextList[matchIndex] = updatedItem;
      } else {
        const cleanId = serverId.replace(/^(local-mcp:|mcp:)/, '');
        name = cleanId;
        const newItem: McpServer = {
          id: cleanId,
          name: cleanId,
          type: 'stdio',
          status: nextStatus,
          tools: [],
        };
        nextList = [...currentList, newItem];
      }
      commitUserMcpRoster(nextList);
      void clientApi.saveSettingsEx('__global__', 'global', {
        mcpServers: nextList,
      } as unknown as Partial<Settings>);
      showToast(
        start
          ? t('extensions.toast.mcpEnabled', { name })
          : t('extensions.toast.mcpDisabled', { name })
      );
      void refresh();
    },
    [refresh, showToast]
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
    (item: { id: string; isEnabled: boolean }) => {
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
      void (async () => {
        const result = await uninstallUnifiedExtension(
          item,
          handleRemovePackage
        );
        if (result.message) showToast(result.message);
        if (item.id.startsWith('custom-plugin:')) {
          setCustomPlugins(loadCustomPlugins());
        }
        setLifecycleTick((value) => value + 1);
        if (selectedInstalledId === item.id) {
          setSidebarNav('explore');
          setSelectedInstalledId(null);
        }
        void refresh();
      })();
    },
    [refresh, handleRemovePackage, selectedInstalledId, showToast]
  );

  const handleRemoveFromDetail = useCallback(
    (item: InstalledExtension) => {
      void (async () => {
        const result = await uninstallInstalledRecord(
          item,
          handleRemovePackage
        );
        if (result.message) showToast(result.message);
        setLifecycleTick((value) => value + 1);
        void refresh();
      })();
    },
    [handleRemovePackage, refresh, showToast]
  );

  const handleInstallCatalogItem = useCallback(
    (item: UnifiedExtensionItem) => {
      if (isImportClaudeCodexPlugin(item)) {
        setOfficialPluginUninstalled(CANONICAL_IMPORT_PLUGIN_ID, false);
        setPluginEnabled(CANONICAL_IMPORT_PLUGIN_ID, true);
        notifyExtensionLifecycle();
        showToast(t('extensions.toast.pluginInstalled', { name: item.name }));
        void refresh();
      } else if (item.catalogEntry) {
        void handleInstallCatalog(item.catalogEntry);
      } else {
        showToast(t('extensions.toast.gotoImport', { name: item.name }));
      }
    },
    [handleInstallCatalog, refresh, showToast]
  );

  const handleCreatePlugin = useCallback(() => {
    const sessionId = useSessionStore
      .getState()
      .createSession({ title: t('extensions.session.pluginMakerTitle') });
    useSessionStore
      .getState()
      .setComposerDraft(sessionId, t('extensions.session.pluginMakerPrompt'));
    navigateToChatSession(sessionId);
    onBackToChat?.();
    showToast(t('extensions.toast.pluginMakerStarted'));
  }, [onBackToChat, showToast]);

  return (
    <div className={styles.surfaceRoot} data-testid="extensions-main-surface">
      {/* 顶部导航栏 */}
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
              {t(tab.labelKey)}
            </Button>
          ))}
        </div>

        <div className={styles.headerRight}>
          <ExtensionsHeaderActions
            categoryFilter={categoryFilter}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onCreatePlugin={handleCreatePlugin}
            onOpenPluginImport={() => setShowPluginCreateModal(true)}
            onOpenSkillCreate={() => setShowSkillCreateModal(true)}
            onOpenMcpConnect={() => setShowMcpConnectModal(true)}
          />
        </div>
      </div>

      {/* 左右两栏架构 */}
      <div className={styles.mainLayout}>
        <ExtensionsSidebar
          sidebarNav={sidebarNav}
          categoryFilter={categoryFilter}
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
                categoryFilter={
                  categoryFilter === 'skills'
                    ? 'skill'
                    : categoryFilter === 'plugins'
                      ? 'plugin'
                      : 'mcp'
                }
                onBackToChat={onBackToChat}
                onRefresh={refresh}
                onImportSuccess={refresh}
                onRequestPluginImport={() => setShowPluginCreateModal(true)}
              />
            </div>
          ) : sidebarNav === 'installed' && selectedInstalledItem ? (
            <div className={styles.workbenchContainer}>
              <ExtensionsInstalledWorkbench
                item={selectedInstalledItem}
                onBackToChat={onBackToChat}
                refresh={refresh}
                onToggleMcp={handleToggleMcp}
                onToggleSkill={handleToggleSkill}
                onToggleGeneral={handleToggleGeneral}
                onSharePlugin={(target) => {
                  setSharePluginTarget(target);
                  setShowPluginShareModal(true);
                }}
              />
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
              onUninstall={handleUninstallItem}
            />
          )}
        </div>
      </div>

      {/* 弹窗管理器 */}
      <ExtensionsModals
        selectedDetailItem={selectedDetailItem}
        onCloseDetail={() => setSelectedDetailItem(null)}
        catalogInstalled={catalogInstalled}
        busyId={busyId}
        skills={skills}
        onToggleSkill={handleToggleSkill}
        onBackToChat={onBackToChat}
        mcpState={{ expandedMcpTools, toolTick, mcpServerBusy, mcpToolBusy }}
        onInstallCatalog={handleInstallCatalog}
        onRemovePackage={handleRemoveFromDetail}
        togglePlugin={togglePlugin}
        onToggleMcpServer={handleToggleMcpServerId}
        onToggleMcpTool={toggleMcpTool}
        onToggleExpandMcpTools={toggleExpandMcpTools}
        showSkillCreateModal={showSkillCreateModal}
        onCloseSkillCreate={() => setShowSkillCreateModal(false)}
        showMcpConnectModal={showMcpConnectModal}
        onCloseMcpConnect={() => setShowMcpConnectModal(false)}
        showPluginCreateModal={showPluginCreateModal}
        pluginCreateTab={pluginCreateTab}
        onClosePluginCreate={() => setShowPluginCreateModal(false)}
        showPluginShareModal={showPluginShareModal}
        onClosePluginShare={() => setShowPluginShareModal(false)}
        sharePluginTarget={sharePluginTarget}
        onRefresh={() => void refresh()}
        onPluginCreated={() => {
          setCustomPlugins(loadCustomPlugins());
          void refresh();
        }}
      />
    </div>
  );
};
