import React from 'react';
import * as Lucide from 'lucide-react';
import type { McpServerInfo, McpStatusSnapshot } from '../../api/mcpApi';
import { mcpStateKind, mcpStateLabel } from '../../api/mcpApi';
import type { McpServer } from '../../api/clientApi';
import styles from './McpSettingsTab.module.css';
import { Button, Switch, Tooltip } from '../ui';
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
import { McpServerTools } from './McpServerTools';
import { McpServerToolbar } from './McpServerToolbar';

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

  const renderFilterEmpty = (hasAny: boolean) => {
    if (loading) {
      return (
        <div
          className={`${styles.mcpEmptyLine} mcp-empty-line`}
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <span>加载中…</span>
        </div>
      );
    }
    if (!hasAny) return null;
    if (!filterActive) return null;
    return (
      <div
        className={`${styles.mcpEmptyLine} mcp-empty-line`}
        role="status"
        aria-live="polite"
      >
        <Tooltip content={EMPTY_FILTER_HINT}>
          <span>无匹配</span>
        </Tooltip>
        <Tooltip content={EMPTY_FILTER_HINT}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClearFilter}
            aria-label="清除筛选"
          >
            清除筛选
          </Button>
        </Tooltip>
      </div>
    );
  };

  const renderSharedToolbar = () => (
    <McpServerToolbar
      demo={demo}
      loading={loading}
      filter={filter}
      sortMode={sortMode}
      showAdd={showAdd}
      onRefresh={onRefresh}
      onSetSort={onSetSort}
      onSetFilter={onSetFilter}
      onClearFilter={onClearFilter}
      onSetShowAdd={onSetShowAdd}
    />
  );

  const renderServiceList = <T,>(opts: {
    items: T[];
    totalCount: number;
    loading: boolean;
    emptyContent: React.ReactNode;
    renderItem: (item: T, index: number) => React.ReactNode;
  }) => {
    const {
      items,
      totalCount,
      loading: isBusy,
      emptyContent,
      renderItem,
    } = opts;
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
          <div
            className={`${styles.mcpEmptyLine} mcp-empty-line`}
            role="status"
            aria-live="polite"
          >
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
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onSetShowAdd(true)}
                  aria-label="添加演示服务"
                  icon={<Lucide.Plus size={14} aria-hidden />}
                >
                  添加
                </Button>
              </Tooltip>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void refreshDemo()}
                disabled={loading}
                aria-label="刷新列表"
                icon={<Lucide.RefreshCw size={14} aria-hidden />}
              >
                刷新
              </Button>
            </>
          ),
          renderItem: (srv: McpServer) => {
            const on = demoEnabled[srv.id] !== false;
            const typeTitle = transportTitle(srv.type);
            return (
              <div
                key={srv.id}
                className={`${styles.mcpRow} mcp-row`}
                role="listitem"
              >
                <div className={`${styles.mcpRowMain} mcp-row-main`}>
                  <Tooltip content={on ? '已启用' : '已禁用'}>
                    <span
                      className={`${styles.mcpDot} mcp-dot kind-${on ? 'ok' : 'idle'}`}
                      aria-hidden
                    />
                  </Tooltip>
                  <Tooltip content={`复制标识 ${srv.id}`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={`${styles.mcpRowName} mcp-row-name ${styles.mcpInlineCopy} mcp-inline-copy`}
                      aria-label={`复制标识 ${srv.name}`}
                      onClick={() => onCopy(srv.id)}
                    >
                      {srv.name}
                    </Button>
                  </Tooltip>
                  <span
                    className={`${styles.mcpStateBadge} mcp-state-badge kind-${on ? 'ok' : 'idle'}`}
                  >
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
                      <Switch
                        checked={on}
                        aria-label={
                          on ? `禁用 ${srv.name}` : `启用 ${srv.name}`
                        }
                        onCheckedChange={() => onToggleDemoEnabled(srv.id)}
                      />
                    </Tooltip>
                    <Tooltip content="删除">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`删除 ${srv.name}`}
                        onClick={() => void onDeleteDemo(srv.id)}
                        icon={<Lucide.Trash2 size={14} aria-hidden />}
                      />
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void refreshLive()}
                disabled={loading}
                aria-label="刷新列表"
                icon={<Lucide.RefreshCw size={14} aria-hidden />}
              >
                刷新
              </Button>
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
            <div
              key={srv.id}
              className={`${styles.mcpRow} mcp-row`}
              role="listitem"
            >
              <div className={`${styles.mcpRowMain} mcp-row-main`}>
                <Tooltip content={mcpStateLabel(srv.state)}>
                  <span
                    className={`${styles.mcpDot} mcp-dot kind-${kind}`}
                    aria-hidden
                  />
                </Tooltip>
                <Tooltip content={`复制标识 ${srv.id}`}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={`${styles.mcpRowName} mcp-row-name ${styles.mcpInlineCopy} mcp-inline-copy`}
                    aria-label={`复制标识 ${srv.name}`}
                    onClick={() => onCopy(srv.id)}
                  >
                    {srv.name}
                  </Button>
                </Tooltip>
                <Tooltip content={mcpStateLabel(srv.state)}>
                  <span
                    className={`${styles.mcpStateBadge} mcp-state-badge kind-${kind}`}
                  >
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
                  <Tooltip
                    content={isOpen ? '收起工具' : `展开工具（${toolN}）`}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={
                        isOpen
                          ? `收起 ${srv.name} 的工具`
                          : `展开 ${srv.name} 的工具 ${toolN}`
                      }
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      onClick={() => onToggleExpanded(srv.id)}
                      icon={
                        isOpen ? (
                          <Lucide.ChevronUp size={14} aria-hidden />
                        ) : (
                          <Lucide.ChevronDown size={14} aria-hidden />
                        )
                      }
                    />
                  </Tooltip>
                  {canStartStop ? (
                    running ? (
                      <Tooltip content={busy ? '停止中…' : '停止'}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          aria-label={`停止 ${srv.name}`}
                          aria-busy={busy || undefined}
                          onClick={() => void onToggleServer(srv.id, 'stop')}
                          icon={<Lucide.Square size={14} aria-hidden />}
                        />
                      </Tooltip>
                    ) : (
                      <Tooltip content={busy ? '启动中…' : '启动'}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          aria-label={`启动 ${srv.name}`}
                          aria-busy={busy || undefined}
                          onClick={() => void onToggleServer(srv.id, 'start')}
                          icon={<Lucide.Play size={14} aria-hidden />}
                        />
                      </Tooltip>
                    )
                  ) : (
                    <Tooltip content={stopHint}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled
                        aria-label={running ? '停止不可用' : '启动不可用'}
                        icon={
                          running ? (
                            <Lucide.Square size={14} aria-hidden />
                          ) : (
                            <Lucide.Play size={14} aria-hidden />
                          )
                        }
                      />
                    </Tooltip>
                  )}
                </div>
              </div>
              {isOpen ? (
                <McpServerTools srv={srv} panelId={panelId} onCopy={onCopy} />
              ) : null}
            </div>
          );
        },
      })}
    </>
  );
};
