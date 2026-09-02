import React, { useMemo } from 'react';
import styles from './Sidebar.module.css';
import { Menu } from 'lucide-react';
import { Button, Tooltip } from '../ui';
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
      <Tooltip content={toggleLabel}>
        <button
          type="button"
          className={`${styles.sidebarToggleBtn} sidebar-toggle-btn`}
          data-testid="sidebar-toggle"
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          aria-controls="crish-sidebar"
          onClick={onToggle}
        >
          <IconSidebarLeft size={16} aria-hidden="true" />
        </button>
      </Tooltip>
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
        <header className={styles.sidebarHeaderBar} role="banner">
          <div className={styles.sidebarHeaderLeft}>
            {onToggle && (
              <Tooltip content={toggleLabel}>
                <button
                  type="button"
                  className={`${styles.sidebarToggleBtn} sidebar-toggle-btn`}
                  data-testid="sidebar-header-toggle"
                  aria-label={toggleLabel}
                  aria-expanded={!collapsed}
                  aria-controls="crish-sidebar"
                  onClick={onToggle}
                >
                  <IconSidebarLeft size={16} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
          </div>
          <div className={styles.sidebarHeaderRight} data-testid="sidebar-header-extra">
            {/* 用户预留扩展区：可在右侧添加其他按钮与信息 */}
          </div>
        </header>

        {sidebarBehavior === 'overlay' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.hamburger} ${isOverlayActive ? styles.hamburgerActive : ''}`}
            aria-label={isOverlayActive ? '关闭侧栏菜单' : '打开侧栏菜单'}
            aria-expanded={isOverlayActive}
            onClick={onHamburgerClick}
            icon={<Menu size={18} strokeWidth={1.75} aria-hidden />}
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
