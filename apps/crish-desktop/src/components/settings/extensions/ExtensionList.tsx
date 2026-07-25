import React from 'react';
import { kindLabel, type CatalogEntry, type ExtensionKind, type InstalledExtension } from '../../../api/extensionCatalog';
import { ExtensionExpandBody } from './ExtensionExpandBody';

type MainView = 'installed' | 'discover';
type KindFilter = 'all' | ExtensionKind;
type ExpandMode = 'detail' | 'config';
type ExpandTarget = { scope: 'installed' | 'catalog'; id: string; mode: ExpandMode };

interface ExtensionListProps {
  view: MainView;
  kindFilter: KindFilter;
  loading: boolean;
  busyId: string | null;
  installedFiltered: InstalledExtension[];
  catalogFiltered: CatalogEntry[];
  catalogInstalled: Set<string>;
  expand: ExpandTarget | null;
  query: string;
  onViewChange: (view: MainView) => void;
  onKindFilterChange: (filter: KindFilter) => void;
  onQueryChange: (query: string) => void;
  onToggleExpand: (scope: 'installed' | 'catalog', id: string, mode: ExpandMode) => void;
  onInstall: (entry: CatalogEntry) => void;
  onRemove: (item: InstalledExtension) => void;
  onSetViewInstalled: (target: ExpandTarget) => void;
  onManage: (kind: 'skill' | 'mcp') => void;
  onToggleMcpServer: (serverId: string, start: boolean) => void;
}

