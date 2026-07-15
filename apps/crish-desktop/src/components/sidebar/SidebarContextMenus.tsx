import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import type { SessionState } from '../../store/layoutStore';

export type SessionContextMenuState = {
  x: number;
  y: number;
  sessionId: string;
};

export type AgentContextMenuState = {
  x: number;
  y: number;
  sessionId: string;
  agentId: string;
};

export interface SidebarContextMenusProps {
  menuRef: React.RefObject<HTMLDivElement | null>;
  sortMenuRef: React.RefObject<HTMLDivElement | null>;
  contextMenu: SessionContextMenuState | null;
  agentMenu: AgentContextMenuState | null;
  sessions: SessionState[];
  onSessionAction: (action: string) => void;
  onOpenAgentMain: (sessionId: string, agentId: string) => void;
  onOpenAgentPanel: (sessionId: string, agentId: string) => void;
  onOpenAgentWindow: (sessionId: string, agentId: string) => void;
  onCopyAgentSummary: (sessionId: string, agentId: string) => void;
  onCloseAgentMenu: () => void;
  sortDropdownOpen: boolean;
  sortDropdownCoords: { x: number; y: number } | null;
  sortType: 'active' | 'name';
  groupType: 'folder' | 'none';
  filterType: 'all' | 'pinned';
  onSetSortType: (v: 'active' | 'name') => void;
  onSetGroupType: (v: 'folder' | 'none') => void;
  onSetFilterType: (v: 'all' | 'pinned') => void;
  onCloseSortDropdown: () => void;
}

type FlyKey = 'sort' | 'group' | 'filter' | null;

