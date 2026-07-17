/**
 * 设置 · 扩展服务（MCP）：单行密度列表 / 状态 / 启停 / 工具展开
 * 正式：仅引擎 list；启停仅在 probe 允许时可用
 * 演示：localStorage mock
 * 行内状态即反馈；仅错误 toast，成功静默（禁启停教育 toast / 成功 spam）
 */
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  listMcpServers,
  mcpStateKind,
  mcpStateLabel,
  probeMcpControl,
  startMcpServer,
  stopMcpServer,
  type McpServerInfo,
  type McpStatusSnapshot,
} from '../api/mcpApi';
import { isDemoMode } from '../api/appMode';
import { clientApi, type McpServer } from '../api/clientApi';
import { SettingsSelect } from './SettingsSelect';

type Props = {
  onShowToast?: (msg: string) => void;
  /** 通知父级是否“有可展示 MCP”，用于导航等 */
  onAvailabilityChange?: (available: boolean) => void;
};

type SortMode = 'name' | 'state';

const START_STOP_HINT =
  '当前引擎不支持从界面启停；扩展服务通常随任务运行时连接';

/** 正式空列表诚实说明（未配置 / 无实例） */
const EMPTY_LIVE_HINT_UNCONFIGURED =
  '引擎侧暂未配置扩展服务；任务运行时若连接 MCP 会显示在此';
const EMPTY_LIVE_HINT_CONFIGURED =
  '已配置但当前无实例；扩展服务通常随任务运行时连接';
const EMPTY_DEMO_HINT = '演示模式可本地添加 mock 服务，不会写入引擎';
const EMPTY_FILTER_HINT = '调整关键词或清除筛选';

/** 状态排序权重：运行中优先，错误次之，空闲靠后 */
const STATE_SORT_RANK: Record<string, number> = {
  ok: 0,
  warn: 1,
  err: 2,
  idle: 3,
};

/** 传输类型短标签（主文案可保留协议名，title 用中文） */
function transportLabel(raw?: string): string {
  if (!raw) return '';
  const t = raw.toLowerCase();
  if (t === 'stdio') return 'stdio';
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamable-http') return raw;
  return raw;
}

