import React, { useState, useEffect, useRef, useMemo } from 'react';
import styles from './Sidebar.module.css';
import { useLayoutStore } from '../../api/store-access/componentAccess';
import { useSidebarSessions } from '../../api/store-access/componentAccess';
import { getActiveProjectId, listProjects, type ProjectEntry } from '../../api/projectStore';
import { isUpdateAvailable } from '../../api/updateStore';
import { onUiEvent } from '../../api/uiEvents';
import { SidebarSessionList } from './SidebarSessionList';
import { SidebarContextMenus } from './SidebarContextMenus';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { useResponsiveLayout } from '../../hooks/useResponsiveLayout';
import {
  loadSidebarListPrefs,
  loadSidebarSectionsState,
  saveSidebarSectionsState,
  SIDEBAR_LIST_PREFS_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from './sidebarHelpers';
import type { FilterType, GroupType, SortType } from './sidebarHelpers';
import { SidebarHeader } from './SidebarHeader';
import { SidebarFooter } from './SidebarFooter';
import { useSidebarResize } from './useSidebarResize';
import { useSidebarContextMenu } from './useSidebarContextMenu';
import { useSidebarHandlers } from './useSidebarHandlers';

interface SidebarProps {
  onShowToast: ShowToastFn;
  hoverExpanded?: boolean;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  searchQuery?: string;
  searchInput?: string;
  onSearchChange?: (val: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = React.memo(
  ({
    onShowToast,
    hoverExpanded,
    onHoverEnter,
    onHoverLeave,
    searchQuery = '',
    searchInput = '',
    onSearchChange,
  }) => {
    const searchTrimmed = searchQuery.trim();
    const isSearching = searchTrimmed.length > 0;
    const sessions = useSidebarSessions(isSearching);
    const activeSessionId = useLayoutStore((s) => s.activeSessionId);
    const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
    const setSidebarCollapsed = useLayoutStore((s) => s.setSidebarCollapsed);
    const moveSessionRealtime = useLayoutStore((s) => s.moveSessionRealtime);

    const [sectionsState, setSectionsState] = useState(() => loadSidebarSectionsState());
    const pinnedCollapsed = sectionsState.pinned;
    const generalCollapsed = sectionsState.general;
    const projectsSectionCollapsed = sectionsState.projects;
    const collapsedProjects = sectionsState.projectIds;
    const setPinnedCollapsed = React.useCallback((val: React.SetStateAction<boolean>) => {
      setSectionsState((prev) => ({
        ...prev,
        pinned: typeof val === 'function' ? val(prev.pinned) : val,
      }));
    }, []);
    const setGeneralCollapsed = React.useCallback((val: React.SetStateAction<boolean>) => {
      setSectionsState((prev) => ({
        ...prev,
        general: typeof val === 'function' ? val(prev.general) : val,
      }));
    }, []);
    const setProjectsSectionCollapsed = React.useCallback((val: React.SetStateAction<boolean>) => {
      setSectionsState((prev) => ({
        ...prev,
        projects: typeof val === 'function' ? val(prev.projects) : val,
      }));
    }, []);
    const setCollapsedProjects = React.useCallback(
      (val: React.SetStateAction<Record<string, boolean>>) => {
        setSectionsState((prev) => ({
          ...prev,
          projectIds: typeof val === 'function' ? val(prev.projectIds) : val,
        }));
      },
      []
    );
    const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
    const [sortDropdownCoords, setSortDropdownCoords] = useState<{ x: number; y: number } | null>(null);
    const [listPrefs, setListPrefs] = useState<{
      sortType: SortType;
      groupType: GroupType;
      filterType: FilterType;
    }>(() => {
      const prefs = loadSidebarListPrefs();
      return { sortType: prefs.sortType, groupType: prefs.groupType, filterType: prefs.filterType };
    });
    const sortType = listPrefs.sortType;
    const groupType = listPrefs.groupType;
    const filterType = listPrefs.filterType;
    const setSortType = React.useCallback((val: React.SetStateAction<SortType>) => {
      setListPrefs((prev) => ({ ...prev, sortType: typeof val === 'function' ? val(prev.sortType) : val }));
    }, []);
    const setGroupType = React.useCallback((val: React.SetStateAction<GroupType>) => {
      setListPrefs((prev) => ({ ...prev, groupType: typeof val === 'function' ? val(prev.groupType) : val }));
    }, []);
    const setFilterType = React.useCallback((val: React.SetStateAction<FilterType>) => {
      setListPrefs((prev) => ({ ...prev, filterType: typeof val === 'function' ? val(prev.filterType) : val }));
    }, []);
    const [projects, setProjects] = useState<ProjectEntry[]>(() => listProjects());
    const [, setActiveProjectId] = useState<string | null>(() => getActiveProjectId());
    const [updateAvailable, setUpdateAvailableState] = useState(() => isUpdateAvailable());

    const sidebarRef = useRef<HTMLDivElement>(null);

    const { sidebarWidthPx, handleSidebarResizeStart, handleSidebarResizeKeyDown } = useSidebarResize();

    const {
      contextMenu,
      setContextMenu,
      renamingSessionId,
      setRenamingSessionId,
      menuRef,
      sortMenuRef,
      handleContextMenu,
      handleAction,
    } = useSidebarContextMenu({ onShowToast, setSortDropdownOpen });

    const { sidebarBehavior } = useResponsiveLayout();
    const [overlayOpen, setOverlayOpen] = useState(false);

    const {
      activeNav,
      handleNewSession,
      handleCommitRename,
      handleOpenScheduled,
      handleSelectSession,
      handleOpenProject,
      handleToggleProjectCollapsed,
      handleToggleGeneral,
      handleTogglePinned,
      handleToggleProjectsSection,
      handleAddProject,
      handleStartRename,
      handleCancelRename,
      handleSortBtnClick,
      handleOverlayClose,
      handleHamburgerClick,
    } = useSidebarHandlers({
      filterType,
      setFilterType,
      setRenamingSessionId,
      setGeneralCollapsed,
      setPinnedCollapsed,
      setProjectsSectionCollapsed,
      setCollapsedProjects,
      setActiveProjectId,
      setSortDropdownCoords,
      setSortDropdownOpen,
      setOverlayOpen,
      sidebarBehavior,
      sidebarCollapsed,
      setSidebarCollapsed,
    });

    useEffect(() => {
      try {
        const prefs = { sortType, groupType, filterType };
        localStorage.setItem(SIDEBAR_LIST_PREFS_KEY, JSON.stringify(prefs));
      } catch {
        /* ignore */
      }
    }, [sortType, groupType, filterType]);

    useEffect(() => {
      saveSidebarSectionsState(sectionsState);
    }, [sectionsState]);

    useEffect(() => {
      if (filterType === 'pinned') setPinnedCollapsed(false);
    }, [filterType, setPinnedCollapsed]);

    useEffect(() => {
      return onUiEvent('project-changed', () => {
        setProjects(listProjects());
        setActiveProjectId(getActiveProjectId());
      });
    }, []);

    useEffect(() => {
      return onUiEvent('update-changed', () => {
        setUpdateAvailableState(isUpdateAvailable());
      });
    }, []);

    const chromeHidden = Boolean(sidebarCollapsed && !hoverExpanded);

    const searchStatusText = useMemo(() => {
      if (!isSearching) return '';
      const q = searchTrimmed.length > 24 ? `${searchTrimmed.slice(0, 24)}…` : searchTrimmed;
      return `正在筛选会话：${q}`;
    }, [isSearching, searchTrimmed]);

    const filterLabel = filterType === 'pinned' ? '仅置顶' : '全部会话';
    const densityHint = isSearching ? 'search' : filterType === 'pinned' ? 'pinned' : 'default';

    const isOverlayActive = sidebarBehavior === 'overlay' && overlayOpen;

    return (
      <aside
        ref={sidebarRef}
        className={`${styles.sidebar} crish-sidebar ${sidebarCollapsed ? styles.collapsed : ''} ${hoverExpanded ? styles.tempExpanded : ''} ${isOverlayActive ? styles.overlay : ''} ${sidebarBehavior === 'icon-collapse' && !isOverlayActive ? styles.iconCollapse : ''}`}
        role="navigation"
        aria-label="侧栏导航"
        data-testid="sidebar"
        data-sidebar-filter={filterType}
        data-sidebar-density={densityHint}
        data-searching={isSearching ? '1' : '0'}
        data-sidebar-collapsed={sidebarCollapsed ? '1' : '0'}
        data-sidebar-behavior={sidebarBehavior}
        onMouseEnter={onHoverEnter}
        onMouseLeave={onHoverLeave}
      >
        <SidebarHeader
          sidebarBehavior={sidebarBehavior}
          isOverlayActive={isOverlayActive}
          chromeHidden={chromeHidden}
          searchStatusText={searchStatusText}
          filterType={filterType}
          isSearching={isSearching}
          filterLabel={filterLabel}
          activeNav={activeNav}
          searchInput={searchInput}
          onHamburgerClick={handleHamburgerClick}
          onOverlayClose={handleOverlayClose}
          onNewSession={handleNewSession}
          onOpenScheduled={handleOpenScheduled}
          onSearchChange={onSearchChange}
        />

        <div
          className={styles.sidebarScroll}
          data-sidebar-chrome="scroll"
          aria-hidden={chromeHidden || undefined}
          inert={chromeHidden ? true : undefined}
        >
          <SidebarSessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            searchQuery={searchQuery}
            sortType={sortType}
            groupType={groupType}
            filterType={filterType}
            projects={projects}
            collapsedProjects={collapsedProjects}
            generalCollapsed={generalCollapsed}
            pinnedCollapsed={pinnedCollapsed}
            projectsSectionCollapsed={projectsSectionCollapsed}
            renamingSessionId={renamingSessionId}
            onSelectSession={handleSelectSession}
            onContextMenuSession={handleContextMenu}
            onToggleProjectCollapsed={handleToggleProjectCollapsed}
            onToggleGeneral={handleToggleGeneral}
            onTogglePinned={handleTogglePinned}
            onToggleProjectsSection={handleToggleProjectsSection}
            onOpenProject={handleOpenProject}
            onSortBtnClick={handleSortBtnClick}
            onNewSession={handleNewSession}
            onAddProject={handleAddProject}
            onMoveSessionRealtime={moveSessionRealtime}
            onStartRename={handleStartRename}
            onCommitRename={handleCommitRename}
            onCancelRename={handleCancelRename}
          />
        </div>

        <SidebarFooter
          chromeHidden={chromeHidden}
          updateAvailable={updateAvailable}
          onShowToast={onShowToast}
          setUpdateAvailableState={setUpdateAvailableState}
        />

        <div
          className={styles.sidebarResizer}
          id="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          aria-valuenow={sidebarCollapsed ? 0 : sidebarWidthPx}
          aria-valuetext={sidebarCollapsed ? '已收起' : `侧栏宽度 ${sidebarWidthPx} 像素`}
          tabIndex={0}
          onPointerDown={handleSidebarResizeStart}
          onKeyDown={handleSidebarResizeKeyDown}
          style={{ touchAction: 'none' }}
        />

        <SidebarContextMenus
          menuRef={menuRef}
          sortMenuRef={sortMenuRef}
          contextMenu={contextMenu}
          onSessionAction={handleAction}
          sortDropdownOpen={sortDropdownOpen}
          sortDropdownCoords={sortDropdownCoords}
          sortType={sortType}
          groupType={groupType}
          filterType={filterType}
          onSetSortType={setSortType}
          onSetGroupType={setGroupType}
          onSetFilterType={setFilterType}
          onCloseSortDropdown={() => setSortDropdownOpen(false)}
          onCloseContextMenu={() => setContextMenu(null)}
        />
      </aside>
    );
  }
);

Sidebar.displayName = 'Sidebar';
