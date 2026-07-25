import React from 'react';
import styles from '../Sidebar.module.css';
import { Menu } from 'lucide-react';
import { SidebarNav } from './SidebarNav';

export interface SidebarHeaderProps {
  sidebarBehavior: string;
  isOverlayActive: boolean;
  chromeHidden: boolean;
  searchStatusText: string;
  filterType: string;
  isSearching: boolean;
  filterLabel: string;
  activeNav: string;
  searchInput?: string;
  onHamburgerClick: () => void;
  onOverlayClose: () => void;
  onNewSession: () => void;
  onOpenScheduled: () => void;
  onSearchChange?: (val: string) => void;
}

export const SidebarHeader: React.FC<SidebarHeaderProps> = React.memo(
  ({
    sidebarBehavior,
    isOverlayActive,
    chromeHidden,
    searchStatusText,
    filterType,
    isSearching,
    filterLabel,
    activeNav,
    searchInput,
    onHamburgerClick,
    onOverlayClose,
    onNewSession,
    onOpenScheduled,
    onSearchChange,
  }) => {
    return (
      <>
        {sidebarBehavior === 'overlay' && (
          <button
            type="button"
            className={`${styles.hamburger} ${isOverlayActive ? styles.hamburgerActive : ''}`}
            aria-label={isOverlayActive ? '关闭侧栏菜单' : '打开侧栏菜单'}
            aria-expanded={isOverlayActive}
            onClick={onHamburgerClick}
          >
            <Menu size={18} strokeWidth={1.75} aria-hidden />
          </button>
        )}

        {isOverlayActive && (
          <div
            className={styles.overlayBackdrop}
            aria-hidden="true"
            onClick={onOverlayClose}
          />
        )}

        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: 'hidden',
            clip: 'rect(0, 0, 0, 0)',
            whiteSpace: 'nowrap',
            border: 0,
          }}
        >
          {searchStatusText}
          {!isSearching && filterType === 'pinned'
            ? `筛选：${filterLabel}`
            : null}
        </div>

        <div
          className={styles.sidebarTop}
          aria-hidden={chromeHidden || undefined}
          inert={chromeHidden ? true : undefined}
          role="group"
          aria-label="侧栏快捷操作：新建对话与定时任务"
        >
          <SidebarNav
            activeNav={activeNav}
            onNewSession={onNewSession}
            onOpenScheduled={onOpenScheduled}
            searchInput={searchInput}
            onSearchChange={onSearchChange}
          />
        </div>
      </>
    );
  }
);

SidebarHeader.displayName = 'SidebarHeader';
