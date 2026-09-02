import React, { memo } from 'react';
import styles from './SidebarSessionList.module.css';
import { NowTickContext } from './session-list/SessionRow';
import { PinnedSection } from './session-list/PinnedSection';
import { ProjectsSection } from './session-list/ProjectsSection';
import { GeneralSection } from './session-list/GeneralSection';
import { useSidebarSessionList } from './session-list/useSidebarSessionList';
import type {
  SidebarDragItem,
  SidebarSessionListProps,
} from './session-list/sessionListTypes';

export type { SidebarDragItem, SidebarSessionListProps };

/**
 * 会话列表：置顶区 + 项目分组 + 常规对话，含 session 拖拽 UI。
 * 瘦身组装层（<=300行）。
 */
const SidebarSessionListInner: React.FC<SidebarSessionListProps> = (props) => {
  const {
    filterType,
    projects,
    collapsedProjects,
    generalCollapsed,
    pinnedCollapsed,
    projectsSectionCollapsed,
    onToggleProjectCollapsed,
    onToggleGeneral,
    onTogglePinned,
    onToggleProjectsSection,
    onOpenProject,
    onSortBtnClick,
    sortTriggerRef,
    onMoveSessionRealtime,
  } = props;

  const {
    visibleSessions,
    shellHiddenCount,
    inputListedCount,
    sortedSessions,
    pinnedSessions,
    byProjectId,
    generalSessions,
    generalWindowEnabled,
    generalRenderRange,
    pinnedZoneRef,
    sessionListRef,
    generalListRef,
    dragOverPinned,
    isSearchEmpty,
    isAllEmpty,
    showProjectsAndGeneral,
    nowTick,
    renderSessionItem,
    listClassName,
  } = useSidebarSessionList(props);

  return (
    <NowTickContext.Provider value={nowTick}>
      <div
        ref={sessionListRef}
        className={`${styles.listScroll}${listClassName ? ` ${listClassName}` : ''}`}
        data-shell-hidden={shellHiddenCount}
        data-session-input={inputListedCount}
        data-session-visible={visibleSessions.length}
        data-session-sorted={sortedSessions.length}
        data-general-windowed={
          generalWindowEnabled && generalRenderRange.windowed ? '1' : '0'
        }
        data-general-count={generalSessions.length}
        data-general-window-start={
          generalRenderRange.windowed ? generalRenderRange.start : 0
        }
        data-general-window-end={
          generalRenderRange.windowed
            ? generalRenderRange.end
            : generalSessions.length
        }
      >
        {isSearchEmpty ? (
          <div
            className={styles.emptyHint}
            role="status"
            data-empty="search"
            style={{ padding: '16px 12px', textAlign: 'center' }}
          >
            <div style={{ fontWeight: 500, marginBottom: 4 }}>无匹配会话</div>
            <div className={styles.subtle}>试试其他关键词，或清空搜索</div>
          </div>
        ) : null}
        {isAllEmpty ? (
          <div
            className={styles.emptyHint}
            role="status"
            data-empty="all"
            style={{ padding: '16px 12px', textAlign: 'center' }}
          >
            <div style={{ fontWeight: 500, marginBottom: 4 }}>暂无会话</div>
            <div className={styles.subtle}>点击右上角 + 新建对话</div>
          </div>
        ) : null}

        {!isSearchEmpty && !isAllEmpty ? (
          <PinnedSection
            pinnedSessions={pinnedSessions}
            pinnedCollapsed={pinnedCollapsed}
            pinnedZoneRef={pinnedZoneRef}
            dragOverPinned={dragOverPinned}
            filterType={filterType}
            onTogglePinned={onTogglePinned}
            onMoveSessionRealtime={onMoveSessionRealtime}
            renderSessionItem={renderSessionItem}
          />
        ) : null}

        {!isSearchEmpty && !isAllEmpty && showProjectsAndGeneral ? (
          <ProjectsSection
            data={{
              projects,
              collapsedProjects,
              projectsSectionCollapsed,
              byProjectId,
            }}
            actions={{
              onToggleProjectsSection,
              onToggleProjectCollapsed,
              onOpenProject,
              onMoveSessionRealtime,
              renderSessionItem,
            }}
          />
        ) : null}

        {!isSearchEmpty && !isAllEmpty && showProjectsAndGeneral ? (
          <GeneralSection
            generalSessions={generalSessions}
            generalCollapsed={generalCollapsed}
            generalWindowEnabled={generalWindowEnabled}
            generalRenderRange={generalRenderRange}
            generalListRef={generalListRef}
            onToggleGeneral={onToggleGeneral}
            onSortBtnClick={onSortBtnClick}
            sortTriggerRef={sortTriggerRef}
            onMoveSessionRealtime={onMoveSessionRealtime}
            renderSessionItem={renderSessionItem}
          />
        ) : null}
      </div>
    </NowTickContext.Provider>
  );
};

export const SidebarSessionList = memo(SidebarSessionListInner);
