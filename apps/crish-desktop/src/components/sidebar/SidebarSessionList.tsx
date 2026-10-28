import React, { memo } from 'react';
import styles from './SidebarSessionList.module.css';
import { NowTickContext } from './session-list/SessionRow';
import { PinnedSection } from './session-list/PinnedSection';
import { ProjectsSection } from './session-list/ProjectsSection';
import { GeneralSection } from './session-list/GeneralSection';
import { useSidebarSessionList } from './session-list/useSidebarSessionList';
import { resolveActualScrollHost } from './sidebarWindowing';
import type {
  SidebarDragItem,
  SidebarSessionListProps as BaseSidebarSessionListProps,
} from './session-list/sessionListTypes';

export interface SidebarSessionListProps extends BaseSidebarSessionListProps {
  scrollHostRef?: React.RefObject<HTMLElement | null>;
}

export type { SidebarDragItem };

/**
 * 会话列表：置顶区 + 项目分组 + 常规对话，含 session 拖拽 UI。
 * 瘦身组装层（<=300行）。
 *
 * Stage 06 单轨收敛：彻底切除原型属性劫持补丁，
 * 端到端直连外层真实滚动宿主 .sidebarScroll（[data-sidebar-scroll-host="true"]）。
 */
const SidebarSessionListInner: React.FC<SidebarSessionListProps> = (props) => {
  const {
    scrollHostRef,
    sortType,
    groupType,
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
    sortDropdownOpen = false,
    onMoveSessionRealtime,
  } = props;

  const fallbackScrollHostRef = React.useRef<HTMLElement | null>(null);
  const effectiveScrollHostRef = scrollHostRef ?? fallbackScrollHostRef;

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
    showProjectsSection,
    nowTick,
    renderSessionItem,
    listClassName,
  } = useSidebarSessionList({
    ...props,
    scrollHostRef: effectiveScrollHostRef,
  });

  const handleContainerRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      (
        sessionListRef as React.MutableRefObject<HTMLDivElement | null>
      ).current = node;
      if (!scrollHostRef) {
        fallbackScrollHostRef.current = node
          ? resolveActualScrollHost(null, node)
          : null;
      }
      // 保持原生 DOM 节点纯净与 V8 Inline Cache 高速通道
    },
    [sessionListRef, scrollHostRef]
  );

  return (
    <NowTickContext.Provider value={nowTick}>
      <div
        ref={handleContainerRef}
        className={`${styles.listScroll}${listClassName ? ` ${listClassName}` : ''}`}
        data-shell-hidden={shellHiddenCount}
        data-session-input={inputListedCount}
        data-session-visible={visibleSessions.length}
        data-session-sorted={sortedSessions.length}
        data-sort-type={sortType}
        data-group-type={groupType}
        data-filter-type={filterType}
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
            <div style={{ fontWeight: 500 }}>无匹配会话</div>
          </div>
        ) : null}
        {isAllEmpty ? (
          <div
            className={styles.emptyHint}
            role="status"
            data-empty="all"
            style={{ padding: '16px 12px', textAlign: 'center' }}
          >
            <div style={{ fontWeight: 500 }}>暂无会话</div>
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
            onSortBtnClick={onSortBtnClick}
            sortTriggerRef={
              filterType === 'pinned' ? sortTriggerRef : undefined
            }
            sortDropdownOpen={sortDropdownOpen}
            onMoveSessionRealtime={onMoveSessionRealtime}
            renderSessionItem={renderSessionItem}
          />
        ) : null}

        {!isSearchEmpty && !isAllEmpty && showProjectsSection ? (
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
              onSortBtnClick,
              sortTriggerRef:
                groupType === 'folder' && filterType !== 'pinned'
                  ? sortTriggerRef
                  : undefined,
              sortDropdownOpen,
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
            groupType={groupType}
            onToggleGeneral={onToggleGeneral}
            onSortBtnClick={onSortBtnClick}
            sortTriggerRef={
              groupType === 'none' && filterType !== 'pinned'
                ? sortTriggerRef
                : undefined
            }
            sortDropdownOpen={sortDropdownOpen}
            onMoveSessionRealtime={onMoveSessionRealtime}
            renderSessionItem={renderSessionItem}
          />
        ) : null}
      </div>
    </NowTickContext.Provider>
  );
};

export const SidebarSessionList = memo(SidebarSessionListInner);
