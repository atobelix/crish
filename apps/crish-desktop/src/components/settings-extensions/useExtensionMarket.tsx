import { toast } from '../../services/toast/ToastContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi, type PackageSource } from '../../api/clientApi';
import {
  markCatalogInstalled,
  unmarkCatalogInstalled,
  loadCatalogInstalledIds,
  applyMcpToolDisabled,
  cacheMcpToolDisabled,
  type CatalogEntry,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import {
  listMcpServers,
  startMcpServer,
  stopMcpServer,
  type McpServerInfo,
} from '../../api/mcpApi';
import { discoverSkills, type DesktopSkill } from '../../api/skillsApi';
import { getWorkspacePath } from '../../api/projectStore';
import { setAppSettings } from '../../api/storeAccess';
import {
  listPluginCardStates,
  setPluginEnabled,
  type PluginCardState,
} from './pluginRegistryAdapter';
import type {
  ExpandMode,
  ExpandTarget,
  MainView,
  ManageKind,
  PendingExpand,
} from './types';
import { buildInstalledExtensions, packageName } from './buildInstalledExtensions';
import { useMcpCache } from './useMcpCache';
import { useMarketQuery } from './useMarketQuery';
import { useSkillsCache } from './useSkillsCache';
import { errText, withTimeout } from './extensionMarketLogic';

export function useExtensionMarket() {
  const [view, setView] = useState<MainView>('installed');

  const { skills, setSkills, saveSkills } = useSkillsCache();
  const { mcpServers, setMcpServers, saveMcpServers } = useMcpCache();

  const [loading, setLoading] = useState(
    () => skills.length === 0 && mcpServers.length === 0
  );
  const hydratedRef = useRef(false);

  const [busyState, setBusyState] = useState<{
    busyId: string | null;
    mcpToolBusy: boolean;
    mcpServerBusy: boolean;
  }>({ busyId: null, mcpToolBusy: false, mcpServerBusy: false });
  const busyId = busyState.busyId;
  const mcpToolBusy = busyState.mcpToolBusy;
  const mcpServerBusy = busyState.mcpServerBusy;
  const setBusyId = (val: React.SetStateAction<string | null>) =>
    setBusyState((prev) => ({
      ...prev,
      busyId: typeof val === 'function' ? val(prev.busyId) : val,
    }));
  const setMcpToolBusy = (val: React.SetStateAction<boolean>) =>
    setBusyState((prev) => ({
      ...prev,
      mcpToolBusy: typeof val === 'function' ? val(prev.mcpToolBusy) : val,
    }));
  const setMcpServerBusy = (val: React.SetStateAction<boolean>) =>
    setBusyState((prev) => ({
      ...prev,
      mcpServerBusy: typeof val === 'function' ? val(prev.mcpServerBusy) : val,
    }));

  const [manage, setManage] = useState<ManageKind>(null);

  const [expandState, setExpandState] = useState<{
    expand: ExpandTarget | null;
    pendingExpand: PendingExpand | null;
  }>({ expand: null, pendingExpand: null });
  const expand = expandState.expand;
  const pendingExpand = expandState.pendingExpand;
  const setExpand = (val: React.SetStateAction<ExpandTarget | null>) =>
    setExpandState((prev) => ({
      ...prev,
      expand: typeof val === 'function' ? val(prev.expand) : val,
    }));
  const setPendingExpand = (val: React.SetStateAction<PendingExpand | null>) =>
    setExpandState((prev) => ({
      ...prev,
      pendingExpand:
        typeof val === 'function' ? val(prev.pendingExpand) : val,
    }));

  const [toolTick, setToolTick] = useState(0);
  const [expandedMcpTools, setExpandedMcpTools] = useState<Set<string>>(
    new Set()
  );

  const toggleExpandMcpTools = useCallback((id: string) => {
    setExpandedMcpTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [dataState, setDataState] = useState<{
    packages: (string | PackageSource)[];
    catalogInstalled: Set<string>;
    plugins: PluginCardState[];
  }>(() => ({
    packages: [],
    catalogInstalled: loadCatalogInstalledIds(),
    plugins: listPluginCardStates(),
  }));
  const packages = dataState.packages;
  const catalogInstalled = dataState.catalogInstalled;
  const plugins = dataState.plugins;
  const setPackages = (val: React.SetStateAction<(string | PackageSource)[]>) =>
    setDataState((prev) => ({
      ...prev,
      packages: typeof val === 'function' ? val(prev.packages) : val,
    }));
  const setCatalogInstalled = (val: React.SetStateAction<Set<string>>) =>
    setDataState((prev) => ({
      ...prev,
      catalogInstalled:
        typeof val === 'function' ? val(prev.catalogInstalled) : val,
    }));
  const setPlugins = (val: React.SetStateAction<PluginCardState[]>) =>
    setDataState((prev) => ({
      ...prev,
      plugins: typeof val === 'function' ? val(prev.plugins) : val,
    }));

  const [loadError, setLoadError] = useState<string | null>(null);

  const cwd = getWorkspacePath() || '';

  const refresh = useCallback(async () => {
    setLoadError(null);
    if (
      !hydratedRef.current &&
      skills.length === 0 &&
      mcpServers.length === 0
    ) {
      setLoading(true);
    }

    try {
      const [skillRes, mcpRes, settings] = await Promise.all([
        withTimeout(
          discoverSkills({ workspacePath: cwd }).catch(() => ({
            skills: [] as DesktopSkill[],
          })),
          4000,
          { skills: [] as DesktopSkill[] }
        ),
        withTimeout(
          listMcpServers().catch(() => ({ servers: [] as McpServerInfo[] })),
          4000,
          { servers: [] as McpServerInfo[] }
        ),
        withTimeout(
          clientApi.getSettingsEx(cwd || '__global__').catch(() => null),
          4000,
          null
        ),
      ]);
      saveSkills(skillRes.skills || []);
      saveMcpServers(mcpRes.servers || []);
      setPackages(settings?.packages || []);
      setCatalogInstalled(loadCatalogInstalledIds());
      setPlugins(listPluginCardStates());
      if (settings?.mcpDisabledTools) {
        cacheMcpToolDisabled(settings.mcpDisabledTools);
      }
      hydratedRef.current = true;
    } catch (e) {
      const msg = errText(e);
      setLoadError(msg);
      toast.show(`扩展刷新失败：${msg}`);
      hydratedRef.current = true;
    } finally {
      setLoading(false);
    }
  }, [cwd, skills.length, mcpServers.length]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installed: InstalledExtension[] = useMemo(
    () =>
      buildInstalledExtensions({
        skills,
        mcpServers,
        packages,
        catalogInstalled,
        plugins,
      }),
    [skills, mcpServers, packages, catalogInstalled, plugins]
  );

  const {
    kindFilter,
    setKindFilter,
    query,
    setQuery,
    highlightMatch,
    matchQ,
    installedFiltered,
    catalogFiltered,
  } = useMarketQuery(installed);

  useEffect(() => {
    if (!pendingExpand) return;
    const hit = installed.find(
      (i) =>
        i.kind === pendingExpand.kind &&
        i.name.toLowerCase() === pendingExpand.name.toLowerCase()
    );
    if (hit) {
      setExpand({ scope: 'installed', id: hit.id, mode: pendingExpand.mode });
      setPendingExpand(null);
      return;
    }
    if (installed.some((i) => i.id === pendingExpand.fallbackId)) {
      setExpand({
        scope: 'installed',
        id: pendingExpand.fallbackId,
        mode: pendingExpand.mode,
      });
      setPendingExpand(null);
    }
  }, [installed, pendingExpand]);

  const toggleExpand = (
    scope: 'installed' | 'catalog',
    id: string,
    mode: ExpandMode
  ) => {
    setExpand((prev) => {
      if (
        prev &&
        prev.scope === scope &&
        prev.id === id &&
        prev.mode === mode
      ) {
        return null;
      }
      return { scope, id, mode };
    });
  };

  const isExpanded = (
    scope: 'installed' | 'catalog',
    id: string,
    mode?: ExpandMode
  ) => {
    if (!expand || expand.scope !== scope || expand.id !== id) return false;
    if (mode) return expand.mode === mode;
    return true;
  };

  const handleInstallCatalog = useCallback(
    async (entry: CatalogEntry) => {
      if (busyId) return;
      setBusyId(entry.id);
      try {
        if (entry.kind === 'plugin') {
          const list = [...packages, entry.installRef];
          const merged = await clientApi.saveSettingsEx(
            cwd || '__global__',
            'global',
            {
              packages: list,
            }
          );
          setPackages(merged.packages || list);
          setAppSettings(merged);
          markCatalogInstalled(entry.id);
          setCatalogInstalled(loadCatalogInstalledIds());
          setView('installed');
          setPendingExpand({
            name: entry.name,
            kind: entry.kind,
            mode: 'config',
            fallbackId: entry.id,
          });
          await refresh();
          toast.show('仅登记包名（未连接引擎安装）');
          return;
        }
        markCatalogInstalled(entry.id);
        setCatalogInstalled(loadCatalogInstalledIds());
        setView('installed');
        setPendingExpand({
          name: entry.name,
          kind: entry.kind,
          mode: 'config',
          fallbackId: entry.id,
        });
        await refresh();
        toast.show('仅标记本机已装，未连接引擎安装');
      } catch (e) {
        toast.show(`安装失败：${errText(e)}`);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, packages, cwd, refresh]
  );

  const handleRemovePackage = useCallback(
    async (item: InstalledExtension) => {
      try {
        if (item.id.startsWith('local-plugin:')) {
          const idx = packages.findIndex(
            (p, i) => `local-plugin:${i}:${packageName(p)}` === item.id
          );
          if (idx >= 0) {
            const list = packages.filter((_, i) => i !== idx);
            const merged = await clientApi.saveSettingsEx(
              cwd || '__global__',
              'global',
              {
                packages: list,
              }
            );
            setPackages(merged.packages || list);
            setAppSettings(merged);
          }
        } else if (!item.fromSystem) {
          unmarkCatalogInstalled(item.id);
          setCatalogInstalled(loadCatalogInstalledIds());
        }
        setExpand(null);
        await refresh();
      } catch (e) {
        toast.show(`卸载失败：${errText(e)}`);
      }
    },
    [packages, cwd, refresh]
  );

  const toggleMcpTool = useCallback(
    async (serverId: string, tool: string, enabled: boolean) => {
      if (mcpToolBusy) return;
      setMcpToolBusy(true);
      try {
        const sets = await clientApi.getSettingsEx(cwd || '__global__');
        const prev = sets?.mcpDisabledTools || {};
        const next = applyMcpToolDisabled(prev, serverId, tool, !enabled);
        const merged = await clientApi.saveSettingsEx(
          cwd || '__global__',
          'global',
          {
            mcpDisabledTools: next,
          }
        );
        setAppSettings(merged);
        cacheMcpToolDisabled(merged.mcpDisabledTools || next);
        setToolTick((n) => n + 1);
      } catch (e) {
        toast.show(`工具开关失败：${errText(e)}`);
      } finally {
        setMcpToolBusy(false);
      }
    },
    [mcpToolBusy, cwd]
  );

  const toggleMcpServer = useCallback(
    async (serverId: string, start: boolean) => {
      if (mcpServerBusy || !serverId) return;
      setMcpServerBusy(true);
      try {
        const r = start
          ? await startMcpServer(serverId)
          : await stopMcpServer(serverId);
        if (!r.ok) {
          toast.show(r.error || (start ? '启动失败' : '停止失败'));
        }
        await refresh();
      } catch (e) {
        toast.show(errText(e));
      } finally {
        setMcpServerBusy(false);
      }
    },
    [mcpServerBusy, refresh]
  );

  /** 插件启停：持久化 + 本地状态刷新（E3 UI 泛化；E2 运行时接入后同步注册表）。 */
  const togglePlugin = useCallback(
    (pluginId: string, enabled: boolean) => {
      setPluginEnabled(pluginId, enabled);
      setPlugins((prev) =>
        prev.map((p) => (p.id === pluginId ? { ...p, enabled } : p))
      );
      toast.show(enabled ? '插件已启用' : '插件已停用');
    },
    []
  );

  return {
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
    skills,
    mcpServers,
    packages,
    catalogInstalled,
    installed,
    installedFiltered,
    catalogFiltered,
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
  };
}
