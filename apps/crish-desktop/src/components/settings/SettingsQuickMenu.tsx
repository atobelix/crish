/**
 * 侧栏「设置」快捷菜单：主题 + 常用入口；不进全屏设置。
 * （T05.3.2 迁移到 ui/Menu 基座：position/portal 由基座 Radix 接管，
 * 保留 roving 键盘增强与「Esc/Tab 关闭并还原焦点」语义。）
 *
 * 键盘：↑↓ / Home / End 漫游（本组件保留）；Esc / Tab 关闭并还原焦点到触发钮。
 * 主题段走 ui/SegmentedControl（轨道 --bg-secondary、滑块 --bg-elevated、7px）。
 * 入口项 SettingsTabType 字面量，避免 string 漂移。
 * 焦点语义：外点关闭不抢焦点（onInteractOutside 置位），
 * Esc/Tab/选中关闭还原焦点（restoreOnCloseRef 置位）。
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { openSettings } from '../../store/settingsUiStore';
import type { SettingsTabType } from '../../store/types';
import { readStoredTheme, setTheme, type UiTheme } from '../../api/themeStore';
import styles from './SettingsQuickMenu.module.css';
import { Menu, SegmentedControl, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';

export interface SettingsQuickMenuProps {
  trigger?: React.ReactNode;
  renderTrigger?: (params: {
    open: boolean;
    triggerProps: {
      ref?: React.RefObject<HTMLButtonElement | null>;
      'aria-haspopup': 'menu';
      'aria-expanded': boolean;
      'aria-controls'?: string;
      onClick?: () => void;
    };
  }) => React.ReactNode;
}

export type Props = SettingsQuickMenuProps;

/** 可聚焦控件：主题 radio + 菜单项（不含禁用） */
const FOCUSABLE_SEL =
  '[role="radio"]:not(:disabled), button.sb-quick-item:not(:disabled):not([aria-disabled="true"])';

const THEME_OPTIONS = [
  { value: 'default', label: '浅色', 'aria-label': '浅色主题' },
  { value: 'dark', label: '深色', 'aria-label': '深色主题' },
] as const;

function listFocusable(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>(FOCUSABLE_SEL));
}

/** 快捷入口：label 中文；tab 仅 SettingsTabType 或 undefined（全部设置） */
type QuickEntry = {
  id: string;
  label: string;
  title: string;
  ariaLabel: string;
  icon: React.ReactNode;
  tab?: SettingsTabType;
};

const QUICK_ENTRIES: readonly QuickEntry[] = [
  {
    id: 'models',
    label: '模型与密钥',
    title: '打开模型与 API 密钥设置',
    ariaLabel: '打开模型与密钥设置',
    icon: <AppIcon name="orbit" size={16} aria-hidden />,
    tab: 'models',
  },
  {
    id: 'appearance',
    label: '外观与字体',
    title: '打开外观与字体设置',
    ariaLabel: '打开外观与字体设置',
    icon: <AppIcon name="palette" size={16} aria-hidden />,
    tab: 'appearance',
  },
  {
    id: 'all',
    label: '全部设置',
    title: '打开全部设置',
    ariaLabel: '打开全部设置',
    icon: <AppIcon name="settings" size={16} aria-hidden />,
    // 无 tab：进入设置默认页
  },
] as const;

