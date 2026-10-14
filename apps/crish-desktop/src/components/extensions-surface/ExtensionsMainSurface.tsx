import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Button } from '../ui';
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
import { useSettingsStore } from '../../store/storeAccess';
import { useSessionStore } from '../../store/storeAccess';
import { navigateToChatSession } from '../../store/storeAccess';
import { useToast } from '../../services/toast/ToastContext';
import { clientApi, type Settings, type McpServer } from '../../api/clientApi';
import {
  loadCustomPlugins,
  removeCustomPlugin,
  type CustomPluginItem,
} from './customPluginStorage';
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

  // 自定义插件动态监听
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
          item.id.includes('audit') ||
          (item.catalogEntry?.tags && item.catalogEntry.tags.includes('官方'))
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
      useSettingsStore.getState().setMcpServers(nextList);
      void clientApi.saveSettingsEx('__global__', 'global', {
        mcpServers: nextList,
      } as unknown as Partial<Settings>);
      showToast(start ? `已启用 MCP 服务 ${name}` : `已停用 MCP 服务 ${name}`);
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
        if (item.kind === 'mcp') {
          const current = useSettingsStore.getState().mcpServers || [];
          const next = current.filter((server) => {
            const aliases = [
              server.id,
              server.name,
              `local-mcp:${server.id}`,
              `local-mcp:${server.name}`,
              `mcp:${server.id}`,
              `mcp:${server.name}`,
            ];
            if (aliases.includes(item.id)) return false;
            if (
              server.name &&
              item.name &&
              server.name.toLowerCase() === item.name.toLowerCase()
            ) {
              return false;
            }
            return true;
          });
          if (next.length !== current.length) {
            useSettingsStore.getState().setMcpServers(next);
            await clientApi.saveSettingsEx('__global__', 'global', {
              mcpServers: next,
            } as unknown as Partial<Settings>);
            showToast(`已移除 MCP 服务 ${item.name}`);
          }
        }
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
      })();
    },
    [refresh, handleRemovePackage, selectedInstalledId, showToast]
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

  const handleCreatePlugin = useCallback(() => {
    const sessionId = useSessionStore
      .getState()
      .createSession({ title: '制作新插件' });
    useSessionStore
      .getState()
      .setComposerDraft(
        sessionId,
        '/skill:plugin 我想制作一个新的 Crish 插件，请引导我选择插件的方向与功能'
      );
    navigateToChatSession(sessionId);
    onBackToChat?.();
    showToast('已开启插件制作对话，正在由插件制作助手引导您设计与构建插件');
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
              {tab.label}
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
                categoryFilter={categoryFilter === 'skills' ? 'skill' : 'mcp'}
                onBackToChat={onBackToChat}
                onRefresh={refresh}
                onImportSuccess={refresh}
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
        onRemovePackage={handleRemovePackage}
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
