import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import type { SessionState } from '../../store/layoutStore';
import {
  GENERAL_FOLDER,
  openProject,
  type ProjectEntry,
} from '../../api/projectStore';
import {
  formatSessionListTime,
  sessionLastActivityMs,
} from '../../api/sessionTime';
import { sessionListDisplayTitle } from '../../api/sessionTitle';

export type SidebarDragItem =
  | { type: 'session'; sessionId: string; folderName?: string }
  | { type: 'folder'; folderName: string };

export interface SidebarSessionListProps {
  sessions: SessionState[];
  activeSessionId: string;
  activeAgentId: string | null;
  searchQuery: string;
  sortType: 'active' | 'name';
  groupType: 'folder' | 'none';
  filterType: 'all' | 'pinned';
  projects: ProjectEntry[];
  collapsedProjects: Record<string, boolean>;
  generalCollapsed: boolean;
  pinnedCollapsed: boolean;
  projectsSectionCollapsed: boolean;
  onSelectSession: (id: string) => void;
  onSelectAgent: (sessionId: string, agentId: string) => void;
  onOpenAgentPanel: (sessionId: string, agentId: string) => void;
  onContextMenuSession: (e: React.MouseEvent, sessionId: string) => void;
  onContextMenuAgent: (e: React.MouseEvent, sessionId: string, agentId: string) => void;
  onToggleProjectCollapsed: (id: string) => void;
  onToggleGeneral: () => void;
  onTogglePinned: () => void;
  onToggleProjectsSection: () => void;
  onOpenProject: (id: string) => void;
  onSortBtnClick: (e: React.MouseEvent) => void;
  onNewSession: () => void;
  onMoveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean,
  ) => void;
}

/**
 * 会话列表：置顶区 + 项目分组 + 常规对话，含 session 拖拽 UI。
 */