/** session / agent 右键菜单 + 排序下拉（固定定位，级联子菜单） */
export const SidebarContextMenus: React.FC<SidebarContextMenusProps> = ({
  menuRef,
  sortMenuRef,
  contextMenu,
  agentMenu,
  sessions,
  onSessionAction,
  onOpenAgentMain,
  onOpenAgentPanel,
  onOpenAgentWindow,
  onCopyAgentSummary,
  onCloseAgentMenu,
  sortDropdownOpen,
  sortDropdownCoords,
  sortType,
  groupType,
  filterType,
  onSetSortType,
  onSetGroupType,
  onSetFilterType,
  onCloseSortDropdown,
}) => {
  const [fly, setFly] = useState<FlyKey>(null);

  return (
    <>
      {agentMenu && (
        <div
          ref={menuRef}
          className="context-menu open"
          style={{ left: agentMenu.x, top: agentMenu.y, position: 'fixed', zIndex: 9999 }}
        >
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              onOpenAgentMain(agentMenu.sessionId, agentMenu.agentId);
              onCloseAgentMenu();
            }}
          >
            <Lucide.MessageSquare size={16} strokeWidth={1.75} />
            <span>在主区打开</span>
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              onOpenAgentPanel(agentMenu.sessionId, agentMenu.agentId);
              onCloseAgentMenu();
            }}
          >
            <Lucide.PanelRight size={16} strokeWidth={1.75} />
            <span>在右侧打开</span>
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              onOpenAgentWindow(agentMenu.sessionId, agentMenu.agentId);
              onCloseAgentMenu();
            }}
          >
            <Lucide.ExternalLink size={16} strokeWidth={1.75} />
            <span>新窗口打开</span>
          </button>
          <div className="context-menu-divider" />
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              onCopyAgentSummary(agentMenu.sessionId, agentMenu.agentId);
              onCloseAgentMenu();
            }}
          >
            <Lucide.Copy size={16} strokeWidth={1.75} />
            <span>复制摘要</span>
          </button>
        </div>
      )}

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu open"
          style={{ left: contextMenu.x, top: contextMenu.y, position: 'fixed' }}
        >
          <button type="button" className="context-menu-item" onClick={() => onSessionAction('open-current')}>
            <Lucide.MessageSquare size={16} strokeWidth={1.75} />
            <span>打开</span>
          </button>
          <button type="button" className="context-menu-item" onClick={() => onSessionAction('open-split')}>
            <Lucide.Columns2 size={16} strokeWidth={1.75} />
            <span>拆分打开</span>
          </button>
          <button type="button" className="context-menu-item" onClick={() => onSessionAction('open-new')}>
            <Lucide.ExternalLink size={16} strokeWidth={1.75} />
            <span>在新窗口打开</span>
          </button>
          <div className="context-menu-divider" />
          {sessions.find((s) => s.id === contextMenu.sessionId)?.isPinned ? (
            <button type="button" className="context-menu-item" onClick={() => onSessionAction('unpin')}>
              <Lucide.PinOff size={16} strokeWidth={1.75} />
              <span>取消固定</span>
            </button>
          ) : (
            <button type="button" className="context-menu-item" onClick={() => onSessionAction('pin')}>
              <Lucide.Pin size={16} strokeWidth={1.75} />
              <span>固定</span>
            </button>
          )}
          <button type="button" className="context-menu-item" onClick={() => onSessionAction('archive')}>
            <Lucide.Archive size={16} strokeWidth={1.75} />
            <span>归档</span>
          </button>
          <button type="button" className="context-menu-item" onClick={() => onSessionAction('branch')}>
            <Lucide.GitBranch size={16} strokeWidth={1.75} />
            <span>分支</span>
          </button>
        </div>
      )}

      {sortDropdownOpen && sortDropdownCoords && (
        <div
          ref={sortMenuRef}
          className="sort-filter-menu open"
          style={{
            position: 'fixed',
            left: sortDropdownCoords.x,
            top: sortDropdownCoords.y,
            zIndex: 100000,
          }}
          onMouseLeave={() => setFly(null)}
        >
          <div className="sort-filter-menu-title">排序与过滤</div>

          <div
            className={`sort-filter-row ${fly === 'sort' ? 'is-open' : ''}`}
            onMouseEnter={() => setFly('sort')}
          >
            <span className="sort-filter-row-label">排序方式</span>
            <Lucide.ChevronRight size={14} strokeWidth={1.75} className="sort-filter-chev" />
            {fly === 'sort' ? (
              <div className="sort-filter-flyout" role="menu">
                <button
                  type="button"
                  className={`sort-filter-option ${sortType === 'active' ? 'is-on' : ''}`}
                  onClick={() => {
                    onSetSortType('active');
                    onCloseSortDropdown();
                  }}
                >
                  <span>按活跃</span>
                  {sortType === 'active' ? (
                    <Lucide.Check size={16} strokeWidth={2} className="sort-filter-check" />
                  ) : null}
                </button>
                <button
                  type="button"
                  className={`sort-filter-option ${sortType === 'name' ? 'is-on' : ''}`}
                  onClick={() => {
                    onSetSortType('name');
                    onCloseSortDropdown();
                  }}
                >
                  <span>按名称</span>
                  {sortType === 'name' ? (
                    <Lucide.Check size={16} strokeWidth={2} className="sort-filter-check" />
                  ) : null}
                </button>
              </div>
            ) : null}
          </div>

          <div
            className={`sort-filter-row ${fly === 'group' ? 'is-open' : ''}`}
            onMouseEnter={() => setFly('group')}
          >
            <span className="sort-filter-row-label">分组方式</span>
            <Lucide.ChevronRight size={14} strokeWidth={1.75} className="sort-filter-chev" />
            {fly === 'group' ? (
              <div className="sort-filter-flyout" role="menu">
                <button
                  type="button"
                  className={`sort-filter-option ${groupType === 'folder' ? 'is-on' : ''}`}
                  onClick={() => {
                    onSetGroupType('folder');
                    onCloseSortDropdown();
                  }}
                >
                  <span>按项目分组</span>
                  {groupType === 'folder' ? (
                    <Lucide.Check size={16} strokeWidth={2} className="sort-filter-check" />
                  ) : null}
                </button>
                <button
                  type="button"
                  className={`sort-filter-option ${groupType === 'none' ? 'is-on' : ''}`}
                  onClick={() => {
                    onSetGroupType('none');
                    onCloseSortDropdown();
                  }}
                >
                  <span>平铺列表</span>
                  {groupType === 'none' ? (
                    <Lucide.Check size={16} strokeWidth={2} className="sort-filter-check" />
                  ) : null}
                </button>
              </div>
            ) : null}
          </div>

          <div
            className={`sort-filter-row ${fly === 'filter' ? 'is-open' : ''}`}
            onMouseEnter={() => setFly('filter')}
          >
            <span className="sort-filter-row-label">列表范围</span>
            <Lucide.ChevronRight size={14} strokeWidth={1.75} className="sort-filter-chev" />
            {fly === 'filter' ? (
              <div className="sort-filter-flyout" role="menu">
                <button
                  type="button"
                  className={`sort-filter-option ${filterType === 'all' ? 'is-on' : ''}`}
                  onClick={() => {
                    onSetFilterType('all');
                    onCloseSortDropdown();
                  }}
                >
                  <span>全部</span>
                  {filterType === 'all' ? (
                    <Lucide.Check size={16} strokeWidth={2} className="sort-filter-check" />
                  ) : null}
                </button>
                <button
                  type="button"
                  className={`sort-filter-option ${filterType === 'pinned' ? 'is-on' : ''}`}
                  onClick={() => {
                    onSetFilterType('pinned');
                    onCloseSortDropdown();
                  }}
                >
                  <span>仅固定</span>
                  {filterType === 'pinned' ? (
                    <Lucide.Check size={16} strokeWidth={2} className="sort-filter-check" />
                  ) : null}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
};
