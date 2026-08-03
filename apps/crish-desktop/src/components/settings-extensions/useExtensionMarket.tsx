import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi, type PackageSource } from '../../api/clientApi';
import {
  EXTENSION_CATALOG,
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
  KindFilter,
  MainView,
  ManageKind,
  PendingExpand,
  PluginInstalledExtension,
} from './types';

const SKILLS_CACHE_KEY = 'crish_skills_cache_v1';
const MCP_SERVERS_CACHE_KEY = 'crish_mcp_servers_cache_v1';

function loadSkillsCache(): DesktopSkill[] {
  try {
    const raw = localStorage.getItem(SKILLS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSkillsCache(list: DesktopSkill[]) {
  try {
    localStorage.setItem(SKILLS_CACHE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

function loadMcpServersCache(): McpServerInfo[] {
  try {
    const raw = localStorage.getItem(MCP_SERVERS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveMcpServersCache(list: McpServerInfo[]) {
  try {
    localStorage.setItem(MCP_SERVERS_CACHE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function packageName(pkg: string | PackageSource): string {
  return typeof pkg === 'string' ? pkg : pkg.source;
}

export function useExtensionMarket(onShowToast: (msg: string) => void) {
  const [view, setView] = useState<MainView>('installed');

  const [searchFilter, setSearchFilter] = useState<{
    kindFilter: KindFilter;
    query: string;
  }>({ kindFilter: 'all', query: '' });
  const kindFilter = searchFilter.kindFilter;
  const query = searchFilter.query;
  const setKindFilter = (val: React.SetStateAction<KindFilter>) =>
    setSearchFilter((prev) => ({ ...prev, kindFilter: typeof val === 'function' ? val(prev.kindFilter) : val }));
  const setQuery = (val: React.SetStateAction<string>) =>
    setSearchFilter((prev) => ({ ...prev, query: typeof val === 'function' ? val(prev.query) : val }));

  const [loading, setLoading] = useState(
    () => loadSkillsCache().length === 0 && loadMcpServersCache().length === 0
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
    setBusyState((prev) => ({ ...prev, busyId: typeof val === 'function' ? val(prev.busyId) : val }));
  const setMcpToolBusy = (val: React.SetStateAction<boolean>) =>
    setBusyState((prev) => ({ ...prev, mcpToolBusy: typeof val === 'function' ? val(prev.mcpToolBusy) : val }));
  const setMcpServerBusy = (val: React.SetStateAction<boolean>) =>
    setBusyState((prev) => ({ ...prev, mcpServerBusy: typeof val === 'function' ? val(prev.mcpServerBusy) : val }));

  const [manage, setManage] = useState<ManageKind>(null);

  const [expandState, setExpandState] = useState<{
    expand: ExpandTarget | null;
    pendingExpand: PendingExpand | null;
  }>({ expand: null, pendingExpand: null });
  const expand = expandState.expand;
  const pendingExpand = expandState.pendingExpand;
  const setExpand = (val: React.SetStateAction<ExpandTarget | null>) =>
    setExpandState((prev) => ({ ...prev, expand: typeof val === 'function' ? val(prev.expand) : val }));
  const setPendingExpand = (val: React.SetStateAction<PendingExpand | null>) =>
    setExpandState((prev) => ({ ...prev, pendingExpand: typeof val === 'function' ? val(prev.pendingExpand) : val }));

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

  const highlightMatch = useCallback(
    (text: string): React.ReactNode => {
      const q = query.trim().toLowerCase();
      if (!q) return text;
      const lower = text.toLowerCase();
      if (!lower.includes(q)) return text;
      const parts: React.ReactNode[] = [];
      let cursor = 0;
      let idx = lower.indexOf(q, cursor);
      while (idx !== -1) {
        if (idx > cursor) parts.push(text.slice(cursor, idx));
        parts.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>);
        cursor = idx + q.length;
        idx = lower.indexOf(q, cursor);
      }
      if (cursor < text.length) parts.push(text.slice(cursor));
      return parts;
    },
    [query]
  );

  const [dataState, setDataState] = useState<{
    skills: DesktopSkill[];
    mcpServers: McpServerInfo[];
    packages: (string | PackageSource)[];
    catalogInstalled: Set<string>;
    plugins: PluginCardState[];
  }>(() => ({
    skills: loadSkillsCache(),
    mcpServers: loadMcpServersCache(),
    packages: [],
    catalogInstalled: loadCatalogInstalledIds(),
    plugins: listPluginCardStates(),
  }));
  const skills = dataState.skills;
  const mcpServers = dataState.mcpServers;
  const packages = dataState.packages;
  const catalogInstalled = dataState.catalogInstalled;
  const plugins = dataState.plugins;
  const setSkills = (val: React.SetStateAction<DesktopSkill[]>) =>
    setDataState((prev) => ({ ...prev, skills: typeof val === 'function' ? val(prev.skills) : val }));
  const setMcpServers = (val: React.SetStateAction<McpServerInfo[]>) =>
    setDataState((prev) => ({ ...prev, mcpServers: typeof val === 'function' ? val(prev.mcpServers) : val }));
  const setPackages = (val: React.SetStateAction<(string | PackageSource)[]>) =>
    setDataState((prev) => ({ ...prev, packages: typeof val === 'function' ? val(prev.packages) : val }));
  const setCatalogInstalled = (val: React.SetStateAction<Set<string>>) =>
    setDataState((prev) => ({ ...prev, catalogInstalled: typeof val === 'function' ? val(prev.catalogInstalled) : val }));
  const setPlugins = (val: React.SetStateAction<PluginCardState[]>) =>
    setDataState((prev) => ({ ...prev, plugins: typeof val === 'function' ? val(prev.plugins) : val }));

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

    const withTimeout = <T,>(
      p: Promise<T>,
      ms: number,
      fallback: T
    ): Promise<T> =>
      new Promise((resolve) => {
        let done = false;
        const t = window.setTimeout(() => {
          if (done) return;
          done = true;
          resolve(fallback);
        }, ms);
        p.then(
          (v) => {
            if (done) return;
            done = true;
            window.clearTimeout(t);
            resolve(v);
          },
          () => {
            if (done) return;
            done = true;
            window.clearTimeout(t);
            resolve(fallback);
          }
        );
      });

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
      setSkills(skillRes.skills || []);
      saveSkillsCache(skillRes.skills || []);
      setMcpServers(mcpRes.servers || []);
      saveMcpServersCache(mcpRes.servers || []);
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
      onShowToast(`扩展刷新失败：${msg}`);
      hydratedRef.current = true;
    } finally {
      setLoading(false);
    }
  }, [cwd, onShowToast, skills.length, mcpServers.length]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installed: InstalledExtension[] = useMemo(() => {
    const out: InstalledExtension[] = [];

    for (const s of skills) {      out.push({
        id: `local-skill:${s.id}`,
        kind: 'skill',
        source: s.system ? 'official' : 'local',
        name: s.name,
        description: s.description || '本机技能',
        fromSystem: true,
        skillContent: s.content,
        skillRaw: s.raw,
        skillPath: s.filePath,
      });
    }

    for (const m of mcpServers) {
      const tools = Array.isArray(m.tools) ? m.tools.map(String) : [];
      out.push({
        id: `local-mcp:${m.id}`,
        kind: 'mcp',
        source: 'local',
        name: m.name || m.id,
        description:
          tools.length > 0
            ? `${tools.length} 个工具`
            : m.transport
              ? String(m.transport)
              : 'MCP 服务',
        fromSystem: true,
        mcpId: m.id,
        mcpTools: tools,
        ...(m.transport !== undefined && { mcpTransport: m.transport }),
        mcpState: m.state,
      });
    }

    packages.forEach((pkg, idx) => {
      const name = packageName(pkg);
      out.push({
        id: `local-plugin:${idx}:${name}`,
        kind: 'plugin',
        source: 'local',
        name,
        description: '已安装的扩展包，在工作区工具链中可用',
        fromSystem: true,
        installRef: name,
      });
    });

    for (const p of plugins) {
      const already = out.some(
        (x) =>
          x.kind === 'plugin' &&
          (x.name.toLowerCase() === p.name.toLowerCase() ||
            x.id === `plugin:${p.id}`)
      );
      if (already) continue;
      const item: PluginInstalledExtension = {
        id: `plugin:${p.id}`,
        kind: 'plugin',
        source: p.source,
        name: p.name,
        description: p.description,
        fromSystem: p.fromSystem,
        installRef: p.installRef,
        pluginId: p.id,
        pluginVersion: p.version,
        pluginTools: p.declaredTools,
        pluginHooks: p.declaredHooks,
        pluginTrustLevel: p.trustLevel,
        pluginEnabled: p.enabled,
      };
      out.push(item);
    }

    for (const entry of EXTENSION_CATALOG) {
      if (!catalogInstalled.has(entry.id)) continue;
      const already = out.some(
        (x) =>
          x.name.toLowerCase() === entry.name.toLowerCase() &&
          x.kind === entry.kind
      );
      if (already) continue;
      out.push({
        id: entry.id,
        kind: entry.kind,
        source: entry.source,
        name: entry.name,
        description: entry.description,
        fromSystem: false,
        installRef: entry.installRef,
      });
    }

    return out;
  }, [skills, mcpServers, packages, catalogInstalled, plugins]);

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

  const matchQ = useCallback(
    (name: string, desc: string) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return name.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
    },
    [query],
  );

  const installedFiltered = useMemo(
    () =>
      installed.filter((item) => {
        if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
        return matchQ(item.name, item.description);
      }),
    [installed, kindFilter, matchQ]
  );

  const catalogFiltered = useMemo(
    () =>
      EXTENSION_CATALOG.filter((entry) => {
        if (kindFilter !== 'all' && entry.kind !== kindFilter) return false;
        return matchQ(entry.name, entry.description);
      }),
    [kindFilter, matchQ]
  );

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

  const handleInstallCatalog = async (entry: CatalogEntry) => {
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
        onShowToast('仅登记包名（未连接引擎安装）');
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
      onShowToast('仅标记本机已装，未连接引擎安装');
    } catch (e) {
      onShowToast(`安装失败：${errText(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleRemovePackage = async (item: InstalledExtension) => {
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
      onShowToast(`卸载失败：${errText(e)}`);
    }
  };

  const toggleMcpTool = async (
    serverId: string,
    tool: string,
    enabled: boolean
  ) => {
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
      onShowToast(`工具开关失败：${errText(e)}`);
    } finally {
      setMcpToolBusy(false);
    }
  };

  const toggleMcpServer = async (serverId: string, start: boolean) => {
    if (mcpServerBusy || !serverId) return;
    setMcpServerBusy(true);
    try {
      const r = start
        ? await startMcpServer(serverId)
        : await stopMcpServer(serverId);
      if (!r.ok) {
        onShowToast(r.error || (start ? '启动失败' : '停止失败'));
      }
      await refresh();
    } catch (e) {
      onShowToast(errText(e));
    } finally {
      setMcpServerBusy(false);
    }
  };

  /** 插件启停：持久化 + 本地状态刷新（E3 UI 泛化；E2 运行时接入后同步注册表）。 */
  const togglePlugin = useCallback(
    (pluginId: string, enabled: boolean) => {
      setPluginEnabled(pluginId, enabled);
      setPlugins((prev) =>
        prev.map((p) => (p.id === pluginId ? { ...p, enabled } : p))
      );
      onShowToast(enabled ? '插件已启用' : '插件已停用');
    },
    [onShowToast]
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