function transportTitle(raw?: string): string | undefined {
  if (!raw) return undefined;
  const t = raw.toLowerCase();
  if (t === 'stdio') return '标准输入输出（stdio）';
  if (t === 'sse') return '服务端推送（SSE）';
  if (t === 'http') return 'HTTP';
  if (t === 'streamable-http') return '可流式 HTTP';
  return raw;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  return String(e ?? '');
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export const McpSettingsTab: React.FC<Props> = ({ onShowToast, onAvailabilityChange }) => {
  const demo = isDemoMode();
  const listLabelId = useId();
  const statusBarId = useId();
  const toolsPanelPrefix = useId();

  const [loading, setLoading] = useState(true);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [status, setStatus] = useState<McpStatusSnapshot | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('name');
  /** 正式：界面启停是否可用 */
  const [canStartStop, setCanStartStop] = useState(false);
  const [controlHint, setControlHint] = useState<string | undefined>();

  // demo 本地 mock
  const [demoServers, setDemoServers] = useState<McpServer[]>([]);
  const [demoEnabled, setDemoEnabled] = useState<Record<string, boolean>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'stdio' | 'sse'>('stdio');
  const [newCmd, setNewCmd] = useState('');
  const [newArgs, setNewArgs] = useState('');
  const [newUrl, setNewUrl] = useState('');

  const refreshLive = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listMcpServers();
      const probe = await probeMcpControl(r);
      setServers(r.servers);
      setStatus(r.status);
      setCanStartStop(probe.canStartStop);
      setControlHint(probe.message);
      if (!r.ok && r.error) {
        // 连接/列表失败：行内展示，不 toast 刷屏
        setError(r.error);
      } else if (!probe.canList && probe.message) {
        setError(probe.message);
      }
      onAvailabilityChange?.(r.configured || r.servers.length > 0);
    } catch (e) {
      setError(errText(e) || '读取扩展服务失败');
      setCanStartStop(false);
      onAvailabilityChange?.(false);
    } finally {
      setLoading(false);
    }
  }, [onAvailabilityChange]);

  const refreshDemo = useCallback(async () => {
    setLoading(true);
    try {
      const list = await clientApi.getMcpServers();
      setDemoServers(list);
      setDemoEnabled((prev) => {
        const next = { ...prev };
        for (const s of list) {
          if (next[s.id] === undefined) next[s.id] = true;
        }
        return next;
      });
      onAvailabilityChange?.(list.length > 0);
    } catch (e) {
      // 演示加载失败：仅错误 toast
      onShowToast?.(`加载失败：${errText(e) || '未知错误'}`);
      onAvailabilityChange?.(false);
    } finally {
      setLoading(false);
    }
  }, [onAvailabilityChange, onShowToast]);

  useEffect(() => {
    if (demo) void refreshDemo();
    else void refreshLive();
  }, [demo, refreshDemo, refreshLive]);

  const handleCopy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      // 成功静默；仅失败 toast
      if (!ok) onShowToast?.('复制失败');
    },
    [onShowToast],
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = servers;
    if (q) {
      list = servers.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.tools.some((t) => t.toLowerCase().includes(q)) ||
          (s.transport || '').toLowerCase().includes(q) ||
          (s.lastError || '').toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    if (sortMode === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    } else {
      sorted.sort((a, b) => {
        const ka = STATE_SORT_RANK[mcpStateKind(a.state)] ?? 9;
        const kb = STATE_SORT_RANK[mcpStateKind(b.state)] ?? 9;
        if (ka !== kb) return ka - kb;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
    }
    return sorted;
  }, [servers, filter, sortMode]);

  const filteredDemo = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = demoServers;
    if (q) {
      list = demoServers.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          (s.command || '').toLowerCase().includes(q) ||
          (s.url || '').toLowerCase().includes(q) ||
          (s.type || '').toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    if (sortMode === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    } else {
      sorted.sort((a, b) => {
        const onA = demoEnabled[a.id] !== false ? 0 : 1;
        const onB = demoEnabled[b.id] !== false ? 0 : 1;
        if (onA !== onB) return onA - onB;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
    }
    return sorted;
  }, [demoServers, filter, sortMode, demoEnabled]);

  const setSort = useCallback((mode: SortMode) => {
    setSortMode((prev) => (prev === mode ? prev : mode));
  }, []);

  const clearFilter = useCallback(() => setFilter(''), []);

  const handleStart = async (id: string) => {
    // 启停不可用：状态条 + 禁用按钮 title 即反馈，禁教育性 toast
    if (!canStartStop) return;
    setBusyId(id);
    try {
      const r = await startMcpServer(id);
      if (!r.ok) {
        if (r.errorCode === 'unsupported') {
          setCanStartStop(false);
          setControlHint(r.error || START_STOP_HINT);
          // 能力不可用：状态条切「启停不可用」，不 toast 说明书
        } else {
          // 连接/启动失败：仅错误 toast
          onShowToast?.(r.error ? `启动失败：${r.error}` : '启动失败');
        }
        await refreshLive();
        return;
      }
      // 成功：列表状态即反馈，静默
      await refreshLive();
    } catch (e) {
      onShowToast?.(`启动失败：${errText(e) || '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (id: string) => {
    // 启停不可用：状态条 + 禁用按钮 title 即反馈，禁教育性 toast
    if (!canStartStop) return;
    setBusyId(id);
    try {
      const r = await stopMcpServer(id);
      if (!r.ok) {
        if (r.errorCode === 'unsupported') {
          setCanStartStop(false);
          setControlHint(r.error || START_STOP_HINT);
        } else {
          onShowToast?.(r.error ? `停止失败：${r.error}` : '停止失败');
        }
        await refreshLive();
        return;
      }
      await refreshLive();
    } catch (e) {
      onShowToast?.(`停止失败：${errText(e) || '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleAddDemo = async () => {
    if (!newName.trim()) return;
    try {
      const server: McpServer = {
        id: `mcp-${Date.now()}`,
        name: newName.trim(),
        type: newType,
        command: newType === 'stdio' ? newCmd.trim() : undefined,
        args:
          newType === 'stdio'
            ? newArgs
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean)
            : undefined,
        url: newType === 'sse' ? newUrl.trim() : undefined,
        status: 'disconnected',
        tools: [],
      };
      const list = await clientApi.saveMcpServer(server);
      setDemoServers(list);
      setDemoEnabled((p) => ({ ...p, [server.id]: true }));
      onAvailabilityChange?.(list.length > 0);
      setShowAdd(false);
      setNewName('');
      setNewCmd('');
      setNewArgs('');
      setNewUrl('');
      // 成功静默
    } catch (e) {
      onShowToast?.(`保存失败：${errText(e) || '未知错误'}`);
    }
  };

  const handleDeleteDemo = async (id: string) => {
    try {
      const list = await clientApi.deleteMcpServer(id);
      setDemoServers(list);
      setDemoEnabled((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
      onAvailabilityChange?.(list.length > 0);
      // 成功静默
    } catch (e) {
      onShowToast?.(`删除失败：${errText(e) || '未知错误'}`);
    }
  };

  const refresh = demo ? refreshDemo : refreshLive;
  const stopHint = controlHint || START_STOP_HINT;
  const filterActive = filter.trim().length > 0;
  const demoEnabledCount = demoServers.filter((s) => demoEnabled[s.id] !== false).length;

  const liveEmptyHint = status?.configured
    ? EMPTY_LIVE_HINT_CONFIGURED
    : EMPTY_LIVE_HINT_UNCONFIGURED;

  const toolbar = (
    <div className="mcp-toolbar" role="toolbar" aria-label="扩展服务工具栏">
      <button
        type="button"
        className="ui-btn ui-btn-ghost ui-btn-sm"
        onClick={() => void refresh()}
        disabled={loading}
        title={loading ? '刷新中…' : '刷新列表'}
        aria-label={loading ? '刷新中' : '刷新列表'}
        aria-busy={loading || undefined}
      >
        <Lucide.RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden />
      </button>
      <div className="ui-segment ui-segment--inline settings-segment-pill" role="group" aria-label="排序方式">
        <button
          type="button"
          className={`ui-segment-item ${sortMode === 'name' ? 'active' : ''}`}
          onClick={() => setSort('name')}
          aria-pressed={sortMode === 'name'}
          title="按名称排序"
        >
          名称
        </button>
        <button
          type="button"
          className={`ui-segment-item ${sortMode === 'state' ? 'active' : ''}`}
          onClick={() => setSort('state')}
          aria-pressed={sortMode === 'state'}
          title={demo ? '按启用状态排序' : '按运行状态排序'}
        >
          状态
        </button>
      </div>
      <input
        className="settings-field-input settings-field-input--sm mcp-search"
        placeholder="搜索名称、标识…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && filter) {
            e.preventDefault();
            clearFilter();
          }
        }}
        aria-label="搜索扩展服务"
        title="搜索名称、标识或工具；Esc 清除"
      />
      {demo ? (
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-sm"
          onClick={() => setShowAdd((v) => !v)}
          title={showAdd ? '收起添加表单' : '添加演示服务'}
          aria-label={showAdd ? '收起添加表单' : '添加演示服务'}
          aria-expanded={showAdd}
        >
          <Lucide.Plus size={14} aria-hidden />
          {showAdd ? '收起' : '添加'}
        </button>
      ) : null}
    </div>
  );

  const renderTools = (srv: McpServerInfo, panelId: string) => {
    const toolN = srv.toolCount ?? srv.tools.length;
    return (
      <div className="mcp-tools" id={panelId} role="region" aria-label={`${srv.name} 的工具`}>
        {srv.tools.length === 0 ? (
          <div className="mcp-tools-empty" role="status">
            {toolN > 0 ? `工具 ${toolN}（未返回名称）` : '暂无工具'}
          </div>
        ) : (
          <ul>
            {srv.tools.map((t) => (
              <li key={t}>
                <Lucide.Wrench size={12} aria-hidden />
                <button
                  type="button"
                  className="mcp-inline-copy"
                  title="复制工具名"
                  aria-label={`复制工具名 ${t}`}
                  onClick={() => void handleCopy(t)}
                >
                  <code>{t}</code>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mcp-card-id">
          标识{' '}
          <button
            type="button"
            className="mcp-inline-copy"
            title="复制标识"
            aria-label={`复制标识 ${srv.id}`}
            onClick={() => void handleCopy(srv.id)}
          >
            <code>{srv.id}</code>
          </button>
        </div>
      </div>
    );
  };

  const renderFilterEmpty = (hasAny: boolean) => {
    if (loading) {
      return (
        <div className="mcp-empty-line" role="status" aria-live="polite" aria-busy="true">
          <span>加载中…</span>
        </div>
      );
    }
    if (!hasAny) return null;
    if (!filterActive) return null;
    return (
      <div className="mcp-empty-line" role="status" aria-live="polite" title={EMPTY_FILTER_HINT}>
        <span>无匹配</span>
        <button
          type="button"
          className="ui-btn ui-btn-ghost ui-btn-sm"
          onClick={clearFilter}
          title={EMPTY_FILTER_HINT}
          aria-label="清除筛选"
        >
          清除筛选
        </button>
      </div>
    );
  };

  /* ───────── 演示模式 ───────── */
  if (demo) {
    return (
      <div className="settings-pane settings-pane--modern mcp-tab">
        <header className="settings-page-head">
          <div className="mcp-head-row">
            <h2 className="settings-page-title" id={listLabelId}>
              扩展服务
            </h2>
            <div
              className="mcp-status-bar"
              id={statusBarId}
              role="status"
              aria-live="polite"
              aria-label="状态"
            >
              <span className="mcp-status-pill" title="本地演示数据，不写入引擎">
                演示
              </span>
              <span className="mcp-status-pill" title={`共 ${demoServers.length} 个服务`}>
                服务 {demoServers.length}
              </span>
              <span
                className={`mcp-status-pill ${demoEnabledCount > 0 ? 'is-on' : ''}`}
                title={`已启用 ${demoEnabledCount}`}
              >
                启用 {demoEnabledCount}
              </span>
              {filterActive ? (
                <span className="mcp-status-pill" title="当前筛选结果数">
                  显示 {filteredDemo.length}
                </span>
              ) : null}
              {loading ? (
                <span className="mcp-status-pill" aria-busy="true">
                  刷新中…
                </span>
              ) : null}
            </div>
          </div>
        </header>

        {toolbar}

        {showAdd ? (
          <div className="mcp-add-box" role="form" aria-label="注册演示服务">
            <div className="mcp-add-row">
              <input
                className="settings-field-input settings-field-input--sm"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="名称"
                aria-label="名称"
                aria-required
                autoFocus
              />
              <SettingsSelect
                className="mcp-add-type-select"
                value={newType}
                options={[
                  { value: 'stdio', label: 'stdio', hint: transportTitle('stdio') },
                  { value: 'sse', label: 'sse', hint: transportTitle('sse') },
                ]}
                onChange={(v) => setNewType(v as 'stdio' | 'sse')}
              />
              {newType === 'stdio' ? (
                <>
                  <input
                    className="settings-field-input settings-field-input--sm"
                    value={newCmd}
                    onChange={(e) => setNewCmd(e.target.value)}
                    placeholder="命令"
                    aria-label="启动命令"
                    title="stdio 启动命令"
                  />
                  <input
                    className="settings-field-input settings-field-input--sm"
                    value={newArgs}
                    onChange={(e) => setNewArgs(e.target.value)}
                    placeholder="参数（逗号分隔）"
                    aria-label="参数，逗号分隔"
                    title="参数（逗号分隔）"
                  />
                </>
              ) : (
                <input
                  className="settings-field-input settings-field-input--sm mcp-add-url"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="端点 URL"
                  aria-label="端点 URL"
                  title="SSE 端点地址"
                />
              )}
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => setShowAdd(false)}
                aria-label="取消添加"
              >
                取消
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={!newName.trim()}
                onClick={() => void handleAddDemo()}
                aria-label="保存演示服务"
                title={!newName.trim() ? '请先填写名称' : '保存到本地演示列表'}
              >
                保存
              </button>
            </div>
          </div>
        ) : null}

        <div
          className="mcp-list"
          role="list"
          aria-labelledby={listLabelId}
          aria-label="服务列表"
          aria-busy={loading || undefined}
        >
          {filteredDemo.map((srv) => {
            const on = demoEnabled[srv.id] !== false;
            const typeTitle = transportTitle(srv.type);
            return (
              <div key={srv.id} className="mcp-row" role="listitem">
                <div className="mcp-row-main">
                  <span
                    className={`mcp-dot kind-${on ? 'ok' : 'idle'}`}
                    aria-hidden
                    title={on ? '已启用' : '已禁用'}
                  />
                  <button
                    type="button"
                    className="mcp-row-name mcp-inline-copy"
                    title={`复制标识 ${srv.id}`}
                    aria-label={`复制标识 ${srv.name}`}
                    onClick={() => void handleCopy(srv.id)}
                  >
                    {srv.name}
                  </button>
                  <span className={`mcp-state-badge kind-${on ? 'ok' : 'idle'}`}>
                    {on ? '启用' : '禁用'}
                  </span>
                  <span className="mcp-row-meta" title={typeTitle}>
                    {transportLabel(srv.type)}
                    {srv.command ? ` · ${srv.command}` : ''}
                    {srv.url ? ` · ${srv.url}` : ''}
                  </span>
                  <div className="mcp-row-actions">
                    <input
                      type="checkbox"
                      className="settings-switch"
                      checked={on}
                      title={on ? '禁用' : '启用'}
                      aria-label={on ? `禁用 ${srv.name}` : `启用 ${srv.name}`}
                      onChange={() => setDemoEnabled((p) => ({ ...p, [srv.id]: !on }))}
                    />
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      title="删除"
                      aria-label={`删除 ${srv.name}`}
                      onClick={() => void handleDeleteDemo(srv.id)}
                    >
                      <Lucide.Trash2 size={14} aria-hidden />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {!loading && demoServers.length === 0 ? (
            <div
              className="mcp-empty-line"
              role="status"
              aria-live="polite"
              title={EMPTY_DEMO_HINT}
            >
              <span>暂无服务</span>
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => setShowAdd(true)}
                aria-label="添加演示服务"
                title={EMPTY_DEMO_HINT}
              >
                <Lucide.Plus size={14} aria-hidden />
                添加
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => void refreshDemo()}
                disabled={loading}
                aria-label="刷新列表"
              >
                <Lucide.RefreshCw size={14} aria-hidden />
                刷新
              </button>
            </div>
          ) : null}
          {!loading && demoServers.length > 0 && filteredDemo.length === 0
            ? renderFilterEmpty(true)
            : null}
          {loading && demoServers.length === 0 ? renderFilterEmpty(true) : null}
        </div>
      </div>
    );
  }

  /* ───────── 正式 / 引擎模式 ───────── */
  return (
    <div className="settings-pane settings-pane--modern mcp-tab">
      <header className="settings-page-head">
        <div className="mcp-head-row">
          <h2 className="settings-page-title" id={listLabelId}>
            扩展服务
          </h2>
          <div
            className="mcp-status-bar"
            id={statusBarId}
            role="status"
            aria-live="polite"
            aria-label="状态"
          >
            <span
              className={`mcp-status-pill ${status?.configured ? 'is-on' : ''}`}
              title={
                status?.configured
                  ? '引擎已配置扩展服务'
                  : '引擎侧未配置扩展服务'
              }
            >
              {status?.configured ? '已配置' : '未配置'}
            </span>
            {status?.readiness ? (
              <span
                className={`mcp-status-pill kind-${mcpStateKind(status.readiness)}`}
                title={`就绪：${mcpStateLabel(status.readiness)}`}
              >
                {mcpStateLabel(status.readiness)}
              </span>
            ) : null}
            <span className="mcp-status-pill" title={`共 ${servers.length} 个服务`}>
              服务 {servers.length}
            </span>
            <span
              className={`mcp-status-pill ${canStartStop ? 'is-on' : ''}`}
              title={canStartStop ? '可从界面启动/停止' : stopHint}
            >
              {canStartStop ? '启停可用' : '启停不可用'}
            </span>
            {filterActive ? (
              <span className="mcp-status-pill" title="当前筛选结果数">
                显示 {filtered.length}
              </span>
            ) : null}
            {loading ? (
              <span className="mcp-status-pill" aria-busy="true">
                刷新中…
              </span>
            ) : null}
          </div>
        </div>
      </header>

      {toolbar}

      {error ? (
        <div className="mcp-error-line" role="alert" title={error}>
          {error}
        </div>
      ) : null}

      <div
        className="mcp-list"
        role="list"
        aria-labelledby={listLabelId}
        aria-label="服务列表"
        aria-busy={loading || undefined}
      >
        {filtered.map((srv) => {
          const kind = mcpStateKind(srv.state);
          const isOpen = !!expanded[srv.id];
          const running =
            kind === 'ok' ||
            srv.state === 'starting' ||
            srv.state === 'ready' ||
            srv.state === 'running';
          const toolN = srv.toolCount ?? srv.tools.length;
          const panelId = `${toolsPanelPrefix}-${srv.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          const busy = busyId === srv.id;
          const tp = transportLabel(srv.transport);
          const tpTitle = transportTitle(srv.transport);

          return (
            <div key={srv.id} className="mcp-row" role="listitem">
              <div className="mcp-row-main">
                <span
                  className={`mcp-dot kind-${kind}`}
                  aria-hidden
                  title={mcpStateLabel(srv.state)}
                />
                <button
                  type="button"
                  className="mcp-row-name mcp-inline-copy"
                  title={`复制标识 ${srv.id}`}
                  aria-label={`复制标识 ${srv.name}`}
                  onClick={() => void handleCopy(srv.id)}
                >
                  {srv.name}
                </button>
                <span className={`mcp-state-badge kind-${kind}`} title={mcpStateLabel(srv.state)}>
                  {mcpStateLabel(srv.state)}
                </span>
                <span className="mcp-row-meta" title={tpTitle}>
                  {tp ? `${tp} · ` : ''}
                  工具 {toolN}
                  {srv.lastError ? (
                    <span className="mcp-row-err" title={srv.lastError}>
                      {' '}
                      · 错误
                    </span>
                  ) : null}
                </span>
                <div className="mcp-row-actions">
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    title={isOpen ? '收起工具' : `展开工具（${toolN}）`}
                    aria-label={isOpen ? `收起 ${srv.name} 的工具` : `展开 ${srv.name} 的工具 ${toolN}`}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => setExpanded((p) => ({ ...p, [srv.id]: !isOpen }))}
                  >
                    {isOpen ? (
                      <Lucide.ChevronUp size={14} aria-hidden />
                    ) : (
                      <Lucide.ChevronDown size={14} aria-hidden />
                    )}
                  </button>
                  {canStartStop ? (
                    running ? (
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm"
                        disabled={busy}
                        title={busy ? '停止中…' : '停止'}
                        aria-label={`停止 ${srv.name}`}
                        aria-busy={busy || undefined}
                        onClick={() => void handleStop(srv.id)}
                      >
                        <Lucide.Square size={14} aria-hidden />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary ui-btn-sm"
                        disabled={busy}
                        title={busy ? '启动中…' : '启动'}
                        aria-label={`启动 ${srv.name}`}
                        aria-busy={busy || undefined}
                        onClick={() => void handleStart(srv.id)}
                      >
                        <Lucide.Play size={14} aria-hidden />
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      disabled
                      title={stopHint}
                      aria-label={running ? '停止不可用' : '启动不可用'}
                    >
                      {running ? (
                        <Lucide.Square size={14} aria-hidden />
                      ) : (
                        <Lucide.Play size={14} aria-hidden />
                      )}
                    </button>
                  )}
                </div>
              </div>
              {isOpen ? renderTools(srv, panelId) : null}
            </div>
          );
        })}

        {!loading && servers.length === 0 ? (
          <div
            className="mcp-empty-line"
            role="status"
            aria-live="polite"
            title={liveEmptyHint}
          >
            <span title={liveEmptyHint}>
              {status?.configured ? '暂无服务实例' : '暂无扩展服务'}
            </span>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              onClick={() => void refreshLive()}
              disabled={loading}
              aria-label="刷新列表"
              title="重新向引擎查询列表"
            >
              <Lucide.RefreshCw size={14} aria-hidden />
              刷新
            </button>
          </div>
        ) : null}
        {!loading && servers.length > 0 && filtered.length === 0
          ? renderFilterEmpty(true)
          : null}
        {loading && servers.length === 0 ? (
          <div className="mcp-empty-line" role="status" aria-live="polite" aria-busy="true">
            <span>加载中…</span>
          </div>
        ) : null}
      </div>
    </div>
  );
};
