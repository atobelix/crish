import React, { useMemo } from 'react';
import styles from './Sidebar.module.css';
import { IconButton } from '../ui';
import { SidebarNav } from './SidebarNav';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';

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
  onOpenExtensions?: () => void;
  onSearchChange?: ((val: string) => void) | undefined;
}

const BRAND_MARK_LINES = [
  'M 100 116 L 30 116',
  'M 100 116 L 170 116',
  'M 100 116 L 60 44',
  'M 100 116 L 140 44',
  'M 100 116 L 82 164',
  'M 100 116 L 118 164',
];

/**
 * 侧栏切换按钮图标：常态清晰显示侧栏折叠/展开图标（AppIcon sidebar-left），隐藏品牌标记保留测试锚点。
 */
export const SidebarToggleIcon: React.FC = React.memo(() => (
  <span className={styles.toggleIconMorph} aria-hidden="true">
    <svg
      className={styles.toggleBrandIcon}
      viewBox="12 9.5 176 176"
      focusable="false"
      data-testid="toggle-brand-icon"
      style={{ display: 'none' }}
    >
      <ellipse
        className={styles.brandMarkDot}
        cx="100"
        cy="34"
        rx="16"
        ry="16"
      />
      <g className={styles.brandMarkLines}>
        {BRAND_MARK_LINES.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
    <AppIcon
      name="sidebar-left"
      size={18}
      className={styles.toggleActionIcon}
    />
  </span>
));
SidebarToggleIcon.displayName = 'SidebarToggleIcon';

/**
 * 侧栏开关：挂在主布局上，不进宽度为 0 的侧栏盒，因此收起时也不被裁掉。
 */
export const SidebarToggle: React.FC<{
  collapsed: boolean;
  onToggle: () => void;
}> = React.memo(({ collapsed, onToggle }) => {
  const { t } = useI18n();
  const isMacDesktop = useMemo(() => {
    return (
      typeof navigator !== 'undefined' &&
      /Macintosh|Mac OS X/i.test(navigator.userAgent)
    );
  }, []);
  const toggleLabel = collapsed
    ? t('sidebar.expandSidebar', '展开侧栏')
    : t('sidebar.collapseSidebar', '收起侧栏');
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
        icon={<SidebarToggleIcon />}
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
    onOpenExtensions,
    onSearchChange,
  }) => {
    const { t } = useI18n();
    const toggleLabel = collapsed
      ? t('sidebar.expandSidebar', '展开侧栏')
      : t('sidebar.collapseSidebar', '收起侧栏');

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
                icon={<SidebarToggleIcon />}
              />
            )}
            <span
              className={styles.brandName}
              data-testid="sidebar-brand-title"
              data-tauri-drag-region
            >
              Crish
            </span>
          </div>
          <div
            className={styles.sidebarHeaderRight}
            data-testid="sidebar-header-extra"
            data-tauri-drag-region
          />
        </header>

        {sidebarBehavior === 'overlay' && (
          <IconButton
            variant="secondary"
            size="md"
            active={isOverlayActive}
            className={styles.hamburger}
            aria-label={
              isOverlayActive
                ? t('sidebar.closeMenu', '关闭侧栏菜单')
                : t('sidebar.openMenu', '打开侧栏菜单')
            }
            aria-expanded={isOverlayActive}
            onClick={onHamburgerClick}
            icon={<AppIcon name="menu" size={18} aria-hidden />}
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
            ? `${t('common.filter', '筛选')}：${filterLabel}`
            : null}
        </div>

        <div
          className={styles.sidebarTop}
          aria-hidden={chromeHidden || undefined}
          inert={chromeHidden ? true : undefined}
          role="group"
          aria-label={t(
            'sidebar.quickActions',
            '侧栏快捷操作：新建对话与定时任务'
          )}
        >
          <SidebarNav
            activeNav={activeNav}
            onNewSession={onNewSession}
            onOpenScheduled={onOpenScheduled}
            onOpenExtensions={onOpenExtensions}
            searchInput={searchInput}
            onSearchChange={onSearchChange}
          />
        </div>
      </>
    );
  }
);

SidebarHeader.displayName = 'SidebarHeader';
