import React, { useMemo } from 'react';
import styles from './Sidebar.module.css';
import { Menu } from 'lucide-react';
import { IconButton } from '../ui';
import { IconSidebarLeft } from './SidebarToggleIcons';
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
  searchInput?: string | undefined;
  collapsed?: boolean;
  onToggle?: () => void;
  onHamburgerClick: () => void;
  onOverlayClose: () => void;
  onNewSession: () => void;
  onOpenScheduled: () => void;
  onSearchChange?: ((val: string) => void) | undefined;
}

/**
 * 侧栏开关：挂在主布局上，不进宽度为 0 的侧栏盒，因此收起时也不被裁掉。
 */
export const SidebarToggle: React.FC<{
  collapsed: boolean;
  onToggle: () => void;
}> = React.memo(({ collapsed, onToggle }) => {
  const isMacDesktop = useMemo(() => {
    return (
      typeof navigator !== 'undefined' &&
      /Macintosh|Mac OS X/i.test(navigator.userAgent)
    );
  }, []);
  const toggleLabel = collapsed ? '展开侧栏' : '收起侧栏';
  return (
    <div
      className={`${styles.sidebarHeader} sidebar-header`}
      data-mac={isMacDesktop ? 'true' : 'false'}
    >
      <IconButton
        size="md"
        variant="ghost"
        tooltip={toggleLabel}
        aria-label={toggleLabel}
        aria-expanded={!collapsed}
        aria-controls="crish-sidebar"
        data-testid="sidebar-toggle"
        className="sidebar-toggle-btn"
        onClick={onToggle}
        icon={<IconSidebarLeft size={16} aria-hidden="true" />}
      />
    </div>
  );
});
SidebarToggle.displayName = 'SidebarToggle';

/**
 * 侧栏头：整行 Header 语义化容器，左侧折叠开关，右侧预留扩展区域，紧随其后为快捷操作与搜索。
 */
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
    collapsed,
    onToggle,
    onHamburgerClick,
    onOverlayClose,
    onNewSession,
    onOpenScheduled,
    onSearchChange,
  }) => {
    const toggleLabel = collapsed ? '展开侧栏' : '收起侧栏';

    return (
      <>
        <header
          className={styles.sidebarHeaderBar}
          role="banner"
          data-tauri-drag-region
        >
          <div
            className={styles.sidebarHeaderLeft}
            data-tauri-drag-region="false"
          >
            {onToggle && (
              <IconButton
                size="md"
                variant="ghost"
                tooltip={toggleLabel}
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                aria-controls="crish-sidebar"
                data-testid="sidebar-header-toggle"
                className="sidebar-toggle-btn"
                data-tauri-drag-region="false"
                onClick={onToggle}
                icon={<IconSidebarLeft size={16} aria-hidden="true" />}
              />
            )}
          </div>
          <div
            className={styles.sidebarHeaderRight}
            data-testid="sidebar-header-extra"
            data-tauri-drag-region
          >
            {/* 用户预留扩展区：可在右侧添加其他按钮与信息 */}
          </div>
        </header>

        {sidebarBehavior === 'overlay' && (
          <IconButton
            variant="secondary"
            size="md"
            active={isOverlayActive}
            className={styles.hamburger}
            aria-label={isOverlayActive ? '关闭侧栏菜单' : '打开侧栏菜单'}
            aria-expanded={isOverlayActive}
            onClick={onHamburgerClick}
            icon={<Menu size={18} strokeWidth={1.5} aria-hidden />}
          />
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