export const ExtensionList: React.FC<ExtensionListProps> = React.memo(({
  view, kindFilter, loading, busyId, installedFiltered, catalogFiltered,
  catalogInstalled, expand, query, onViewChange, onKindFilterChange,
  onQueryChange, onToggleExpand, onInstall, onRemove, onSetViewInstalled,
  onManage, onToggleMcpServer,
}) => {
  const kindFilters: { id: KindFilter; label: string }[] = [
    { id: 'all', label: '全部' }, { id: 'plugin', label: '插件' }, { id: 'mcp', label: 'MCP' }, { id: 'skill', label: '技能' },
  ];

  const highlightMatch = (text: string): React.ReactNode => {
    const q = query.trim().toLowerCase();
    if (!q) return text;
    const lower = text.toLowerCase();
    if (!lower.includes(q)) return text;
    const parts: React.ReactNode[] = [];
    let cursor = 0, idx = lower.indexOf(q, cursor);
    while (idx !== -1) { if (idx > cursor) parts.push(text.slice(cursor, idx)); parts.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>); cursor = idx + q.length; idx = lower.indexOf(q, cursor); }
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  };

  const isExpanded = (scope: 'installed' | 'catalog', id: string, mode?: ExpandMode) => {
    if (!expand || expand.scope !== scope || expand.id !== id) return false;
    return mode ? expand.mode === mode : true;
  };

  return (
    <>
      <div className="ext-toolbar ext-toolbar--one" role="group" aria-label="筛选">
        <div className="settings-choice-group" role="group" aria-label="视图">
          <button type="button" className={`settings-choice-btn ${view === 'installed' ? 'active' : ''}`}
            aria-pressed={view === 'installed'} onClick={() => onViewChange('installed')}>已安装</button>
          <button type="button" className={`settings-choice-btn ${view === 'discover' ? 'active' : ''}`}
            aria-pressed={view === 'discover'} onClick={() => onViewChange('discover')}>发现</button>
        </div>
        <div className="settings-choice-group" role="group" aria-label="类型">
          {kindFilters.map((f) => (
            <button key={f.id} type="button" className={`settings-choice-btn ${kindFilter === f.id ? 'active' : ''}`}
              aria-pressed={kindFilter === f.id} onClick={() => onKindFilterChange(f.id)}>{f.label}</button>
          ))}
        </div>
        <input className="settings-field-input settings-field-input--sm ext-search" type="search" placeholder="搜索…"
          value={query} onChange={(e) => onQueryChange(e.target.value)} aria-label="搜索扩展" />
      </div>

      {view === 'installed' ? (
        <div className="ext-list ext-list--cards" role="list" aria-label="已安装">
          {loading && installedFiltered.length === 0 ? (
            <div className="ext-empty" role="status">加载中…</div>
          ) : installedFiltered.length === 0 ? (
            <div className="ext-empty" role="status">
              {query || kindFilter !== 'all' ? '没有匹配的扩展' : '还没有安装扩展'}
              {!(query || kindFilter !== 'all') ? <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect" onClick={() => onViewChange('discover')}>去发现</button> : null}
            </div>
          ) : installedFiltered.map((item) => {
            const canUninstall = item.id.startsWith('local-plugin:') || !item.fromSystem;
            const detailOpen = isExpanded('installed', item.id, 'detail');
            const configOpen = isExpanded('installed', item.id, 'config');
            return (
              <div key={item.id} className={`ext-row-block${detailOpen || configOpen ? ' is-expanded' : ''}`} role="listitem">
                <div className="ext-row ext-row--card ext-row--static">
                  <div className="ext-row-main">
                    <div className="ext-row-title-line">
                      <span className="ext-kind-badge">{kindLabel(item.kind)}</span>
                      <span className="ext-row-name">{highlightMatch(item.name)}</span>
                      <span className="ext-source-badge">{item.source === 'official' ? '官方' : item.source === 'community' ? '三方' : '本机'}</span>
                    </div>
                    <div className="ext-row-desc">{highlightMatch(item.description)}</div>
                  </div>
                  <div className="ext-row-actions">
                    <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect" aria-expanded={detailOpen} onClick={() => onToggleExpand('installed', item.id, 'detail')}>{detailOpen ? '收起' : '详情'}</button>
                    <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect" aria-expanded={configOpen} onClick={() => onToggleExpand('installed', item.id, 'config')}>{configOpen ? '收起' : '配置'}</button>
                    {canUninstall ? <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect danger" onClick={() => onRemove(item)}>卸载</button> : null}
                  </div>
                </div>
                {detailOpen ? <ExtensionExpandBody kind={item.kind} item={item} mode="detail" onManage={onManage} onToggleMcpServer={onToggleMcpServer} /> : null}
                {configOpen ? <ExtensionExpandBody kind={item.kind} item={item} mode="config" onManage={onManage} onToggleMcpServer={onToggleMcpServer} /> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="ext-list ext-list--cards" role="list" aria-label="发现">
          {catalogFiltered.length === 0 ? (
            <div className="ext-empty" role="status">没有匹配的扩展</div>
          ) : catalogFiltered.map((entry) => {
            const detailOpen = isExpanded('catalog', entry.id, 'detail');
            return (
              <div key={entry.id} className={`ext-row-block${detailOpen ? ' is-expanded' : ''}`} role="listitem">
                <div className="ext-row ext-row--card ext-row--static">
                  <div className="ext-row-main">
                    <div className="ext-row-title-line">
                      <span className="ext-kind-badge">{kindLabel(entry.kind)}</span>
                      <span className="ext-row-name">{highlightMatch(entry.name)}</span>
                      <span className="ext-source-badge">{entry.source === 'official' ? '官方' : '三方'}</span>
                      {catalogInstalled.has(entry.id) ? <span className="ext-installed-mark">已装</span> : null}
                    </div>
                    <div className="ext-row-desc">{highlightMatch(entry.description)}</div>
                  </div>
                  <div className="ext-row-actions">
                    <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect" aria-expanded={detailOpen} onClick={() => onToggleExpand('catalog', entry.id, 'detail')}>{detailOpen ? '收起' : '详情'}</button>
                    {catalogInstalled.has(entry.id) ? (
                      <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect" onClick={() => onSetViewInstalled({ scope: 'installed', id: entry.id, mode: 'config' })}>去配置</button>
                    ) : (
                      <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect" disabled={busyId === entry.id} onClick={() => onInstall(entry)}>{busyId === entry.id ? '安装中…' : '安装'}</button>
                    )}
                  </div>
                </div>
                {detailOpen ? <ExtensionExpandBody kind={entry.kind} item={entry} mode="detail" onManage={onManage} onToggleMcpServer={onToggleMcpServer} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
});
