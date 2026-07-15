/**
 * 设置 · 扩展服务（MCP）：列表 / 状态 / 启停 / 工具展开
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  listMcpServers,
  mcpStateKind,
  mcpStateLabel,
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

export const McpSettingsTab: React.FC<Props> = ({ onShowToast, onAvailabilityChange }) => {
  const demo = isDemoMode();
  const [loading, setLoading] = useState(true);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [status, setStatus] = useState<McpStatusSnapshot | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

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
      setServers(r.servers);
      setStatus(r.status);
      if (!r.ok && r.error) setError(r.error);
      onAvailabilityChange?.(r.configured || r.servers.length > 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
    setBusyId(id);
    try {
      const r = await startMcpServer(id);
      if (!r.ok) onShowToast?.(r.error || '启动失败');
      else onShowToast?.(`已请求启动 ${id}`);
      await refreshLive();
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (id: string) => {
    setBusyId(id);
    try {
      const r = await stopMcpServer(id);
      if (!r.ok) onShowToast?.(r.error || '停止失败');
      else onShowToast?.(`已请求停止 ${id}`);
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
            来自引擎 MCP 状态。可查看工具列表并请求启动 / 停止；配置文件由引擎侧管理。
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
        <input
          className="settings-field-input mcp-search"
          placeholder="搜索服务或工具…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {error ? <div className="mcp-banner warn">{error}</div> : null}

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
                  {running ? (
                    <button
                      type="button"
                      className="models-btn ghost"
                      disabled={busyId === srv.id}
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
                      onClick={() => void handleStart(srv.id)}
                    >
                      <Lucide.Play size={14} />
                      启动
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
                <div className="mcp-empty-title">引擎未报告 MCP 服务</div>
                <p>
                  在引擎配置中登记 MCP 后，此处会列出服务并支持启停。配置路径与格式由当前引擎实现决定（常见为
                  工作区或用户目录下的 MCP 配置文件）。
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