export const SidebarSessionList: React.FC<SidebarSessionListProps> = ({
  sessions,
  activeSessionId,
  activeAgentId,
  searchQuery,
  sortType,
  groupType: _groupType,
  filterType,
  projects,
  collapsedProjects,
  generalCollapsed,
  pinnedCollapsed,
  projectsSectionCollapsed,
  onSelectSession,
  onSelectAgent,
  onOpenAgentPanel,
  onContextMenuSession,
  onContextMenuAgent,
  onToggleProjectCollapsed,
  onToggleGeneral,
  onTogglePinned,
  onToggleProjectsSection,
  onOpenProject,
  onSortBtnClick,
  onNewSession,
  onMoveSessionRealtime,
}) => {
  const [activeDragItem, setActiveDragItem] = useState<SidebarDragItem | null>(null);
  const [dragOverPinned, setDragOverPinned] = useState(false);
  /** 驱动相对时间刷新 */
  const [nowTick, setNowTick] = useState(() => Date.now());

  const pinnedZoneRef = useRef<HTMLDivElement>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  let visibleSessions = sessions.filter((s) => !s.isArchived);
  if (filterType === 'pinned') visibleSessions = visibleSessions.filter((s) => s.isPinned);
  const q = searchQuery.trim().toLowerCase();
  if (q) {
    visibleSessions = visibleSessions.filter(
      (s) =>
        sessionListDisplayTitle(s).toLowerCase().includes(q) ||
        s.title.toLowerCase().includes(q) ||
        s.folder.toLowerCase().includes(q),
    );
  }

  const sortedSessions =
    sortType === 'name'
      ? [...visibleSessions].sort((a, b) =>
          sessionListDisplayTitle(a).localeCompare(sessionListDisplayTitle(b)),
        )
      : [...visibleSessions].sort(
          (a, b) => sessionLastActivityMs(b) - sessionLastActivityMs(a),
        );

  const pinnedSessions = sortedSessions.filter((s) => s.isPinned);
  const unpinned = sortedSessions.filter((s) => !s.isPinned);

  const projectIdSet = new Set(projects.map((p) => p.id));
  const sessionsByProject = (projectId: string) =>
    unpinned.filter((s) => s.folder === projectId || s.folder === projects.find((p) => p.id === projectId)?.name);
  const generalSessions = unpinned.filter(
    (s) =>
      s.folder === GENERAL_FOLDER ||
      s.folder === '会话' ||
      s.folder === '常规会话' ||
      (!projectIdSet.has(s.folder) && !projects.some((p) => p.name === s.folder)),
  );

  const startSessionDrag = useCallback(
    (e: React.PointerEvent, sessionId: string, folderName?: string) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      let dragOverlay: HTMLDivElement | null = null;
      const el = (e.currentTarget as HTMLElement).closest('li') as HTMLElement;
      const elRect = el?.getBoundingClientRect();
      const offsetX = startX - (elRect?.left ?? startX);
      const offsetY = startY - (elRect?.top ?? startY);

      const move = (me: PointerEvent) => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (!dragging && Math.sqrt(dx * dx + dy * dy) > 6) {
          dragging = true;
          setActiveDragItem({ type: 'session', sessionId, folderName });
          if (el) {
            dragOverlay = el.cloneNode(true) as HTMLDivElement;
            dragOverlay.className = 'sidebar-drag-ghost';
            dragOverlay.style.cssText = `position:fixed;width:${elRect?.width ?? 180}px;`;
            document.body.appendChild(dragOverlay);
          }
        }
        if (!dragging || !dragOverlay) return;
        dragOverlay.style.left = `${me.clientX - offsetX}px`;
        dragOverlay.style.top = `${me.clientY - offsetY}px`;
        dragOverlay.style.display = 'none';
        const hoveredEl = document.elementFromPoint(me.clientX, me.clientY);
        dragOverlay.style.display = 'flex';
        if (!hoveredEl) return;
        const pinnedZone = pinnedZoneRef.current;
        const overPinned = pinnedZone
          ? hoveredEl.closest('.pinned-drop-zone') ||
            hoveredEl.closest('.pinned-list') ||
            hoveredEl === pinnedZone
          : false;
        setDragOverPinned(!!overPinned);
        if (overPinned) {
          const targetSessionItem = hoveredEl.closest('li.session-item');
          const targetSessionId = targetSessionItem?.getAttribute('data-session-id') || null;
          onMoveSessionRealtime(sessionId, targetSessionId, folderName || '会话', true);
        } else {
          const targetSessionItem = hoveredEl.closest('li.session-item');
          const targetFolderEl = hoveredEl.closest('[data-folder-name]');
          const targetSessionId = targetSessionItem?.getAttribute('data-session-id') || null;
          const targetFolder =
            targetFolderEl?.getAttribute('data-folder-name') || folderName || '会话';
          onMoveSessionRealtime(sessionId, targetSessionId, targetFolder, false);
        }
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (dragOverlay) dragOverlay.remove();
        setActiveDragItem(null);
        setDragOverPinned(false);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [onMoveSessionRealtime],
  );

  const renderSessionItem = (s: SessionState, isDraggable: boolean = true) => {
    const isBranched = !!s.branchParentId;
    const baseTitle = sessionListDisplayTitle(s);
    const displayText = isBranched ? `分支: ${baseTitle.replace(/ - 分支$/, '')}` : baseTitle;
    const isDraggingThis = activeDragItem?.type === 'session' && activeDragItem.sessionId === s.id;
    const isRunning = s.messages?.some((m) => m.status === 'processing') ?? false;
    const agents = s.agents || [];
    const agentRunning = agents.some((a) => a.status === 'running');
    // 整树仅一行「当前」高亮：主对话激活时不高亮嵌套 agent
    const sessionActive = s.id === activeSessionId && !activeAgentId;
    const timeLabel = formatSessionListTime(s, nowTick);
    return (
      <li
        key={s.id}
        data-session-id={s.id}
        className={`session-item-wrap ${isDraggingThis ? 'drag-ghost-hidden' : ''}`}
      >
        <div
          className={`session-item ${sessionActive ? 'active' : ''} ${isBranched ? 'branch-session' : ''}`}
          onClick={() => onSelectSession(s.id)}
          onContextMenu={(e) => onContextMenuSession(e, s.id)}
          onPointerDown={isDraggable ? (e) => startSessionDrag(e, s.id, s.folder) : undefined}
        >
          <span className="session-text" title={displayText}>
            {displayText}
          </span>
          <span className="session-trailing">
            {isRunning || agentRunning ? (
              <span className="session-running-spinner" title="处理中" />
            ) : (
              <>
                <span className="session-time">{timeLabel}</span>
                <button
                  type="button"
                  className="session-actions-btn"
                  title="更多"
                  onClick={(e) => {
                    e.stopPropagation();
                    onContextMenuSession(e as unknown as React.MouseEvent, s.id);
                  }}
                >
                  <Lucide.MoreHorizontal size={16} />
                </button>
              </>
            )}
          </span>
        </div>
        {agents.length > 0 ? (
          <ul className="session-agent-list" aria-label="协作 agent">
            {agents.slice(0, 12).map((ag) => {
              const agentActive = activeSessionId === s.id && activeAgentId === ag.id;
              return (
                <li key={ag.id}>
                  <button
                    type="button"
                    className={`session-agent-item ${
                      agentActive ? 'active' : ''
                    } session-agent-item--${ag.status}`}
                    title={ag.description}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectAgent(s.id, ag.id);
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      onOpenAgentPanel(s.id, ag.id);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onContextMenuAgent(e, s.id, ag.id);
                    }}
                  >
                    <Lucide.Bot size={14} className="session-agent-icon" />
                    <span className="session-agent-text">
                      {ag.description || ag.mode || 'agent'}
                    </span>
                    {ag.status === 'running' ? (
                      <span className="session-running-spinner" title="运行中" />
                    ) : (
                      <span className="session-agent-status">
                        {ag.status === 'failed' ? '失败' : '完成'}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div ref={sessionListRef} className="sb-list-scroll">
      {/* 1) 置顶 */}
      <section className="sb-section">
        <button
          type="button"
          className="sb-section-label"
          onClick={onTogglePinned}
        >
          <span>置顶</span>
          <Lucide.ChevronDown size={14} className={pinnedCollapsed ? 'chev-collapsed' : ''} />
        </button>
        {!pinnedCollapsed && (
          <div
            ref={pinnedZoneRef}
            className={`pinned-drop-zone ${dragOverPinned ? 'drag-over' : ''}`}
          >
            <ul className="session-list pinned-list">
              {pinnedSessions.map((s) => renderSessionItem(s))}
            </ul>
            {pinnedSessions.length === 0 && (
              <div className="sb-empty-hint subtle">固定的对话会出现在这里</div>
            )}
          </div>
        )}
      </section>

      {/* 2) 项目 */}
      <section className="sb-section">
        <div className="sb-section-label-row">
          <button
            type="button"
            className="sb-section-label"
            onClick={onToggleProjectsSection}
          >
            <span>项目</span>
            <Lucide.ChevronDown
              size={14}
              className={projectsSectionCollapsed ? 'chev-collapsed' : ''}
            />
          </button>
        </div>
        {!projectsSectionCollapsed && (
          <>
            {projects.map((p) => {
              const open = !collapsedProjects[p.id];
              const sess = sessionsByProject(p.id);
              return (
                <div key={p.id} className="folder-group" data-folder-name={p.id}>
                  <button
                    type="button"
                    className="folder-header"
                    onClick={() => {
                      openProject(p.id);
                      onOpenProject(p.id);
                    }}
                    onDoubleClick={() => onToggleProjectCollapsed(p.id)}
                  >
                    <Lucide.Folder size={16} />
                    <span className="folder-name">{p.name}</span>
                    <button
                      type="button"
                      className="folder-new-session"
                      title="在此项目新建对话"
                      onClick={(e) => {
                        e.stopPropagation();
                        openProject(p.id);
                        onOpenProject(p.id);
                        onNewSession();
                      }}
                    >
                      <Lucide.Plus size={14} strokeWidth={2} />
                    </button>
                    <span
                      className="folder-collapse-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleProjectCollapsed(p.id);
                      }}
                    >
                      <Lucide.ChevronDown size={14} className={open ? '' : 'chev-collapsed'} />
                    </span>
                  </button>
                  {open && (
                    <ul className="session-list folder-sessions">
                      {sess.map((s) => renderSessionItem(s, true))}
                    </ul>
                  )}
                </div>
              );
            })}
            {projects.length === 0 && (
              <div className="sb-empty-hint subtle">在对话区选择或添加项目</div>
            )}
          </>
        )}
      </section>

      {/* 3) 对话 */}
      <section className="sb-section">
        <div className="sb-section-label-row">
          <button
            type="button"
            className="sb-section-label"
            onClick={onToggleGeneral}
          >
            <span>对话</span>
            <Lucide.ChevronDown size={14} className={generalCollapsed ? 'chev-collapsed' : ''} />
          </button>
          <button
            type="button"
            className="sb-section-new"
            title="新建对话"
            onClick={(e) => {
              e.stopPropagation();
              onNewSession();
            }}
          >
            <Lucide.Plus size={14} strokeWidth={2} />
          </button>
          <button type="button" className="sort-btn" title="排序" onClick={onSortBtnClick}>
            <Lucide.ArrowUpDown size={14} />
          </button>
        </div>
        {!generalCollapsed && (
          <>
            <ul className="session-list folder-sessions">
              {generalSessions.map((s) => renderSessionItem(s))}
            </ul>
            {generalSessions.length === 0 && (
              <div className="sb-empty-hint subtle">不在项目中时的对话</div>
            )}
          </>
        )}
      </section>
    </div>
  );
};
