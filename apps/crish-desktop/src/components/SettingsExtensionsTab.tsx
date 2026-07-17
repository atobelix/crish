/**
 * 设置 · 扩展：插件、MCP、技能；列表内直接查看与配置。
 */
import React, { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { clientApi, type PackageSource } from '../api/clientApi';
import {
  EXTENSION_CATALOG,
  kindLabel,
  markCatalogInstalled,
  unmarkCatalogInstalled,
  loadCatalogInstalledIds,
  isMcpToolDisabled,
  applyMcpToolDisabled,
  cacheMcpToolDisabled,
  type CatalogEntry,
  type ExtensionKind,
  type InstalledExtension,
} from '../api/extensionCatalog';
import {
  listMcpServers,
  mcpStateLabel,
  startMcpServer,
  stopMcpServer,
  type McpServerInfo,
} from '../api/mcpApi';
import { discoverSkills, type DesktopSkill } from '../api/skillsApi';
import { getWorkspacePath } from '../api/projectStore';
import { setAppSettings } from '../api/storeAccess';
import { AppErrorBoundary } from './AppErrorBoundary';
import { SettingsPage } from './settings/SettingsUI';

const SkillsSettingsTab = lazy(() =>
  import('./SkillsSettingsTab').then((m) => ({ default: m.SkillsSettingsTab })),
);
const McpSettingsTab = lazy(() =>
  import('./McpSettingsTab').then((m) => ({ default: m.McpSettingsTab })),
);

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
  } catch { /* ignore */ }
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
  } catch { /* ignore */ }
}

type Props = {
  onShowToast: (msg: string) => void;
};

type MainView = 'installed' | 'discover';
type KindFilter = 'all' | ExtensionKind;
type ManageKind = null | 'skill' | 'mcp';

/** 列表内联展开：详情预览 或 配置面板 */
type ExpandMode = 'detail' | 'config';
type ExpandTarget =
  | { scope: 'installed'; id: string; mode: ExpandMode }
  | { scope: 'catalog'; id: string; mode: ExpandMode };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function packageName(pkg: string | PackageSource): string {
  return typeof pkg === 'string' ? pkg : pkg.source;
}

