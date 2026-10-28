/**
 * ExtensionsMainSurface 状态与业务动作控制器 Hook。
 * 将市场数据同步、分类/功能行导航、MCP/Skill/Plugin 启停与安装卸载逻辑从视图组件中解耦。
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import { t } from '../../i18n';
import { useExtensionMarket } from '../settings-extensions/useExtensionMarket';
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
import {
  commitUserMcpRoster,
  useSettingsStore,
  useSessionStore,
  navigateToChatSession,
} from '../../store/storeAccess';
import { useToast } from '../../services/toast/ToastContext';
import { clientApi, type Settings, type McpServer } from '../../api/clientApi';
import {
  loadCustomPlugins,
  type CustomPluginItem,
} from './customPluginStorage';
import {
  uninstallInstalledRecord,
  uninstallUnifiedExtension,
} from './externalImportActions';
import { notifyExtensionLifecycle } from './skillDismissState';

export type CategoryFilter = 'plugins' | 'skills' | 'mcp';
export type SidebarNav = 'explore' | 'featured' | 'import' | 'installed';

export function useExtensionsMainController(onBackToChat?: () => void) {
  const { showToast } = useToast();
  const market = useExtensionMarket();
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
  } = market;

  const [categoryFilter, setCategoryFilter] =
    useState<CategoryFilter>('plugins');
  const [sidebarNav, setSidebarNav] = useState<SidebarNav>('explore');
  const [selectedInstalledId, setSelectedInstalledId] = useState<string | null>(
    null
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [lifecycleTick, setLifecycleTick] = useState(0);

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

  const unifiedItems = useMemo<UnifiedExtensionItem[]>(
    () =>
      buildUnifiedItems({
        skills,
        mcpServers,
        settingsMcpServers,
        installed,
        catalogInstalled,
        customPlugins,
      }),
    [
      skills,
      mcpServers,
      settingsMcpServers,
      installed,
      catalogInstalled,
      customPlugins,
      lifecycleTick,
    ]
  );

  const currentKind: 'plugin' | 'skill' | 'mcp' =
    categoryFilter === 'mcp'
      ? 'mcp'
      : categoryFilter === 'skills'
        ? 'skill'
        : 'plugin';

  const installedItems = useMemo(
    () =>
      unifiedItems.filter(
        (item) =>
          item.kind === currentKind &&
          (item.isInstalled ??
            (item.scope === 'installed' || item.scope === 'both'))
      ),
    [unifiedItems, currentKind]
  );

  const catalogItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return unifiedItems.filter((item) => {
      if (item.kind !== currentKind) return false;
      if (
        sidebarNav === 'installed' &&
        !(
          item.isInstalled ??
          (item.scope === 'installed' || item.scope === 'both')
        )
      ) {
        return false;
      }
      if (
        sidebarNav === 'featured' &&
        !(
          item.isOfficial ||
          item.catalogEntry?.source === 'official' ||
          item.id.includes('import') ||
          item.id.includes('audit')
        )
      ) {
        return false;
      }
      if (
        q &&
        !item.name.toLowerCase().includes(q) &&
        !item.description.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [unifiedItems, currentKind, sidebarNav, searchQuery]);

  const selectedInstalledItem = useMemo(() => {
    if (!selectedInstalledId) return null;
    return installedItems.find((it) => it.id === selectedInstalledId) || null;
  }, [selectedInstalledId, installedItems]);

  const handleCategoryChange = useCallback((cat: CategoryFilter) => {
    setCategoryFilter(cat);
    setSidebarNav('explore');
    setSelectedInstalledId(null);
  }, []);

  const handleSelectNav = useCallback(
    (nav: SidebarNav) => {
      setSidebarNav(nav);
      setSelectedInstalledId(null);
      if (nav === 'import') {
        void refresh();
      }
    },
    [refresh]
  );

  const handleSelectInstalled = useCallback((item: UnifiedExtensionItem) => {
    setSidebarNav('installed');
    setSelectedInstalledId(item.id);
  }, []);

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
      const cleanId = serverId.replace(/^(local-mcp:|mcp:)/, '');
      const name = item ? item.name || item.id : cleanId;
      const nextList: McpServer[] = item
        ? currentList.map((entry, idx) =>
            idx === matchIndex ? { ...entry, status: nextStatus } : entry
          )
        : [
            ...currentList,
            {
              id: cleanId,
              name: cleanId,
              type: 'stdio',
              status: nextStatus,
              tools: [],
            },
          ];
      commitUserMcpRoster(nextList);
      void clientApi.saveSettingsEx('__global__', 'global', {
        mcpServers: nextList,
      } as unknown as Partial<Settings>);
      showToast(
        t(
          start
            ? 'extensions.toast.mcpEnabled'
            : 'extensions.toast.mcpDisabled',
          { name }
        )
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

  const handleSharePlugin = useCallback(
    (
      target:
        | CustomPluginItem
        | { id: string; name: string; description: string; version?: string }
    ) => {
      setSharePluginTarget(target);
      setShowPluginShareModal(true);
    },
    []
  );

  const handlePluginCreated = useCallback(() => {
    setCustomPlugins(loadCustomPlugins());
    void refresh();
  }, [refresh]);

  return {
    skills,
    busyId,
    catalogInstalled,
    refresh,
    handleInstallCatalog,
    togglePlugin,
    toggleMcpTool,
    toggleExpandMcpTools,
    mcpState: { expandedMcpTools, toolTick, mcpServerBusy, mcpToolBusy },
    categoryFilter,
    sidebarNav,
    selectedInstalledId,
    searchQuery,
    setSearchQuery,
    currentKind,
    installedItems,
    catalogItems,
    selectedInstalledItem,
    showPluginCreateModal,
    setShowPluginCreateModal,
    pluginCreateTab,
    showPluginShareModal,
    setShowPluginShareModal,
    sharePluginTarget,
    showSkillCreateModal,
    setShowSkillCreateModal,
    showMcpConnectModal,
    setShowMcpConnectModal,
    selectedDetailItem,
    setSelectedDetailItem,
    handleCategoryChange,
    handleSelectNav,
    handleSelectInstalled,
    handleToggleSkill,
    handleToggleMcpServerId,
    handleToggleMcp,
    handleToggleGeneral,
    handleUninstallItem,
    handleRemoveFromDetail,
    handleInstallCatalogItem,
    handleCreatePlugin,
    handleSharePlugin,
    handlePluginCreated,
  };
}
