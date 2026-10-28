import React, {
  useMemo,
  useState,
  useRef,
  useCallback,
  useEffect,
} from 'react';
import styles from './Sidebar.module.css';
import { IconButton } from '@/components/ui';
import { SidebarNav } from './SidebarNav';
import { AppIcon } from '@/components/ui/icons';
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

// 模块级持久状态：跨组件挂载与重新渲染保持连续，杜绝状态切换误判重播
let globalIsInZone = false;
let globalLastClickTimestamp = 0;

export function recordSidebarToggleClick() {
  globalLastClickTimestamp = Date.now();
}

export function resetSidebarMorphState() {
  globalIsInZone = false;
  globalLastClickTimestamp = 0;
}

/**
 * 侧栏图标动效控制 Hook：
 * 判定区域覆盖除主内容区外的全部非工作区（顶部区域 + 侧边栏区域）。
 * 当鼠标移入顶部或侧栏区域时，即刻利索触发图标变形动效（软件图标 -> 侧栏图标 -> 自动回到软件图标）；
 * 在顶部或侧栏停留期间静止展示软件图标，移回主区域后重置就绪，下次再进入时可再次播放。
 * 针对点击操作设置防抖抑制，防止来回点击时产生误判闪烁。
 */
export function useSidebarIconMorph(
  collapsed: boolean = false,
  isButtonHovered: boolean = false
) {
  const [isMorphing, setIsMorphing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerMorph = useCallback(() => {
    // 鼠标在按钮上，或点击发生后的 800ms 内坚决不触发提示动效（避免点击操作被误判为划入闪烁）
    if (isButtonHovered || Date.now() - globalLastClickTimestamp < 800) {
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    setIsMorphing(true);
    timerRef.current = setTimeout(() => {
      setIsMorphing(false);
      timerRef.current = null;
    }, 700);
  }, [isButtonHovered]);

  const handleAnimationEnd = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsMorphing(false);
  }, []);

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent | MouseEvent) => {
      // 若鼠标正直接悬停在按钮实体上（X: 0~48, Y: 0~38），由 CSS/state 恒定呈现侧栏图标，不触发 JS 动画
      if (e.clientX <= 48 && e.clientY <= 38) {
        globalIsInZone = true;
        return;
      }

      // 触发区判定（顶部区域 38px 或 侧边栏区域：折叠 52px / 展开 260px）
      const leftBoundary = collapsed ? 52 : 260;
      const isOverTriggerZone = e.clientY <= 38 || e.clientX <= leftBoundary;

      // 深度主区域退出判定（迟滞缓冲区：必须明显离开顶栏 > 65px 且离开侧栏 > leftBoundary + 30px）
      const isDeepInMainZone = e.clientY > 65 && e.clientX > leftBoundary + 30;

      if (isOverTriggerZone) {
        if (!globalIsInZone) {
          globalIsInZone = true;
          triggerMorph();
        }
      } else if (isDeepInMainZone) {
        // 彻底离开功能区深入主工作区后才重置标志，杜绝在功能按钮边缘滑动时的反复重计数
        globalIsInZone = false;
      }
    };

    window.addEventListener('pointermove', handlePointerMove, {
      passive: true,
    });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setIsMorphing(false);
    };
  }, [collapsed, triggerMorph]);

  return {
    isMorphing,
    triggerMorph,
    handleAnimationEnd,
  };
}

/**
 * 侧栏切换按钮图标：
 * 常态显示软件品牌图标，hover 时流体形变为侧边栏操作图标，并在停留展示后平滑复原为软件品牌图标。
 */
export const SidebarToggleIcon: React.FC<{
  isMorphing?: boolean;
  onAnimationEnd?: () => void;
}> = React.memo(({ isMorphing = false, onAnimationEnd }) => (
  <span
    className={styles.toggleIconMorph}
    data-morphing={isMorphing ? 'true' : 'false'}
    aria-hidden="true"
    onAnimationEnd={onAnimationEnd}
  >
    <svg
      className={styles.toggleBrandIcon}
      viewBox="12 9.5 176 176"
      focusable="false"
      data-testid="toggle-brand-icon"
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
      size={16}
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
  const [isBtnHovered, setIsBtnHovered] = useState(false);
  const isMacDesktop = useMemo(() => {
    return (
      typeof navigator !== 'undefined' &&
      /Macintosh|Mac OS X/i.test(navigator.userAgent)
    );
  }, []);
  const toggleLabel = collapsed
    ? t('sidebar.expandSidebar', '展开侧栏')
    : t('sidebar.collapseSidebar', '收起侧栏');

  const { isMorphing, triggerMorph, handleAnimationEnd } = useSidebarIconMorph(
    collapsed,
    isBtnHovered
  );

  const handleClick = useCallback(() => {
    recordSidebarToggleClick();
    onToggle();
  }, [onToggle]);

  const handlePointerEnter = useCallback(() => {
    setIsBtnHovered(true);
  }, []);

  const handlePointerLeave = useCallback(() => {
    setIsBtnHovered(false);
  }, []);

  const handleHeaderMouseEnter = useCallback(() => {
    if (!isBtnHovered) {
      triggerMorph();
    }
  }, [isBtnHovered, triggerMorph]);

  return (
    <div
      className={`${styles.sidebarHeader} sidebar-header`}
      data-mac={isMacDesktop ? 'true' : 'false'}
      data-tauri-drag-region="false"
      onMouseEnter={handleHeaderMouseEnter}
    >
      <IconButton
        size="md"
        variant="ghost"
        tooltip={toggleLabel}
        aria-label={toggleLabel}
        aria-expanded={!collapsed}
        aria-controls="crish-sidebar"
        data-testid="sidebar-toggle"
        data-tauri-drag-region="false"
        data-hovered={isBtnHovered ? 'true' : 'false'}
        className="sidebar-toggle-btn"
        onClick={handleClick}
        onMouseEnter={handlePointerEnter}
        onMouseLeave={handlePointerLeave}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        icon={
          <SidebarToggleIcon
            isMorphing={isMorphing && !isBtnHovered}
            onAnimationEnd={handleAnimationEnd}
          />
        }
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

    const { isMorphing, triggerMorph, handleAnimationEnd } =
      useSidebarIconMorph(collapsed ?? false);

    return (
      <>
        <header
          className={styles.sidebarHeaderBar}
          role="banner"
          data-tauri-drag-region
          onMouseEnter={triggerMorph}
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
                icon={
                  <SidebarToggleIcon
                    isMorphing={isMorphing}
                    onAnimationEnd={handleAnimationEnd}
                  />
                }
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
          onMouseEnter={triggerMorph}
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
