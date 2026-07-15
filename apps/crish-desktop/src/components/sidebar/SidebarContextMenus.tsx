import React from 'react';
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

/** session / agent 右键菜单 + 排序下拉（固定定位） */
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
            <Lucide.MessageSquare size={16} />
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
            <Lucide.PanelRight size={16} />
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
            <Lucide.ExternalLink size={16} />
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
            <Lucide.Copy size={16} />
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
            <Lucide.MessageSquare size={16} />
            <span>打开</span>
          </button>
          <button type="button" className="context-menu-item" onClick={() => onSessionAction('open-split')}>
            <Lucide.Columns size={16} />
            <span>拆分打开</span>
          </button>
          <div className="context-menu-divider" />
          {sessions.find((s) => s.id === contextMenu.sessionId)?.isPinned ? (
            <button type="button" className="context-menu-item" onClick={() => onSessionAction('unpin')}>
              <Lucide.PinOff size={16} />
              <span>取消固定</span>
            </button>
          ) : (
            <button type="button" className="context-menu-item" onClick={() => onSessionAction('pin')}>
              <Lucide.Pin size={16} />
              <span>固定</span>
            </button>
          )}
          <button type="button" className="context-menu-item" onClick={() => onSessionAction('archive')}>
            <Lucide.Archive size={16} />
            <span>归档</span>
          </button>
          <button type="button" className="context-menu-item" onClick={() => onSessionAction('branch')}>
            <Lucide.GitBranch size={16} />
            <span>分支</span>
          </button>
        </div>
      )}

      {sortDropdownOpen && sortDropdownCoords && (
        <div
          ref={sortMenuRef}
          className="sort-dropdown open"
          style={{ position: 'fixed', left: sortDropdownCoords.x, top: sortDropdownCoords.y, zIndex: 9999 }}
        >
          <button
            type="button"
            className={`sort-dropdown-item ${sortType === 'active' ? 'active' : ''}`}
            onClick={() => {
              onSetSortType('active');
              onCloseSortDropdown();
            }}
          >
            按活跃
          </button>
          <button
            type="button"
            className={`sort-dropdown-item ${sortType === 'name' ? 'active' : ''}`}
            onClick={() => {
              onSetSortType('name');
              onCloseSortDropdown();
            }}
          >
            按名称
          </button>
          <div className="context-menu-divider" />
          <button
            type="button"
            className={`sort-dropdown-item ${groupType === 'folder' ? 'active' : ''}`}
            onClick={() => {
              onSetGroupType('folder');
              onCloseSortDropdown();
            }}
          >
            按项目分组
          </button>
          <button
            type="button"
            className={`sort-dropdown-item ${groupType === 'none' ? 'active' : ''}`}
            onClick={() => {
              onSetGroupType('none');
              onCloseSortDropdown();
            }}
          >
            平铺列表
          </button>
          <div className="context-menu-divider" />
          <button
            type="button"
            className={`sort-dropdown-item ${filterType === 'all' ? 'active' : ''}`}
            onClick={() => {
              onSetFilterType('all');
              onCloseSortDropdown();
            }}
          >
            全部
          </button>
          <button
            type="button"
            className={`sort-dropdown-item ${filterType === 'pinned' ? 'active' : ''}`}
            onClick={() => {
              onSetFilterType('pinned');
              onCloseSortDropdown();
            }}
          >
            仅固定
          </button>
        </div>
      )}
    </>
  );
};
