/**
 * 侧栏「设置」快捷菜单：主题 + 常用入口；不进全屏设置。
 * 菜单 fixed 定位，避免挡住聊天气泡 / 被裁切。
 *
 * 键盘：↑↓ / Home / End 漫游；Esc / Tab 关闭并还原焦点到触发钮。
 * 主题段用 menuitemradio；入口项 SettingsTabType 字面量，避免 string 漂移。
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import type { SettingsTabType } from '../store/types';
import { readStoredTheme, setTheme, type UiTheme } from '../api/themeStore';
import styles from './SettingsQuickMenu.module.css';
import { Tooltip } from './settings/SettingsUI';

interface Props {
  onShowToast?: (msg: string) => void;
}

/** 可聚焦控件：主题 radio + 菜单项（不含禁用） */
const FOCUSABLE_SEL =
  'button.ui-segment-item:not(:disabled), button.sb-quick-item:not(:disabled):not([aria-disabled="true"])';

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
    icon: <Lucide.Orbit size={16} strokeWidth={1.75} aria-hidden />,
    tab: 'models',
  },
  {
    id: 'appearance',
    label: '外观与字体',
    title: '打开外观与字体设置',
    ariaLabel: '打开外观与字体设置',
    icon: <Lucide.Palette size={16} strokeWidth={1.75} aria-hidden />,
    tab: 'appearance',
  },
  {
    id: 'all',
    label: '全部设置',
    title: '打开全部设置',
    ariaLabel: '打开全部设置',
    icon: <Lucide.Settings size={16} strokeWidth={1.75} aria-hidden />,
    // 无 tab：进入设置默认页
  },
] as const;

export const SettingsQuickMenu: React.FC<Props> = ({ onShowToast }) => {
  const [open, setOpen] = useState(false);
  const [theme, setThemeLocal] = useState<UiTheme>(() => readStoredTheme());
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(
    null,
  );
  const openSettings = useLayoutStore((s) => s.openSettings);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Escape / Tab / 键盘激活关闭时还原触发钮焦点；外侧点击不抢焦点 */
  const restoreOnCloseRef = useRef(false);
  const menuId = useId();
  const themeGroupId = useId();

  const closeMenu = useCallback((opts?: { restoreFocus?: boolean }) => {
    const restore = !!opts?.restoreFocus;
    restoreOnCloseRef.current = restore;
    setOpen(false);
    if (restore) {
      queueMicrotask(() => {
        btnRef.current?.focus();
        restoreOnCloseRef.current = false;
      });
    }
  }, []);

  const repositionMenu = useCallback(() => {
    if (!open || !btnRef.current) {
      setMenuPos(null);
      return;
    }
    const r = btnRef.current.getBoundingClientRect();
    // 略加宽：中文标签 + 图标更稳，仍贴侧栏宽度
    const width = Math.min(280, Math.max(228, r.width + 8));
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    const bottom = window.innerHeight - r.top + 6;
    setMenuPos({ left, bottom, width });
  }, [open]);

  useLayoutEffect(() => {
    repositionMenu();
  }, [open, repositionMenu]);

  useEffect(() => {
    if (!open) return;
    restoreOnCloseRef.current = false;

    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        // 鼠标点外侧：关闭且不抢焦点
        restoreOnCloseRef.current = false;
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      restoreOnCloseRef.current = true;
      setOpen(false);
      queueMicrotask(() => {
        btnRef.current?.focus();
        restoreOnCloseRef.current = false;
      });
    };
    const onViewport = () => {
      // 滚动会错位 fixed 菜单：关闭不抢焦点 (resize 走 repositionMenu 贴合不关闭)
      restoreOnCloseRef.current = false;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', repositionMenu);
    window.addEventListener('crish-sidebar-resize', repositionMenu);
    // capture：侧栏内部滚动也关掉，避免菜单悬空
    window.addEventListener('scroll', onViewport, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', repositionMenu);
      window.removeEventListener('crish-sidebar-resize', repositionMenu);
      window.removeEventListener('scroll', onViewport, true);
      if (restoreOnCloseRef.current) {
        btnRef.current?.focus();
        restoreOnCloseRef.current = false;
      }
    };
  }, [open]);

  // 打开后聚焦首个可操作控件，便于键盘立即操作
  useEffect(() => {
    if (!open || !menuPos) return;
    const t = window.requestAnimationFrame(() => {
      const first = listFocusable(menuRef.current)[0];
      first?.focus();
    });
    return () => window.cancelAnimationFrame(t);
  }, [open, menuPos]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = listFocusable(menuRef.current);
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const safeIdx = idx >= 0 ? idx : 0;

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      items[(safeIdx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      items[(safeIdx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      // 离开菜单：关闭并还原触发钮，避免焦点逃到背后
      e.preventDefault();
      closeMenu({ restoreFocus: true });
    }
  };

  const applyTheme = (t: UiTheme) => {
    setTheme(t);
    setThemeLocal(t);
  };

  const go = (tab?: SettingsTabType) => {
    closeMenu({ restoreFocus: true });
    openSettings(tab);
  };

  const triggerLabel = open ? '关闭快捷设置菜单' : '打开快捷设置菜单';
  void onShowToast;
  const isDark = theme === 'dark';

  return (
    <div className={styles.sbQuickWrap} ref={rootRef} data-density="compact">
      <Tooltip content="快捷设置">
        <button
          ref={btnRef}
          type="button"
          className={`${styles.sidebarFooterSettings}${open ? ` ${styles.isOpen}` : ''}`}
          data-testid="settings-button"
          aria-label={triggerLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            if (open) {
              // 再次点击触发钮关闭：焦点已在钮上，无需再 restore
              restoreOnCloseRef.current = false;
              setOpen(false);
            } else {
              setOpen(true);
            }
          }}
        >
          <Lucide.Settings size={16} strokeWidth={1.75} aria-hidden />
          <span>设置</span>
          <Lucide.ChevronUp size={14} strokeWidth={1.75} className={styles.sbQuickChev} aria-hidden />
        </button>
      </Tooltip>

      {open && menuPos && (
        <div
          id={menuId}
          ref={menuRef}
          className={`${styles.sbQuickMenu} sb-quick-menu`}
          role="menu"
          aria-label="快捷设置"
          aria-orientation="vertical"
          data-density="compact"
          style={{
            left: menuPos.left,
            bottom: menuPos.bottom,
            width: Math.max(menuPos.width, 240),
          }}
          onKeyDown={onMenuKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className={styles.sbQuickSection} role="none">
            <div className={styles.sbQuickLabel} id={themeGroupId}>
              外观
            </div>
            <div
              className={`ui-segment ui-segment--inline ${styles.sbQuickSegment} sb-quick-segment`}
              role="group"
              aria-labelledby={themeGroupId}
            >
              <Tooltip content="浅色主题">
                <button
                  type="button"
                  className={`ui-segment-item${isDark ? '' : ' active'}`}
                  role="menuitemradio"
                  aria-checked={!isDark}
                  tabIndex={-1}
                  aria-label="浅色主题"
                  onClick={() => applyTheme('default')}
                >
                  浅色
                </button>
              </Tooltip>
              <Tooltip content="深色主题">
                <button
                  type="button"
                  className={`ui-segment-item${isDark ? ' active' : ''}`}
                  role="menuitemradio"
                  aria-checked={isDark}
                  tabIndex={-1}
                  aria-label="深色主题"
                  onClick={() => applyTheme('dark')}
                >
                  深色
                </button>
              </Tooltip>
            </div>
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
      )}
    </div>
  );
};
