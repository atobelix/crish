import React from 'react';
import * as Lucide from 'lucide-react';
import type { McpServerInfo, McpStatusSnapshot } from '../../api/mcpApi';
import { mcpStateKind, mcpStateLabel } from '../../api/mcpApi';
import type { McpServer } from '../../api/clientApi';
import styles from './McpSettingsTab.module.css';
import { Tooltip } from '../Tooltip';
import {
  EMPTY_DEMO_HINT,
  EMPTY_FILTER_HINT,
  EMPTY_LIVE_HINT_CONFIGURED,
  EMPTY_LIVE_HINT_UNCONFIGURED,
  START_STOP_HINT,
  transportLabel,
  transportTitle,
  type SortMode,
} from './types';

export type McpServerListProps = {
  demo: boolean;
  loading: boolean;
  servers: McpServerInfo[];
  status?: McpStatusSnapshot | undefined;
  demoServers: McpServer[];
  demoEnabled: Record<string, boolean>;
  filtered: McpServerInfo[];
  filteredDemo: McpServer[];
  expanded: Record<string, boolean>;
  busyId: string | null;
  filter: string;
  sortMode: SortMode;
  canStartStop: boolean;
  controlHint?: string | undefined;
  showAdd: boolean;
  listLabelId: string;
  toolsPanelPrefix: string;
  onRefresh: () => void;
  onSetSort: (mode: SortMode) => void;
  onSetFilter: (filter: string) => void;
  onClearFilter: () => void;
  onSetShowAdd: React.Dispatch<React.SetStateAction<boolean>>;
  onToggleServer: (id: string, action: 'start' | 'stop') => void;
  onCopy: (text: string) => void;
  onToggleExpanded: (id: string) => void;
  onToggleDemoEnabled: (id: string) => void;
  onDeleteDemo: (id: string) => void;
  refreshDemo: () => void;
  refreshLive: () => void;
};