export const SettingsExtensionsTab: React.FC<Props> = ({ onShowToast }) => {
  const [view, setView] = useState<MainView>('installed');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(() => loadSkillsCache().length === 0 && loadMcpServersCache().length === 0);
  const hydratedRef = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [manage, setManage] = useState<ManageKind>(null);
  const [expand, setExpand] = useState<ExpandTarget | null>(null);
  /** 安装后异步定位已装行（插件 id 与目录 id 不同） */
  const [pendingExpand, setPendingExpand] = useState<{
    name: string;
    kind: ExtensionKind;
    mode: ExpandMode;
    fallbackId: string;
  } | null>(null);
  const [toolTick, setToolTick] = useState(0);

  const [skills, setSkills] = useState<DesktopSkill[]>(() => loadSkillsCache());
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>(() => loadMcpServersCache());
  const [packages, setPackages] = useState<(string | PackageSource)[]>([]);
  const [catalogInstalled, setCatalogInstalled] = useState<Set<string>>(() =>
    loadCatalogInstalledIds(),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mcpToolBusy, setMcpToolBusy] = useState(false);
  const [mcpServerBusy, setMcpServerBusy] = useState(false);

  const cwd = getWorkspacePath() || '';

  const refresh = useCallback(async () => {
    setLoadError(null);
    // 首次进入才显示列表加载中；已有数据时后台刷新不整页卡住
    if (!hydratedRef.current && skills.length === 0 && mcpServers.length === 0) {
      setLoading(true);
    }

    const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
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
          },
        );
      });

    try {
      const [skillRes, mcpRes, settings] = await Promise.all([
        withTimeout(
          discoverSkills({ workspacePath: cwd }).catch(() => ({
            skills: [] as DesktopSkill[],
          })),
          4000,
          { skills: [] as DesktopSkill[] },
        ),
        withTimeout(
          listMcpServers().catch(() => ({ servers: [] as McpServerInfo[] })),
          4000,
          { servers: [] as McpServerInfo[] },
        ),
        withTimeout(
          clientApi.getSettingsEx(cwd || '__global__').catch(() => null),
          4000,
          null,
        ),
      ]);
      setSkills(skillRes.skills || []);
      saveSkillsCache(skillRes.skills || []);
      setMcpServers(mcpRes.servers || []);
      saveMcpServersCache(mcpRes.servers || []);
      setPackages(settings?.packages || []);
      setCatalogInstalled(loadCatalogInstalledIds());
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

    for (const s of skills) {
      out.push({
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
        mcpTransport: m.transport,
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

    for (const entry of EXTENSION_CATALOG) {
      if (!catalogInstalled.has(entry.id)) continue;
      const already = out.some(
        (x) => x.name.toLowerCase() === entry.name.toLowerCase() && x.kind === entry.kind,
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
  }, [skills, mcpServers, packages, catalogInstalled]);

  useEffect(() => {
    if (!pendingExpand) return;
    const hit = installed.find(
      (i) =>
        i.kind === pendingExpand.kind &&
        i.name.toLowerCase() === pendingExpand.name.toLowerCase(),
    );
    if (hit) {
      setExpand({ scope: 'installed', id: hit.id, mode: pendingExpand.mode });
      setPendingExpand(null);
      return;
    }
    // 目录标记项：id 即 entry.id
    if (installed.some((i) => i.id === pendingExpand.fallbackId)) {
      setExpand({
        scope: 'installed',
        id: pendingExpand.fallbackId,
        mode: pendingExpand.mode,
      });
      setPendingExpand(null);
    }
  }, [installed, pendingExpand]);

  const matchQ = (name: string, desc: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return name.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
  };

  const installedFiltered = useMemo(
    () =>
      installed.filter((item) => {
        if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
        return matchQ(item.name, item.description);
      }),
    [installed, kindFilter, query],
  );

  const catalogFiltered = useMemo(
    () =>
      EXTENSION_CATALOG.filter((entry) => {
        if (kindFilter !== 'all' && entry.kind !== kindFilter) return false;
        return matchQ(entry.name, entry.description);
      }),
    [kindFilter, query],
  );

  const toggleExpand = (
    scope: 'installed' | 'catalog',
    id: string,
    mode: ExpandMode,
  ) => {
    setExpand((prev) => {
      if (prev && prev.scope === scope && prev.id === id && prev.mode === mode) {
        return null;
      }
      return { scope, id, mode };
    });
  };

  const isExpanded = (
    scope: 'installed' | 'catalog',
    id: string,
    mode?: ExpandMode,
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
        const merged = await clientApi.saveSettingsEx(cwd || '__global__', 'global', {
          packages: list,
        });
        setPackages(merged.packages || list);
        setAppSettings(merged);
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
          (p, i) => `local-plugin:${i}:${packageName(p)}` === item.id,
        );
        if (idx >= 0) {
          const list = packages.filter((_, i) => i !== idx);
          const merged = await clientApi.saveSettingsEx(cwd || '__global__', 'global', {
            packages: list,
          });
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

  const toggleMcpTool = async (serverId: string, tool: string, enabled: boolean) => {
    if (mcpToolBusy) return;
    setMcpToolBusy(true);
    try {
      const sets = await clientApi.getSettingsEx(cwd || '__global__');
      const prev = sets?.mcpDisabledTools || {};
      const next = applyMcpToolDisabled(prev, serverId, tool, !enabled);
      const merged = await clientApi.saveSettingsEx(cwd || '__global__', 'global', {
        mcpDisabledTools: next,
      });
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

  const kindFilters: { id: KindFilter; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'plugin', label: '插件' },
    { id: 'mcp', label: 'MCP' },
    { id: 'skill', label: '技能' },
  ];

  const renderSkillBody = (item: InstalledExtension | CatalogEntry, mode: ExpandMode) => {
    const isInstalled = 'skillPath' in item || 'skillRaw' in item;
    const installedItem = isInstalled ? (item as InstalledExtension) : null;
    const entry = !isInstalled ? (item as CatalogEntry) : null;
    if (mode === 'detail') {
      return (
        <div className="ext-inline-panel">
          {installedItem?.skillPath ? (
            <div className="ext-detail-meta" title={installedItem.skillPath}>
              {installedItem.skillPath}
            </div>
          ) : null}
          <pre className="ext-detail-md" tabIndex={0}>
            {(installedItem &&
              (installedItem.skillRaw ||
                installedItem.skillContent ||
                '# 暂无 SKILL.md 内容')) ||
              (entry
                ? `# ${entry.name}\n\n${entry.description}\n\n安装后可在本机技能目录中查看完整 SKILL.md。`
                : '# 暂无内容')}
          </pre>
        </div>
      );
    }
    // 配置：系统技能 → 高级；目录项提示
    return (
      <div className="ext-inline-panel">
        <p className="ext-detail-desc">
          {installedItem?.fromSystem
            ? '可在高级管理中编辑路径、同步与更多选项。'
            : '安装后的技能可在本机技能目录维护；高级入口提供完整管理。'}
        </p>
        <div className="ext-detail-actions">
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
            onClick={() => setManage('skill')}
          >
            高级管理
          </button>
        </div>
      </div>
    );
  };

  const renderMcpBody = (item: InstalledExtension | CatalogEntry, mode: ExpandMode) => {
    const installedItem =
      'mcpId' in item || 'mcpTools' in item ? (item as InstalledExtension) : null;
    const entry = !installedItem ? (item as CatalogEntry) : null;

    if (mode === 'detail') {
      return (
        <div className="ext-inline-panel">
          {installedItem ? (
            <div className="ext-detail-meta">
              {[
                installedItem.mcpState
                  ? `状态 ${mcpStateLabel(installedItem.mcpState)}`
                  : null,
                installedItem.mcpTransport
                  ? `传输 ${installedItem.mcpTransport}`
                  : null,
                installedItem.mcpTools?.length
                  ? `${installedItem.mcpTools.length} 个工具`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ') || '本机 MCP 服务'}
            </div>
          ) : (
            <p className="ext-detail-desc">
              {entry?.description}
              {entry?.installRef ? `\n引用：${entry.installRef}` : ''}
            </p>
          )}
          {installedItem?.mcpTools && installedItem.mcpTools.length > 0 ? (
            <ul className="ext-inline-tool-preview">
              {installedItem.mcpTools.slice(0, 12).map((t) => (
                <li key={t}>{t}</li>
              ))}
              {installedItem.mcpTools.length > 12 ? (
                <li>…共 {installedItem.mcpTools.length} 个</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      );
    }

    // 配置：启停 + 工具开关
    return (
      <div className="ext-inline-panel">
        {installedItem?.mcpId ? (
          <div className="ext-detail-actions">
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
              disabled={mcpServerBusy}
              onClick={() => void toggleMcpServer(installedItem.mcpId!, true)}
            >
              {mcpServerBusy ? '…' : '启动服务'}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
              disabled={mcpServerBusy}
              onClick={() => void toggleMcpServer(installedItem.mcpId!, false)}
            >
              停止服务
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
              onClick={() => setManage('mcp')}
            >
              高级管理
            </button>
          </div>
        ) : (
          <p className="ext-detail-desc">安装并连接后可在此启停服务与开关工具。</p>
        )}
        {installedItem?.mcpTools && installedItem.mcpTools.length > 0 ? (
          <div className="ext-tool-list" role="list" aria-label="MCP 工具">
            {installedItem.mcpTools.map((tool) => {
              void toolTick;
              const serverId = installedItem.mcpId || installedItem.id;
              const off = isMcpToolDisabled(serverId, tool);
              return (
                <div
                  key={tool}
                  className={`ext-tool-row${off ? ' is-off' : ''}`}
                  role="listitem"
                >
                  <span className="ext-tool-name" title={tool}>
                    {tool}
                  </span>
                  <label className="settings-list-control">
                    <span className="ext-detail-meta" style={{ marginRight: 8 }}>
                      {off ? '禁用' : '启用'}
                    </span>
                    <input
                      type="checkbox"
                      className="settings-switch"
                      checked={!off}
                      disabled={mcpToolBusy}
                      onChange={(e) => {
                        void toggleMcpTool(serverId, tool, e.target.checked);
                      }}
                      aria-label={`${off ? '启用' : '禁用'}工具 ${tool}`}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        ) : installedItem ? (
          <div className="ext-empty" role="status" style={{ padding: '12px 0' }}>
            暂无上报工具 · 启动服务后刷新
          </div>
        ) : null}
      </div>
    );
  };

  const renderPluginBody = (item: InstalledExtension | CatalogEntry, mode: ExpandMode) => {
    const name = item.name;
    const desc = item.description;
    const ref =
      'installRef' in item && item.installRef
        ? item.installRef
        : undefined;
    return (
      <div className="ext-inline-panel">
        <div className="ext-detail-md" style={{ fontFamily: 'var(--font-sans)' }}>
          {desc}
          {'\n\n'}
          {mode === 'config'
            ? '此插件已安装，可在任务与对话流程中使用。'
            : '安装后会写入本机扩展包列表，供工作台加载。'}
          {ref ? `\n\n引用：${ref}` : ''}
          {`\n名称：${name}`}
        </div>
      </div>
    );
  };

  const renderExpandBody = (
    kind: ExtensionKind,
    item: InstalledExtension | CatalogEntry,
    mode: ExpandMode,
  ) => {
    if (kind === 'skill') return renderSkillBody(item, mode);
    if (kind === 'mcp') return renderMcpBody(item, mode);
    return renderPluginBody(item, mode);
  };

  // —— 全页内嵌：技能/MCP 高级管理 ——
  if (manage === 'skill' || manage === 'mcp') {
    const label = manage === 'skill' ? '技能' : 'MCP';
    return (
      <SettingsPage
        title={label}
        meta={
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
            onClick={() => {
              setManage(null);
              void refresh();
            }}
          >
            <Lucide.ArrowLeft size={14} aria-hidden />
            返回扩展
          </button>
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
              <SkillsSettingsTab onShowToast={onShowToast} />
            ) : (
              <McpSettingsTab onShowToast={onShowToast} />
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
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="刷新"
          >
            <Lucide.RefreshCw
              size={14}
              className={loading ? 'spin' : undefined}
              aria-hidden
            />
          </button>
        </div>
      }
    >

      <div className="ext-toolbar ext-toolbar--one" role="group" aria-label="筛选">
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

      {view === 'installed' ? (
        <div className="ext-list ext-list--cards" role="list" aria-label="已安装">
          {loading && installedFiltered.length === 0 ? (
            <div className="ext-empty" role="status">
              加载中…
            </div>
          ) : installedFiltered.length === 0 ? (
            <div className="ext-empty" role="status">
              {query || kindFilter !== 'all' ? '没有匹配的扩展' : '还没有安装扩展'}
              {!(query || kindFilter !== 'all') ? (
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
                  onClick={() => setView('discover')}
                >
                  去发现
                </button>
              ) : null}
            </div>
          ) : (
            installedFiltered.map((item) => {
              const canUninstall =
                item.id.startsWith('local-plugin:') || !item.fromSystem;
              const detailOpen = isExpanded('installed', item.id, 'detail');
              const configOpen = isExpanded('installed', item.id, 'config');
              return (
                <div
                  key={item.id}
                  className={`ext-row-block${
                    detailOpen || configOpen ? ' is-expanded' : ''
                  }`}
                  role="listitem"
                >
                  <div className="ext-row ext-row--card ext-row--static">
                    <div className="ext-row-main">
                      <div className="ext-row-title-line">
                        <span className="ext-kind-badge">{kindLabel(item.kind)}</span>
                        <span className="ext-row-name">{item.name}</span>
                        <span className="ext-source-badge">
                          {item.source === 'official'
                            ? '官方'
                            : item.source === 'community'
                              ? '三方'
                              : '本机'}
                        </span>
                      </div>
                      <div className="ext-row-desc">{item.description}</div>
                    </div>
                    <div className="ext-row-actions">
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
                        aria-expanded={detailOpen}
                        onClick={() => toggleExpand('installed', item.id, 'detail')}
                      >
                        {detailOpen ? '收起' : '详情'}
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
                        aria-expanded={configOpen}
                        onClick={() => toggleExpand('installed', item.id, 'config')}
                      >
                        {configOpen ? '收起' : '配置'}
                      </button>
                      {canUninstall ? (
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect danger"
                          onClick={() => void handleRemovePackage(item)}
                        >
                          卸载
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {detailOpen
                    ? renderExpandBody(item.kind, item, 'detail')
                    : null}
                  {configOpen
                    ? renderExpandBody(item.kind, item, 'config')
                    : null}
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="ext-list ext-list--cards" role="list" aria-label="发现">
          {catalogFiltered.length === 0 ? (
            <div className="ext-empty" role="status">
              没有匹配的扩展
            </div>
          ) : (
            catalogFiltered.map((entry) => {
              const installedMark =
                catalogInstalled.has(entry.id) ||
                installed.some(
                  (i) =>
                    i.kind === entry.kind &&
                    i.name.toLowerCase() === entry.name.toLowerCase(),
                );
              const detailOpen = isExpanded('catalog', entry.id, 'detail');
              return (
                <div
                  key={entry.id}
                  className={`ext-row-block${detailOpen ? ' is-expanded' : ''}`}
                  role="listitem"
                >
                  <div className="ext-row ext-row--card ext-row--static">
                    <div className="ext-row-main">
                      <div className="ext-row-title-line">
                        <span className="ext-kind-badge">{kindLabel(entry.kind)}</span>
                        <span className="ext-row-name">{entry.name}</span>
                        <span className="ext-source-badge">
                          {entry.source === 'official' ? '官方' : '三方'}
                        </span>
                        {installedMark ? (
                          <span className="ext-installed-mark">已装</span>
                        ) : null}
                      </div>
                      <div className="ext-row-desc">{entry.description}</div>
                    </div>
                    <div className="ext-row-actions">
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
                        aria-expanded={detailOpen}
                        onClick={() => toggleExpand('catalog', entry.id, 'detail')}
                      >
                        {detailOpen ? '收起' : '详情'}
                      </button>
                      {installedMark ? (
                        <button
                          type="button"
                          className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
                          onClick={() => {
                            setView('installed');
                            setExpand({
                              scope: 'installed',
                              id: entry.id,
                              mode: 'config',
                            });
                          }}
                        >
                          去配置
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
                          disabled={busyId === entry.id}
                          onClick={() => void handleInstallCatalog(entry)}
                        >
                          {busyId === entry.id ? '安装中…' : '安装'}
                        </button>
                      )}
                    </div>
                  </div>
                  {detailOpen
                    ? renderExpandBody(entry.kind, entry, 'detail')
                    : null}
                </div>
              );
            })
          )}
        </div>
      )}
    </SettingsPage>
  );
};
