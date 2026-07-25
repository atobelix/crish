import React, { memo } from 'react';
import { Menu } from 'lucide-react';
import styles from '../Sidebar.module.css';
import { Tooltip } from '../settings/SettingsUI';
import { SidebarNav } from './SidebarNav';
import { SidebarSessionList } from './SidebarSessionList';
import { SidebarFooter } from './SidebarFooter';
import { SidebarContextMenus } from './SidebarContextMenus';
import { useSidebarState } from './hooks/useSidebarState';
import type { ShowToastFn } from '../../hooks/useToastQueue';

interface SidebarProps {
  onShowToast: ShowToastFn;
  hoverExpanded?: boolean;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  searchQuery?: string;
  searchInput?: string;
  onSearchChange?: (val: string) => void;
}

const SidebarInner: React.FC<SidebarProps> = ({
  onShowToast,
  hoverExpanded,
  onHoverEnter,
  onHoverLeave,
  searchQuery = '',
  searchInput = '',
  onSearchChange,
}) => {
  const s = useSidebarState(onShowToast, searchQuery, searchInput, onSearchChange, hoverExpanded, onHoverEnter, onHoverLeave);

  return (
    <>
      {s.sidebarBehavior === 'overlay' && (
        <button
          type="button"
          className={`${styles.hamburger} ${s.isOverlayActive ? styles.hamburgerActive : ''}`}
          aria-label={s.isOverlayActive ? '关闭侧栏菜单' : '打开侧栏菜单'}
          aria-expanded={s.isOverlayActive}
          onClick={s.handleHamburgerClick}
        >
          <Menu size={18} strokeWidth={1.75} aria-hidden />
        </button>
      )}
      {s.isOverlayActive && (
        <div className={styles.overlayBackdrop} aria-hidden="true" onClick={s.handleOverlayClose} />
      )}
      <aside
        ref={s.sidebarRef}
        className={`${styles.sidebar} crish-sidebar ${s.sidebarCollapsed ? styles.collapsed : ''} ${s.hoverExpanded ? styles.tempExpanded : ''} ${s.isOverlayActive ? styles.overlay : ''} ${s.sidebarBehavior === 'icon-collapse' && !s.isOverlayActive ? styles.iconCollapse : ''}`}
        role="navigation"
        aria-label="侧栏导航"
        data-sidebar-filter={s.filterType}
        data-sidebar-density={s.densityHint}
        data-searching={s.isSearching ? '1' : '0'}
        data-sidebar-collapsed={s.sidebarCollapsed ? '1' : '0'}
        data-sidebar-behavior={s.sidebarBehavior}
        onMouseEnter={s.onHoverEnter}
        onMouseLeave={s.onHoverLeave}
      >
        <div role="status" aria-live="polite" aria-atomic="true" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>
          {s.searchStatusText}
          {!s.isSearching && s.filterType === 'pinned' ? `筛选：${s.filterLabel}` : null}
        </div>
        <div className={styles.sidebarTop} aria-hidden={s.chromeHidden || undefined} inert={s.chromeHidden ? true : undefined} role="group" aria-label="侧栏快捷操作：新建对话与定时任务">
          <SidebarNav
            activeNav={s.activeNav}
            onNewSession={s.handleNewSession}
            onOpenScheduled={s.handleOpenScheduled}
            searchInput={s.searchInput}
            onSearchChange={s.onSearchChange}
          />
        </div>
        <div className={styles.sidebarScroll} data-sidebar-chrome="scroll" aria-hidden={s.chromeHidden || undefined} inert={s.chromeHidden ? true : undefined}>
          <SidebarSessionList
            sessions={s.sessions}
            activeSessionId={s.activeSessionId}
            searchQuery={s.searchQuery}
            sortType={s.sortType}
            groupType={s.groupType}
            filterType={s.filterType}
            projects={s.projects}
            collapsedProjects={s.collapsedProjects}
            generalCollapsed={s.generalCollapsed}
            pinnedCollapsed={s.pinnedCollapsed}
            projectsSectionCollapsed={s.projectsSectionCollapsed}
            renamingSessionId={s.renamingSessionId}
            onSelectSession={s.handleSelectSession}
            onContextMenuSession={s.handleContextMenu}
            onToggleProjectCollapsed={s.handleToggleProjectCollapsed}
            onToggleGeneral={s.handleToggleGeneral}
            onTogglePinned={s.handleTogglePinned}
            onToggleProjectsSection={s.handleToggleProjectsSection}
            onOpenProject={s.handleOpenProject}
            onSortBtnClick={s.handleSortBtnClick}
            onNewSession={s.handleNewSession}
            onAddProject={s.handleAddProject}
            onMoveSessionRealtime={s.moveSessionRealtime}
            onStartRename={s.handleStartRename}
            onCommitRename={s.handleCommitRename}
            onCancelRename={s.handleCancelRename}
          />
        </div>
        <div className={styles.sidebarFooter} role="contentinfo" aria-label="侧栏底栏" aria-hidden={s.chromeHidden || undefined} inert={s.chromeHidden ? true : undefined}>
          <SidebarFooter onShowToast={onShowToast} />
        </div>
        <div className={styles.sidebarResizer} id="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="调整侧栏宽度"
          aria-valuemin={220} aria-valuemax={360} aria-valuenow={s.sidebarCollapsed ? 0 : s.sidebarWidthPx}
          aria-valuetext={s.sidebarCollapsed ? '已收起' : `侧栏宽度 ${s.sidebarWidthPx} 像素`}
          tabIndex={0} onPointerDown={s.handleSidebarResizeStart} onKeyDown={s.handleSidebarResizeKeyDown} style={{ touchAction: 'none' }}
        />
        <SidebarContextMenus
          menuRef={s.menuRef} sortMenuRef={s.sortMenuRef} contextMenu={s.contextMenu}
          onSessionAction={s.handleAction} sortDropdownOpen={s.sortDropdownOpen}
          sortDropdownCoords={s.sortDropdownCoords} sortType={s.sortType} groupType={s.groupType}
          filterType={s.filterType} onSetSortType={s.setSortType} onSetGroupType={s.setGroupType}
          onSetFilterType={s.setFilterType} onCloseSortDropdown={() => s.setSortDropdownOpen(false)}
          onCloseContextMenu={() => s.setContextMenu(null)}
        />
      </aside>
    </>
  );
};

export const Sidebar = memo(SidebarInner);
Sidebar.displayName = 'Sidebar';