export const McpServerList: React.FC<McpServerListProps> = ({
  demo,
  loading,
  servers,
  status,
  demoServers,
  demoEnabled,
  filtered,
  filteredDemo,
  expanded,
  busyId,
  filter,
  sortMode,
  canStartStop,
  controlHint,
  showAdd,
  listLabelId,
  toolsPanelPrefix,
  onRefresh,
  onSetSort,
  onSetFilter,
  onClearFilter,
  onSetShowAdd,
  onToggleServer,
  onCopy,
  onToggleExpanded,
  onToggleDemoEnabled,
  onDeleteDemo,
  refreshDemo,
  refreshLive,
}) => {
  const stopHint = controlHint || START_STOP_HINT;
  const filterActive = filter.trim().length > 0;
  const liveEmptyHint = status?.configured
    ? EMPTY_LIVE_HINT_CONFIGURED
    : EMPTY_LIVE_HINT_UNCONFIGURED;

  const renderTools = (srv: McpServerInfo, panelId: string) => {
    const toolN = srv.toolCount ?? srv.tools.length;
    return (
      <div className={`${styles.mcpTools} mcp-tools`} id={panelId} role="region" aria-label={`${srv.name} 的工具`}>
        {srv.tools.length === 0 ? (
          <div className={`${styles.mcpToolsEmpty} mcp-tools-empty`} role="status">
            {toolN > 0 ? `工具 ${toolN}（未返回名称）` : '暂无工具'}
          </div>
        ) : (
          <ul>
            {srv.tools.map((t) => (
              <li key={t}>
                <Lucide.Wrench size={12} aria-hidden />
                <Tooltip content="复制工具名">
                  <button
                    type="button"
                    className={`${styles.mcpInlineCopy} mcp-inline-copy`}
                    aria-label={`复制工具名 ${t}`}
                    onClick={() => onCopy(t)}
                  >
                    <code>{t}</code>
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
        <div className={`${styles.mcpCardId} mcp-card-id`}>
          标识{' '}
          <Tooltip content="复制标识">
            <button
              type="button"
              className={`${styles.mcpInlineCopy} mcp-inline-copy`}
              aria-label={`复制标识 ${srv.id}`}
              onClick={() => onCopy(srv.id)}
            >
              <code>{srv.id}</code>
            </button>
          </Tooltip>
        </div>
      </div>
    );
  };

  const renderFilterEmpty = (hasAny: boolean) => {
    if (loading) {
      return (
        <div className={`${styles.mcpEmptyLine} mcp-empty-line`} role="status" aria-live="polite" aria-busy="true">
          <span>加载中…</span>
        </div>
      );
    }
    if (!hasAny) return null;
    if (!filterActive) return null;
    return (
      <div className={`${styles.mcpEmptyLine} mcp-empty-line`} role="status" aria-live="polite">
        <Tooltip content={EMPTY_FILTER_HINT}>
          <span>无匹配</span>
        </Tooltip>
        <Tooltip content={EMPTY_FILTER_HINT}>
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={onClearFilter}
            aria-label="清除筛选"
          >
            清除筛选
          </button>
        </Tooltip>
      </div>
    );
  };

  const renderSharedToolbar = () => (
    <div className={`${styles.mcpToolbar} mcp-toolbar`} role="toolbar" aria-label="扩展服务工具栏">
      <Tooltip content={loading ? '刷新中…' : '刷新列表'}>
        <button
          type="button"
          className="ui-btn ui-btn-ghost ui-btn-sm"
          onClick={onRefresh}
          disabled={loading}
          aria-label={loading ? '刷新中' : '刷新列表'}
          aria-busy={loading || undefined}
        >
          <Lucide.RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden />
        </button>
      </Tooltip>
      <div className="ui-segment ui-segment--inline settings-segment-pill" role="group" aria-label="排序方式">
        <Tooltip content="按名称排序">
          <button
            type="button"
            className={`ui-segment-item ${sortMode === 'name' ? 'active' : ''}`}
            onClick={() => onSetSort('name')}
            aria-pressed={sortMode === 'name'}
          >
            名称
          </button>
        </Tooltip>
        <Tooltip content={demo ? '按启用状态排序' : '按运行状态排序'}>
          <button
            type="button"
            className={`ui-segment-item ${sortMode === 'state' ? 'active' : ''}`}
            onClick={() => onSetSort('state')}
            aria-pressed={sortMode === 'state'}
          >
            状态
          </button>
        </Tooltip>
      </div>
      <Tooltip content="搜索名称、标识或工具；Esc 清除">
        <input
          className={`settings-field-input settings-field-input--sm ${styles.mcpSearch} mcp-search`}
          placeholder="搜索名称、标识…"
          value={filter}
          onChange={(e) => onSetFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) {
              e.preventDefault();
              onClearFilter();
            }
          }}
          aria-label="搜索扩展服务"
        />
      </Tooltip>
      {demo ? (
        <Tooltip content={showAdd ? '收起添加表单' : '添加演示服务'}>
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            onClick={() => onSetShowAdd((v) => !v)}
            aria-label={showAdd ? '收起添加表单' : '添加演示服务'}
            aria-expanded={showAdd}
          >
            <Lucide.Plus size={14} aria-hidden />
            {showAdd ? '收起' : '添加'}
          </button>
        </Tooltip>
      ) : null}
    </div>
  );

  const renderServiceList = <T,>(opts: {
    items: T[];
    totalCount: number;
    loading: boolean;
    emptyContent: React.ReactNode;
    renderItem: (item: T, index: number) => React.ReactNode;
  }) => {
    const { items, totalCount, loading: isBusy, emptyContent, renderItem } = opts;
    return (
      <div
        className={`${styles.mcpList} mcp-list`}
        role="list"
        aria-labelledby={listLabelId}
        aria-label="服务列表"
        aria-busy={isBusy || undefined}
      >
        {items.length > 0 ? items.map(renderItem) : null}
        {!isBusy && totalCount === 0 ? (
          <div className={`${styles.mcpEmptyLine} mcp-empty-line`} role="status" aria-live="polite">
            {emptyContent}
          </div>
        ) : null}
        {!isBusy && totalCount > 0 && items.length === 0 && filterActive
          ? renderFilterEmpty(true)
          : null}
        {isBusy && totalCount === 0 ? renderFilterEmpty(true) : null}
      </div>
    );
  };

  if (demo) {
    return (
      <>
        {renderSharedToolbar()}
        {renderServiceList({
          items: filteredDemo,
          totalCount: demoServers.length,
          loading,
          emptyContent: (
            <>
              <span>{EMPTY_DEMO_HINT}</span>
              <Tooltip content={EMPTY_DEMO_HINT}>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  onClick={() => onSetShowAdd(true)}
                  aria-label="添加演示服务"
                >
                  <Lucide.Plus size={14} aria-hidden />
                  添加
                </button>
              </Tooltip>
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
            </>
          ),
          renderItem: (srv: McpServer) => {
            const on = demoEnabled[srv.id] !== false;
            const typeTitle = transportTitle(srv.type);
            return (
              <div key={srv.id} className={`${styles.mcpRow} mcp-row`} role="listitem">
                <div className={`${styles.mcpRowMain} mcp-row-main`}>
                  <Tooltip content={on ? '已启用' : '已禁用'}>
                    <span
                      className={`${styles.mcpDot} mcp-dot kind-${on ? 'ok' : 'idle'}`}
                      aria-hidden
                    />
                  </Tooltip>
                  <Tooltip content={`复制标识 ${srv.id}`}>
                    <button
                      type="button"
                      className={`${styles.mcpRowName} mcp-row-name ${styles.mcpInlineCopy} mcp-inline-copy`}
                      aria-label={`复制标识 ${srv.name}`}
                      onClick={() => onCopy(srv.id)}
                    >
                      {srv.name}
                    </button>
                  </Tooltip>
                  <span className={`${styles.mcpStateBadge} mcp-state-badge kind-${on ? 'ok' : 'idle'}`}>
                    {on ? '启用' : '禁用'}
                  </span>
                  <Tooltip content={typeTitle}>
                    <span className={`${styles.mcpRowMeta} mcp-row-meta`}>
                      {transportLabel(srv.type)}
                      {srv.command ? ` · ${srv.command}` : ''}
                      {srv.url ? ` · ${srv.url}` : ''}
                    </span>
                  </Tooltip>
                  <div className={`${styles.mcpRowActions} mcp-row-actions`}>
                    <Tooltip content={on ? '禁用' : '启用'}>
                      <input
                        type="checkbox"
                        className="settings-switch"
                        checked={on}
                        aria-label={on ? `禁用 ${srv.name}` : `启用 ${srv.name}`}
                        onChange={() => onToggleDemoEnabled(srv.id)}
                      />
                    </Tooltip>
                    <Tooltip content="删除">
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm"
                        aria-label={`删除 ${srv.name}`}
                        onClick={() => void onDeleteDemo(srv.id)}
                      >
                        <Lucide.Trash2 size={14} aria-hidden />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            );
          },
        })}
      </>
    );
  }

  return (
    <>
      {renderSharedToolbar()}
      {renderServiceList({
        items: filtered,
        totalCount: servers.length,
        loading,
        emptyContent: (
          <>
            <Tooltip content={liveEmptyHint}>
              <span>
                {status?.configured ? '暂无服务实例' : '暂无扩展服务'}
              </span>
            </Tooltip>
            <Tooltip content="重新向引擎查询列表">
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => void refreshLive()}
                disabled={loading}
                aria-label="刷新列表"
              >
                <Lucide.RefreshCw size={14} aria-hidden />
                刷新
              </button>
            </Tooltip>
          </>
        ),
        renderItem: (srv: McpServerInfo) => {
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
            <div key={srv.id} className={`${styles.mcpRow} mcp-row`} role="listitem">
              <div className={`${styles.mcpRowMain} mcp-row-main`}>
                <Tooltip content={mcpStateLabel(srv.state)}>
                  <span
                    className={`${styles.mcpDot} mcp-dot kind-${kind}`}
                    aria-hidden
                  />
                </Tooltip>
                <Tooltip content={`复制标识 ${srv.id}`}>
                  <button
                    type="button"
                    className={`${styles.mcpRowName} mcp-row-name ${styles.mcpInlineCopy} mcp-inline-copy`}
                    aria-label={`复制标识 ${srv.name}`}
                    onClick={() => onCopy(srv.id)}
                  >
                    {srv.name}
                  </button>
                </Tooltip>
                <Tooltip content={mcpStateLabel(srv.state)}>
                  <span className={`${styles.mcpStateBadge} mcp-state-badge kind-${kind}`}>
                    {mcpStateLabel(srv.state)}
                  </span>
                </Tooltip>
                <Tooltip content={tpTitle}>
                  <span className={`${styles.mcpRowMeta} mcp-row-meta`}>
                    {tp ? `${tp} · ` : ''}
                    工具 {toolN}
                    {srv.lastError ? (
                      <Tooltip content={srv.lastError}>
                        <span className={`${styles.mcpRowErr} mcp-row-err`}>
                          {' '}
                          · 错误
                        </span>
                      </Tooltip>
                    ) : null}
                  </span>
                </Tooltip>
                <div className={`${styles.mcpRowActions} mcp-row-actions`}>
                  <Tooltip content={isOpen ? '收起工具' : `展开工具（${toolN}）`}>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      aria-label={isOpen ? `收起 ${srv.name} 的工具` : `展开 ${srv.name} 的工具 ${toolN}`}
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      onClick={() => onToggleExpanded(srv.id)}
                    >
                      {isOpen ? (
                        <Lucide.ChevronUp size={14} aria-hidden />
                      ) : (
                        <Lucide.ChevronDown size={14} aria-hidden />
                      )}
                    </button>
                  </Tooltip>
                  {canStartStop ? (
                    running ? (
                      <Tooltip content={busy ? '停止中…' : '停止'}>
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          disabled={busy}
                          aria-label={`停止 ${srv.name}`}
                          aria-busy={busy || undefined}
                          onClick={() => void onToggleServer(srv.id, 'stop')}
                        >
                          <Lucide.Square size={14} aria-hidden />
                        </button>
                      </Tooltip>
                    ) : (
                      <Tooltip content={busy ? '启动中…' : '启动'}>
                        <button
                          type="button"
                          className="ui-btn ui-btn-secondary ui-btn-sm"
                          disabled={busy}
                          aria-label={`启动 ${srv.name}`}
                          aria-busy={busy || undefined}
                          onClick={() => void onToggleServer(srv.id, 'start')}
                        >
                          <Lucide.Play size={14} aria-hidden />
                        </button>
                      </Tooltip>
                    )
                  ) : (
                    <Tooltip content={stopHint}>
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm"
                        disabled
                        aria-label={running ? '停止不可用' : '启动不可用'}
                      >
                        {running ? (
                          <Lucide.Square size={14} aria-hidden />
                        ) : (
                          <Lucide.Play size={14} aria-hidden />
                        )}
                      </button>
                    </Tooltip>
                  )}
                </div>
              </div>
              {isOpen ? renderTools(srv, panelId) : null}
            </div>
          );
        },
      })}
    </>
  );
};