export const SettingsQuickMenu: React.FC<SettingsQuickMenuProps> = ({
  trigger,
  renderTrigger,
}) => {
  const [open, setOpen] = useState(false);
  const [theme, setThemeState] = useState<UiTheme>(() => readStoredTheme());
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Escape / Tab / 键盘激活关闭时还原触发钮焦点；外侧点击不抢焦点 */
  const restoreOnCloseRef = useRef(false);
  /** 侧栏尺寸变化时重挂基座锚点（Radix 自动重新定位） */
  const [anchorTick, setAnchorTick] = useState(0);

  // 监听全局主题变更事件，确保分段器高亮与真实生效主题 100% 保持一致
  useEffect(() => {
    const handleThemeChange = (e: Event) => {
      const customEvt = e as CustomEvent<{ theme?: UiTheme }>;
      if (customEvt?.detail?.theme) {
        setThemeState(customEvt.detail.theme);
      } else {
        setThemeState(readStoredTheme());
      }
    };
    window.addEventListener('crish-theme-changed', handleThemeChange);
    return () => {
      window.removeEventListener('crish-theme-changed', handleThemeChange);
    };
  }, []);

  // 当菜单展开时，立即对齐一次当前 DOM 与 Storage 的真实主题
  useEffect(() => {
    if (open) {
      setThemeState(readStoredTheme());
    }
  }, [open]);
  const menuId = useId();
  const themeGroupId = useId();

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      // 按关闭来源决定是否还原焦点（Esc/Tab/选中 → 还原；外点/触发器 → 不抢）
      const shouldRestore = restoreOnCloseRef.current;
      restoreOnCloseRef.current = false;
      if (shouldRestore) {
        queueMicrotask(() => {
          btnRef.current?.focus();
        });
      } else {
        queueMicrotask(() => {
          if (document.activeElement === btnRef.current) {
            btnRef.current?.blur();
          }
        });
      }
    }
    setOpen(nextOpen);
  }, []);

  const closeMenu = useCallback((opts?: { restoreFocus?: boolean }) => {
    restoreOnCloseRef.current = !!opts?.restoreFocus;
    setOpen(false);
  }, []);

  // 侧栏宽度变化：基座浮层需重新锚定（原实现手动 reposition，现改为重挂）
  useEffect(() => {
    if (!open) return;
    const onSidebarResize = () => setAnchorTick((n) => n + 1);
    window.addEventListener('crish-sidebar-resize', onSidebarResize);
    return () =>
      window.removeEventListener('crish-sidebar-resize', onSidebarResize);
  }, [open]);

  // 打开后聚焦首个可操作控件，便于键盘立即操作
  useEffect(() => {
    if (!open) return;
    const t = window.requestAnimationFrame(() => {
      const first = listFocusable(menuRef.current)[0];
      first?.focus();
    });
    return () => window.cancelAnimationFrame(t);
  }, [open, anchorTick]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // 基座会处理 Esc；此处接管以便还原焦点
      e.preventDefault();
      e.stopPropagation();
      closeMenu({ restoreFocus: true });
      return;
    }
    const inThemeSeg = Boolean(
      (e.target as HTMLElement | null)?.closest('[role="radiogroup"]')
    );
    // 主题段左右键交给 SegmentedControl；上下键仍由菜单漫游，捕获阶段拦住以免分段把 ↓ 当成换肤
    if (inThemeSeg && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      return;
    }
    const items = listFocusable(menuRef.current);
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const safeIdx = idx >= 0 ? idx : 0;

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      items[(safeIdx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      items[(safeIdx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      // 离开菜单：关闭并还原触发钮，避免焦点逃到背后
      e.preventDefault();
      e.stopPropagation();
      closeMenu({ restoreFocus: true });
    }
  };

  const applyTheme = (t: UiTheme) => {
    setTheme(t);
    setThemeState(t);
  };

  const go = (tab?: SettingsTabType) => {
    closeMenu({ restoreFocus: true });
    openSettings(tab);
  };

  const triggerLabel = open ? '关闭快捷设置菜单' : '打开快捷设置菜单';
  const isDark = theme === 'dark';

  const triggerProps = {
    ref: btnRef,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
  };

  const defaultTrigger = (
    <Tooltip content="快捷设置" disabled={open}>
      <button
        type="button"
        className={`${styles.sidebarFooterSettings}${open ? ` ${styles.isOpen}` : ''}`}
        data-testid="settings-button"
        aria-label={triggerLabel}
        {...triggerProps}
      >
        <AppIcon name="settings" size={16} aria-hidden />
        <span>设置</span>
        <AppIcon name="chevron-up" size={14}
          className={styles.sbQuickChev}
          aria-hidden />
      </button>
    </Tooltip>
  );

  const finalTrigger = renderTrigger
    ? renderTrigger({ open, triggerProps })
    : (trigger ?? defaultTrigger);

  return (
    <div className={styles.sbQuickWrap} ref={rootRef} data-density="compact">
      <Menu
        key={anchorTick}
        openState={{ open, onOpenChange: handleOpenChange }}
        outsideHandlers={{
          onInteractOutside: () => {
            // 外点关闭：不抢焦点
            restoreOnCloseRef.current = false;
          },
          onCloseAutoFocus: (e: Event) => {
            if (!restoreOnCloseRef.current) {
              e.preventDefault();
            }
          },
        }}
        trigger={finalTrigger}
        position={{ side: 'top', align: 'start', sideOffset: 6 }}
        panel={{ contentClassName: styles.sbQuickMenu }}
      >
        <div
          id={menuId}
          ref={menuRef}
          className="sb-quick-menu"
          role="menu"
          aria-label="快捷设置"
          aria-orientation="vertical"
          data-density="compact"
          onKeyDownCapture={onMenuKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className={styles.sbQuickSection} role="none">
            <div className={styles.sbQuickLabel} id={themeGroupId}>
              外观
            </div>
            <SegmentedControl
              aria-label="外观"
              size="sm"
              block
              className={`${styles.sbQuickSegment} sb-quick-segment`}
              value={isDark ? 'dark' : 'default'}
              options={[...THEME_OPTIONS]}
              onChange={(v) => applyTheme(v === 'dark' ? 'dark' : 'default')}
            />
          </div>

          <div className={styles.sbQuickDivider} role="separator" />

          {QUICK_ENTRIES.map((entry) => (
            <Tooltip key={entry.id} content={entry.title}>
              <button
                type="button"
                className={`${styles.sbQuickItem} sb-quick-item`}
                data-testid={`quick-settings-${entry.id}`}
                role="menuitem"
                tabIndex={-1}
                aria-label={entry.ariaLabel}
                onClick={() => go(entry.tab)}
              >
                {entry.icon}
                <span>{entry.label}</span>
              </button>
            </Tooltip>
          ))}
        </div>
      </Menu>
    </div>
  );
};
