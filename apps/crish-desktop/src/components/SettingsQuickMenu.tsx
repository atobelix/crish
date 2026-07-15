import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import { readStoredTheme, setTheme, type UiTheme } from '../api/themeStore';
import { isUpdateAvailable } from '../api/updateStore';

interface Props {
  onShowToast?: (msg: string) => void;
}

/**
 * 侧栏「设置」快捷菜单：主题 + 入口；不进全屏设置。
 * 菜单 fixed 定位，避免挡住聊天气泡 / 被裁切。
 */
export const SettingsQuickMenu: React.FC<Props> = ({ onShowToast }) => {
  const [open, setOpen] = useState(false);
  const [theme, setThemeLocal] = useState<UiTheme>(() => readStoredTheme());
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(
    null,
  );
  const openSettings = useLayoutStore((s) => s.openSettings);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) {
      setMenuPos(null);
      return;
    }
    const r = btnRef.current.getBoundingClientRect();
    const width = Math.min(260, Math.max(220, r.width));
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    const bottom = window.innerHeight - r.top + 6;
    setMenuPos({ left, bottom, width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const applyTheme = (t: UiTheme) => {
    setTheme(t);
    setThemeLocal(t);
  };

  const go = (tab?: string) => {
    setOpen(false);
    openSettings(tab);
  };

  return (
    <div className="sb-quick-wrap" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={`sidebar-footer-settings ${open ? 'is-open' : ''}`}
        title="快捷设置"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Lucide.Settings size={16} strokeWidth={1.75} />
        <span>设置</span>
        <Lucide.ChevronUp size={14} strokeWidth={1.75} className="sb-quick-chev" />
      </button>

      {open && menuPos && (
        <div
          className="sb-quick-menu"
          role="menu"
          style={{
            left: menuPos.left,
            bottom: menuPos.bottom,
            width: Math.max(menuPos.width, 240),
          }}
        >
          <div className="sb-quick-section">
            <div className="sb-quick-label">外观</div>
            <div className="ui-segment ui-segment--inline sb-quick-segment">
              <button
                type="button"
                className={`ui-segment-item ${theme !== 'dark' ? 'active' : ''}`}
                onClick={() => applyTheme('default')}
              >
                浅色
              </button>
              <button
                type="button"
                className={`ui-segment-item ${theme === 'dark' ? 'active' : ''}`}
                onClick={() => applyTheme('dark')}
              >
                深色
              </button>
            </div>
          </div>

          <div className="sb-quick-divider" />

          <button type="button" className="sb-quick-item" role="menuitem" onClick={() => go('models')}>
            <Lucide.Cpu size={16} strokeWidth={1.75} />
            <span>模型与密钥</span>
          </button>
          <button
            type="button"
            className="sb-quick-item"
            role="menuitem"
            onClick={() => go('appearance')}
          >
            <Lucide.Palette size={16} strokeWidth={1.75} />
            <span>外观与字体</span>
          </button>
          <button type="button" className="sb-quick-item" role="menuitem" onClick={() => go()}>
            <Lucide.Settings size={16} strokeWidth={1.75} />
            <span>全部设置</span>
          </button>

          <div className="sb-quick-divider" />

          <button
            type="button"
            className="sb-quick-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onShowToast?.(
                isUpdateAvailable() ? '正在检查更新…' : '当前已是最新版本',
              );
            }}
          >
            <Lucide.RefreshCw size={16} strokeWidth={1.75} />
            <span>检查更新</span>
          </button>
        </div>
      )}
    </div>
  );
};
