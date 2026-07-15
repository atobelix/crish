/**
 * 设置 · 扩展服务（MCP）：列表 / 状态 / 启停 / 工具展开
 * 正式：仅引擎 list；启停仅在 probe 允许时展示
 * 演示：localStorage mock，不污染正式
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

type Props = {
  onShowToast?: (msg: string) => void;
  /** 通知父级是否“有可展示 MCP”，用于导航等 */
  onAvailabilityChange?: (available: boolean) => void;
};

const START_STOP_HINT =
  '当前引擎不支持从界面启停；MCP 通常随任务运行时连接';

export const McpSettingsTab: React.FC<Props> = ({ onShowToast, onAvailabilityChange }) => {
  const demo = isDemoMode();
  const [loading, setLoading] = useState(true);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [status, setStatus] = useState<McpStatusSnapshot | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
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
        setError(r.error);
      } else if (!probe.canList && probe.message) {
        setError(probe.message);
      }
      onAvailabilityChange?.(r.configured || r.servers.length > 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
    } finally {
      setLoading(false);
    }
  }, [onAvailabilityChange]);

  useEffect(() => {
    if (demo) void refreshDemo();
    else void refreshLive();
  }, [demo, refreshDemo, refreshLive]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.tools.some((t) => t.toLowerCase().includes(q)),
    );
  }, [servers, filter]);

  const handleStart = async (id: string) => {
    if (!canStartStop) {
      onShowToast?.(controlHint || START_STOP_HINT);
      return;
    }
    setBusyId(id);
    try {
      const r = await startMcpServer(id);
      if (!r.ok) {
        onShowToast?.(r.error || '启动失败');
        if (r.errorCode === 'unsupported') {
          setCanStartStop(false);
          setControlHint(r.error || START_STOP_HINT);
        }
        // 失败时仍刷新列表，但不假成功
        await refreshLive();
        return;
      }
      onShowToast?.(`已请求启动 ${id}`);
      await refreshLive();
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (id: string) => {
    if (!canStartStop) {
      onShowToast?.(controlHint || START_STOP_HINT);
      return;
    }
    setBusyId(id);
    try {
      const r = await stopMcpServer(id);
      if (!r.ok) {
        onShowToast?.(r.error || '停止失败');
        if (r.errorCode === 'unsupported') {
          setCanStartStop(false);
          setControlHint(r.error || START_STOP_HINT);
        }
        await refreshLive();
        return;
      }
      onShowToast?.(`已请求停止 ${id}`);
      await refreshLive();
    } finally {
      setBusyId(null);
    }
  };

  const handleAddDemo = async () => {
    if (!newName.trim()) return;
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
    setShowAdd(false);
    setNewName('');
    setNewCmd('');
    setNewArgs('');
    setNewUrl('');
    onShowToast?.(`已注册 ${server.name}`);
  };

  const handleDeleteDemo = async (id: string, name: string) => {
    const list = await clientApi.deleteMcpServer(id);
    setDemoServers(list);
    onShowToast?.(`已移除 ${name}`);
  };

  if (demo) {
    return (
      <div className="mcp-tab">
        <div className="mcp-tab-head">
          <div>
            <h4 className="mcp-tab-title">扩展服务</h4>
            <p className="mcp-tab-sub">演示模式：本地登记 MCP（不连引擎）</p>
          </div>
          <div className="mcp-tab-actions">
            <button type="button" className="models-btn ghost" onClick={() => void refreshDemo()}>
              <Lucide.RefreshCw size={14} />
              刷新
            </button>
            <button type="button" className="models-btn" onClick={() => setShowAdd(true)}>
              <Lucide.Plus size={14} />
              添加
            </button>
          </div>
        </div>

        {showAdd ? (
          <div className="mcp-add-box">
            <div className="mcp-add-title">注册 MCP 服务</div>
            <div className="mcp-add-grid">
              <label>
                名称
                <input
                  className="settings-field-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="例如 github-mcp"
                />
              </label>
              <label>
                类型
                <select
                  className="settings-field-input"
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as 'stdio' | 'sse')}
                >
                  <option value="stdio">stdio</option>
                  <option value="sse">sse</option>
                </select>
              </label>
              {newType === 'stdio' ? (
                <>
                  <label>
                    命令
                    <input
                      className="settings-field-input"
                      value={newCmd}
                      onChange={(e) => setNewCmd(e.target.value)}
                      placeholder="npx"
                    />
                  </label>
                  <label>
                    参数（逗号分隔）
                    <input
                      className="settings-field-input"
                      value={newArgs}
                      onChange={(e) => setNewArgs(e.target.value)}
                      placeholder="-y, @modelcontextprotocol/server-github"
                    />
                  </label>
                </>
              ) : (
                <label className="mcp-add-full">
                  URL
                  <input
                    className="settings-field-input"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="https://..."
                  />
                </label>
              )}
            </div>
            <div className="mcp-add-actions">
              <button type="button" className="models-btn ghost" onClick={() => setShowAdd(false)}>
                取消
              </button>
              <button
                type="button"
                className="models-btn"
                disabled={!newName.trim()}
                onClick={() => void handleAddDemo()}
              >
                保存
              </button>
            </div>
          </div>
        ) : null}

        <div className="mcp-list">
          {demoServers.map((srv) => {
            const on = demoEnabled[srv.id] !== false;
            return (
              <div key={srv.id} className="mcp-card">
                <div className="mcp-card-top">
                  <span className={`mcp-dot kind-${on ? 'ok' : 'idle'}`} />
                  <div className="mcp-card-main">
                    <div className="mcp-card-name">{srv.name}</div>
                    <div className="mcp-card-meta">
                      {srv.type}
                      {srv.command ? ` · ${srv.command}` : ''}
                      {srv.url ? ` · ${srv.url}` : ''}
                    </div>
                  </div>
                  <div className="mcp-card-actions">
                    <button
                      type="button"
                      className="models-btn ghost"
                      onClick={() =>
                        setDemoEnabled((p) => ({ ...p, [srv.id]: !on }))
                      }
                    >
                      {on ? '禁用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className="models-icon-btn danger"
                      title="删除"
                      onClick={() => void handleDeleteDemo(srv.id, srv.name)}
                    >
                      <Lucide.Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {!loading && demoServers.length === 0 ? (
            <div className="mcp-empty">还没有扩展服务。点击「添加」登记一个工具服务。</div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="mcp-tab">
      <div className="mcp-tab-head">
        <div>
          <h4 className="mcp-tab-title">扩展服务</h4>
          <p className="mcp-tab-sub">
            展示引擎侧已配置的 MCP 状态与工具。服务配置由引擎管理，界面不写入引擎 MCP 配置。
          </p>
        </div>
        <button
          type="button"
          className="models-btn ghost"
          onClick={() => void refreshLive()}
          disabled={loading}
        >
          <Lucide.RefreshCw size={14} className={loading ? 'spin' : undefined} />
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      <div className="mcp-status-bar">
        <span className={`mcp-status-pill ${status?.configured ? 'is-on' : ''}`}>
          {status?.configured ? '已配置' : '未配置'}
        </span>
        {status?.readiness ? (
          <span className="mcp-status-meta">就绪：{mcpStateLabel(status.readiness)}</span>
        ) : null}
        <span className="mcp-status-meta">服务 {servers.length}</span>
        {!canStartStop ? (
          <span className="mcp-status-meta" title={controlHint || START_STOP_HINT}>
            启停：界面不可用
          </span>
        ) : null}
        <input
          className="settings-field-input mcp-search"
          placeholder="搜索服务或工具…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {error ? <div className="mcp-banner warn">{error}</div> : null}

      {!canStartStop && controlHint && servers.length > 0 ? (
        <div className="mcp-banner">{controlHint || START_STOP_HINT}</div>
      ) : null}

      <div className="mcp-list">
        {filtered.map((srv) => {
          const kind = mcpStateKind(srv.state);
          const isOpen = !!expanded[srv.id];
          const running =
            kind === 'ok' || srv.state === 'starting' || srv.state === 'ready' || srv.state === 'running';
          const toolN = srv.toolCount ?? srv.tools.length;

          return (
            <div key={srv.id} className={`mcp-card kind-${kind}`}>
              <div className="mcp-card-top">
                <span className={`mcp-dot kind-${kind}`} />
                <div className="mcp-card-main">
                  <div className="mcp-card-name">{srv.name}</div>
                  <div className="mcp-card-meta">
                    <span className={`mcp-state kind-${kind}`}>{mcpStateLabel(srv.state)}</span>
                    {srv.transport ? <span>· {srv.transport}</span> : null}
                    <span>· 工具 {toolN}</span>
                    {srv.startedAt ? (
                      <span title={srv.startedAt}>· 已启动</span>
                    ) : null}
                  </div>
                  {srv.lastError ? (
                    <div className="mcp-card-error" title={srv.lastError}>
                      {srv.lastError}
                    </div>
                  ) : null}
                </div>
                <div className="mcp-card-actions">
                  <button
                    type="button"
                    className="models-btn ghost"
                    title="展开工具"
                    onClick={() =>
                      setExpanded((p) => ({ ...p, [srv.id]: !isOpen }))
                    }
                  >
                    {isOpen ? <Lucide.ChevronUp size={14} /> : <Lucide.ChevronDown size={14} />}
                    工具
                  </button>
                  {canStartStop ? (
                    running ? (
                      <button
                        type="button"
                        className="models-btn ghost"
                        disabled={busyId === srv.id}
                        title="请求引擎停止该 MCP 服务"
                        onClick={() => void handleStop(srv.id)}
                      >
                        <Lucide.Square size={14} />
                        停止
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="models-btn"
                        disabled={busyId === srv.id}
                        title="请求引擎启动该 MCP 服务"
                        onClick={() => void handleStart(srv.id)}
                      >
                        <Lucide.Play size={14} />
                        启动
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      className="models-btn ghost"
                      disabled
                      title={controlHint || START_STOP_HINT}
                    >
                      {running ? (
                        <>
                          <Lucide.Square size={14} />
                          停止
                        </>
                      ) : (
                        <>
                          <Lucide.Play size={14} />
                          启动
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>

              {isOpen ? (
                <div className="mcp-tools">
                  {srv.tools.length === 0 ? (
                    <div className="mcp-tools-empty">
                      {toolN > 0
                        ? `引擎报告 ${toolN} 个工具，但未返回名称列表`
                        : '暂无工具名称（服务未启动或未上报）'}
                    </div>
                  ) : (
                    <ul>
                      {srv.tools.map((t) => (
                        <li key={t}>
                          <Lucide.Wrench size={12} />
                          <code>{t}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mcp-card-id">
                    id: <code>{srv.id}</code>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}

        {!loading && filtered.length === 0 ? (
          <div className="mcp-empty">
            {servers.length === 0 ? (
              <>
                <div className="mcp-empty-title">暂无 MCP 服务</div>
                <p>
                  MCP 由<strong>引擎侧配置</strong>（如启动 daemon 时的 mcpServers），本页不会写入引擎配置。
                  默认引擎通常未注入 MCP，因此列表为空是正常现象。
                </p>
                <p>
                  在引擎配置 MCP 并完成任务运行时连接后，此处才会列出服务与工具状态。
                  {!canStartStop ? (
                    <>
                      {' '}
                      {controlHint || START_STOP_HINT}
                    </>
                  ) : null}
                </p>
              </>
            ) : (
              '没有匹配的服务'
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};
