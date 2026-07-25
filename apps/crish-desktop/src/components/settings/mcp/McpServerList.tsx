import React from 'react';
import { ChevronDown, ChevronUp, Play, Plus, RefreshCw, Square, Trash2 } from 'lucide-react';
import { mcpStateKind, mcpStateLabel, type McpServerInfo } from '../../../api/mcpApi';
import { type McpServer } from '../../../api/clientApi';
import { Tooltip } from '../SettingsUI';
import { SettingsSelect } from '../../SettingsSelect';
import { McpServerTools } from './McpServerTools';
import styles from '../../McpSettingsTab.module.css';

type SortMode = 'name' | 'state';

interface McpServerListProps {
  servers: McpServerInfo[];
  demoServers: McpServer[];
  loading: boolean;
  filter: string;
  sortMode: SortMode;
  expanded: Record<string, boolean>;
  demoEnabled: Record<string, boolean>;
  canStartStop: boolean;
  busyId: string | null;
  stopHint: string;
  isDemo: boolean;
  demoEnabledCount: number;
  filterActive: boolean;
  onFilterChange: (filter: string) => void;
  onSortModeChange: (mode: SortMode) => void;
  onClearFilter: () => void;
  onCopy: (text: string) => void;
  onRefresh: () => void;
  onToggleExpanded: (id: string) => void;
  onToggleDemo: (id: string) => void;
  onDeleteDemo: (id: string) => void;
  onToggleServer: (id: string, action: 'start' | 'stop') => void;
}

const STATE_SORT_RANK: Record<string, number> = { ok: 0, warn: 1, err: 2, idle: 3 };

function transportLabel(raw?: string): string {
  if (!raw) return '';
  const t = raw.toLowerCase();
  return t === 'stdio' || t === 'sse' ? t : (t === 'http' || t === 'streamable-http' ? raw : raw);
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

export const McpServerList: React.FC<McpServerListProps> = React.memo(({
  servers, demoServers, loading, filter, sortMode, expanded, demoEnabled,
  canStartStop, busyId, stopHint, isDemo, demoEnabledCount, filterActive,
  onFilterChange, onSortModeChange, onClearFilter, onCopy, onRefresh,
  onToggleExpanded, onToggleDemo, onDeleteDemo, onToggleServer,
}) => {
  const listLabelId = React.useId();

  const filteredServers = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = isDemo ? demoServers : servers;
    if (q) {
      list = list.filter((s: any) =>
        s.name?.toLowerCase().includes(q) || s.id?.toLowerCase().includes(q));
    }
    const sorted = [...list];
    if (sortMode === 'name') sorted.sort((a: any, b: any) => a.name.localeCompare(b.name, 'zh-CN'));
    else {
      if (isDemo) sorted.sort((a: any, b: any) => {
        const onA = demoEnabled[a.id] !== false ? 0 : 1;
        const onB = demoEnabled[b.id] !== false ? 0 : 1;
        return onA !== onB ? onA - onB : a.name.localeCompare(b.name, 'zh-CN');
      });
      else sorted.sort((a: any, b: any) => {
        const ka = STATE_SORT_RANK[mcpStateKind(a.state)] ?? 9;
        const kb = STATE_SORT_RANK[mcpStateKind(b.state)] ?? 9;
        return ka !== kb ? ka - kb : a.name.localeCompare(b.name, 'zh-CN');
      });
    }
    return sorted;
  }, [servers, demoServers, filter, sortMode, isDemo, demoEnabled]);

  return (
    <div className={`${styles.mcpList} mcp-list`} role="list" aria-labelledby={listLabelId}
      aria-busy={loading || undefined}>
      {filteredServers.length > 0 ? filteredServers.map((srv: any) => {
        if (isDemo) {
          const on = demoEnabled[srv.id] !== false;
          const typeTitle = transportTitle(srv.type);
          return (
            <div key={srv.id} className={`${styles.mcpRow} mcp-row`} role="listitem">
              <div className={`${styles.mcpRowMain} mcp-row-main`}>
                <Tooltip content={on ? '已启用' : '已禁用'}><span className={`${styles.mcpDot} mcp-dot kind-${on ? 'ok' : 'idle'}`} aria-hidden /></Tooltip>
                <Tooltip content={`复制标识 ${srv.id}`}>
                  <button type="button" className={`${styles.mcpRowName} mcp-row-name ${styles.mcpInlineCopy} mcp-inline-copy`}
                    aria-label={`复制标识 ${srv.name}`} onClick={() => onCopy(srv.id)}>{srv.name}</button>
                </Tooltip>
                <span className={`${styles.mcpStateBadge} mcp-state-badge kind-${on ? 'ok' : 'idle'}`}>{on ? '启用' : '禁用'}</span>
                <Tooltip content={typeTitle}>
                  <span className={`${styles.mcpRowMeta} mcp-row-meta`}>
                    {transportLabel(srv.type)}{srv.command ? ` · ${srv.command}` : ''}{srv.url ? ` · ${srv.url}` : ''}
                  </span>
                </Tooltip>
                <div className={`${styles.mcpRowActions} mcp-row-actions`}>
                  <input type="checkbox" className="settings-switch" checked={on}
                    aria-label={on ? `禁用 ${srv.name}` : `启用 ${srv.name}`}
                    onChange={() => onToggleDemo(srv.id)} />
                  <Tooltip content="删除">
                    <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" aria-label={`删除 ${srv.name}`}
                      onClick={() => onDeleteDemo(srv.id)}><Trash2 size={14} aria-hidden /></button>
                  </Tooltip>
                </div>
              </div>
            </div>
          );
        }
        const kind = mcpStateKind(srv.state);
        const isOpen = !!expanded[srv.id];
        const running = kind === 'ok' || srv.state === 'starting' || srv.state === 'ready' || srv.state === 'running';
        const toolN = srv.toolCount ?? srv.tools.length;
        const busy = busyId === srv.id;
        return (
          <div key={srv.id} className={`${styles.mcpRow} mcp-row`} role="listitem">
            <div className={`${styles.mcpRowMain} mcp-row-main`}>
              <Tooltip content={mcpStateLabel(srv.state)}><span className={`${styles.mcpDot} mcp-dot kind-${kind}`} aria-hidden /></Tooltip>
              <Tooltip content={`复制标识 ${srv.id}`}>
                <button type="button" className={`${styles.mcpRowName} mcp-row-name ${styles.mcpInlineCopy} mcp-inline-copy`}
                  aria-label={`复制标识 ${srv.name}`} onClick={() => onCopy(srv.id)}>{srv.name}</button>
              </Tooltip>
              <Tooltip content={mcpStateLabel(srv.state)}><span className={`${styles.mcpStateBadge} mcp-state-badge kind-${kind}`}>{mcpStateLabel(srv.state)}</span></Tooltip>
              <Tooltip content={transportTitle(srv.transport)}>
                <span className={`${styles.mcpRowMeta} mcp-row-meta`}>
                  {srv.transport ? `${transportLabel(srv.transport)} · ` : ''}工具 {toolN}
                  {srv.lastError ? <Tooltip content={srv.lastError}><span className={`${styles.mcpRowErr} mcp-row-err`}> · 错误</span></Tooltip> : null}
                </span>
              </Tooltip>
              <div className={`${styles.mcpRowActions} mcp-row-actions`}>
                <Tooltip content={isOpen ? '收起工具' : `展开工具（${toolN}）`}>
                  <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm"
                    aria-label={isOpen ? `收起 ${srv.name} 的工具` : `展开 ${srv.name} 的工具 ${toolN}`}
                    aria-expanded={isOpen} onClick={() => onToggleExpanded(srv.id)}>
                    {isOpen ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                  </button>
                </Tooltip>
                {canStartStop ? (
                  running ? (
                    <Tooltip content={busy ? '停止中…' : '停止'}>
                      <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy}
                        aria-label={`停止 ${srv.name}`} aria-busy={busy || undefined}
                        onClick={() => onToggleServer(srv.id, 'stop')}><Square size={14} aria-hidden /></button>
                    </Tooltip>
                  ) : (
                    <Tooltip content={busy ? '启动中…' : '启动'}>
                      <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" disabled={busy}
                        aria-label={`启动 ${srv.name}`} aria-busy={busy || undefined}
                        onClick={() => onToggleServer(srv.id, 'start')}><Play size={14} aria-hidden /></button>
                    </Tooltip>
                  )
                ) : (
                  <Tooltip content={stopHint}>
                    <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled
                      aria-label={running ? '停止不可用' : '启动不可用'}>
                      {running ? <Square size={14} aria-hidden /> : <Play size={14} aria-hidden />}
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
            {isOpen ? <McpServerTools tools={srv.tools} toolCount={srv.toolCount} serverId={srv.id} serverName={srv.name} onCopy={onCopy} /> : null}
          </div>
        );
      }) : (
        !loading && filterActive ? <div className={`${styles.mcpEmptyLine} mcp-empty-line`} role="status"><span>无匹配</span></div> : null
      )}
      {loading && filteredServers.length === 0 ? <div className={`${styles.mcpEmptyLine} mcp-empty-line`} role="status" aria-live="polite" aria-busy="true"><span>加载中…</span></div> : null}
    </div>
  );
});
